import { JournalReader, type JournalEvent } from '@dsh/agent-manager'

/**
 * What one agent did, counted from its journal. Every number here is a
 * count of recorded events or a difference of recorded timestamps — nothing
 * is inferred from reply text. `undefined` means "the journal has no such
 * event", which a reader must not round to zero or to "passed".
 */
export interface JournalMetrics {
  agentId: string
  /** From `agent.spawned`; absent if the journal has no such event for this agent. */
  spawned?: {
    roleId: string
    roleVersion?: string
    roleHash?: string
    harness: string
    policyApplied?: boolean
    at: number
  }
  /** Epoch ms of the last event for this agent. */
  lastEventAt?: number
  /**
   * Epoch ms the agent's work ended: its last `chat.replied`, or its last
   * event when it never replied (a cut-off turn). Later events — the
   * controller's checks running, the agent being closed — are not its time.
   */
  turnEndedAt?: number
  /** `turnEndedAt - spawned.at`, when both exist. */
  wallMs?: number
  /**
   * Silences the harness gave no account of: no event of any kind — not even
   * an `agent.activity` heartbeat — for longer than the stall threshold, as
   * `{ at, ms }` (epoch ms the silence started). Counted as the environment
   * and excluded from {@link JournalMetrics.effectiveMs}.
   *
   * Exception: a silence inside an open codex `reasoning` span is the model
   * reasoning (codex reports nothing while it does), unless the event that
   * ends it is a provider retry — then the request hung, and it is a stall.
   *
   * Journals written in older records carry no activity events at all; every
   * long silence in them is a stall by this rule, and whether it really was
   * one cannot be told — see {@link JournalMetrics.activityEvents}.
   */
  stalls: Array<{ at: number; ms: number }>
  /** Sum of {@link JournalMetrics.stalls}. */
  stalledMs: number
  /**
   * Long stretches with nothing visible (no message, no tool call) during
   * which the harness said the model was working: heartbeats kept arriving,
   * or a codex reasoning span was open. Part of the effective time — this is
   * the role's own thinking, not the environment.
   */
  thinking: Array<{ at: number; ms: number; evidence: 'heartbeat' | 'reasoning' }>
  /** Sum of {@link JournalMetrics.thinking}. */
  thinkingMs: number
  /** `wallMs - stalledMs`: time the harness was demonstrably doing something. */
  effectiveMs?: number
  /**
   * `agent.activity` events read. Zero means the journal cannot distinguish
   * thinking from stalling, so any stall attribution is unverified.
   */
  activityEvents: number
  /** Model requests the harness reported retrying (`agent.provider_retry`). */
  providerRetries: number
  toolCalls: number
  toolResults: number
  assistantMessages: number
  userMessages: number
  errors: number
  policyViolations: number
  /** The last `verification.completed` for this agent, if the role declared rules and they ran. */
  verification?: {
    totalRules: number
    passed: number
    failed: number
    results: Array<{ type: string; passed: boolean; message?: string }>
  }
  /** `agent.exited` payload, when the process exited during the window. */
  exited?: { exitCode?: number | null; signal?: string | null }
  /** Total events read for this agent. */
  events: number
}

const PAGE = 500

/** Default silence that counts as a stall rather than as work: 5 minutes. */
export const DEFAULT_STALL_THRESHOLD_MS = 300_000

/** Read every event for `agentId` from `journalFile` and count it. */
export async function collectJournalMetrics(
  journalFile: string,
  agentId: string,
  options: { stallThresholdMs?: number } = {},
): Promise<JournalMetrics> {
  const stallThresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS
  const reader = new JournalReader({ file: journalFile, maxPageSize: PAGE })
  const metrics: JournalMetrics = {
    agentId,
    stalls: [],
    stalledMs: 0,
    thinking: [],
    thinkingMs: 0,
    activityEvents: 0,
    providerRetries: 0,
    toolCalls: 0,
    toolResults: 0,
    assistantMessages: 0,
    userMessages: 0,
    errors: 0,
    policyViolations: 0,
    events: 0,
  }
  const events: JournalEvent[] = []
  let after: string | undefined
  for (;;) {
    const page = await reader.readConversation({ agentId, after, limit: PAGE })
    events.push(...page.items)
    if (page.nextCursor === undefined) break
    after = page.nextCursor
  }
  // The agent's time ends with its last reply. What follows — the controller
  // running checks, then closing the agent — is not the agent's, and a slow
  // or frozen check there once read as a 15-minute "stall" of an agent that
  // had long finished. Without any reply (a cut-off turn) the
  // last event is the end.
  let turnEnd = events.length - 1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.kind === 'chat.replied') {
      turnEnd = index
      break
    }
  }
  const silences = new SilenceClassifier(stallThresholdMs)
  events.forEach((event, index) => {
    if (index <= turnEnd) {
      silences.observe(event)
      metrics.turnEndedAt = event.timestamp
    }
    absorb(metrics, event)
  })
  metrics.stalls = silences.stalls
  metrics.stalledMs = sum(silences.stalls)
  metrics.thinking = silences.thinking
  metrics.thinkingMs = sum(silences.thinking)
  if (metrics.spawned !== undefined && metrics.turnEndedAt !== undefined) {
    metrics.wallMs = metrics.turnEndedAt - metrics.spawned.at
    metrics.effectiveMs = metrics.wallMs - metrics.stalledMs
  }
  return metrics
}

function absorb(metrics: JournalMetrics, event: JournalEvent): void {
  metrics.events += 1
  metrics.lastEventAt = metrics.lastEventAt === undefined ? event.timestamp : Math.max(metrics.lastEventAt, event.timestamp)
  const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>
  switch (event.kind) {
    case 'agent.spawned':
      metrics.spawned = {
        roleId: str(payload.roleId) ?? '',
        ...(str(payload.roleVersion) === undefined ? {} : { roleVersion: str(payload.roleVersion) }),
        ...(str(payload.roleHash) === undefined ? {} : { roleHash: str(payload.roleHash) }),
        harness: str(payload.harness) ?? '',
        ...(typeof payload.policyApplied === 'boolean' ? { policyApplied: payload.policyApplied } : {}),
        at: event.timestamp,
      }
      break
    case 'agent.activity':
      metrics.activityEvents += 1
      break
    case 'agent.provider_retry':
      metrics.providerRetries += 1
      break
    case 'tool_call':
      metrics.toolCalls += 1
      break
    case 'tool_result':
      metrics.toolResults += 1
      break
    case 'message':
      if (event.role === 'assistant') metrics.assistantMessages += 1
      else if (event.role === 'user') metrics.userMessages += 1
      break
    case 'error':
      metrics.errors += 1
      break
    case 'policy.violation':
      metrics.policyViolations += 1
      break
    case 'verification.completed': {
      const results = Array.isArray(payload.results) ? payload.results : []
      metrics.verification = {
        totalRules: num(payload.totalRules) ?? results.length,
        passed: num(payload.passed) ?? 0,
        failed: num(payload.failed) ?? 0,
        results: results.map((entry: unknown) => {
          const item = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
          return {
            type: str(item.type) ?? 'unknown',
            passed: item.passed === true,
            ...(str(item.message) === undefined ? {} : { message: str(item.message) }),
          }
        }),
      }
      break
    }
    case 'agent.exited':
      metrics.exited = {
        exitCode: typeof payload.exitCode === 'number' ? payload.exitCode : null,
        signal: str(payload.signal) ?? null,
      }
      break
    default:
      break
  }
}

/** Events that show the agent's work; heartbeats and retry reports are about it, not part of it. */
function isVisible(event: JournalEvent): boolean {
  return event.kind !== 'agent.activity' && event.kind !== 'agent.provider_retry'
}

/**
 * Sorts the journal's quiet stretches into "the environment" (stalls) and
 * "the model working" (thinking), from the evidence the harness left
 *. Fed events in journal order.
 */
export class SilenceClassifier {
  readonly stalls: Array<{ at: number; ms: number }> = []
  readonly thinking: Array<{ at: number; ms: number; evidence: 'heartbeat' | 'reasoning' }> = []
  private previousAt: number | undefined
  private lastVisibleAt: number | undefined
  private reasoningOpen = false
  /** Within the current run of invisible events: time already classified, and whether any heartbeat was seen. */
  private classifiedSinceVisible = 0
  private heartbeatSinceVisible = false

  constructor(private readonly thresholdMs: number) {}

  observe(event: JournalEvent): void {
    const at = event.timestamp
    if (this.previousAt !== undefined) {
      const gap = at - this.previousAt
      if (gap > this.thresholdMs) {
        if (this.reasoningOpen && event.kind !== 'agent.provider_retry') {
          this.thinking.push({ at: this.previousAt, ms: gap, evidence: 'reasoning' })
        } else {
          this.stalls.push({ at: this.previousAt, ms: gap })
        }
        this.classifiedSinceVisible += gap
      }
    }
    this.previousAt = at

    const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>
    if (event.kind === 'agent.activity') {
      // Span markers (codex reasoning) are not heartbeats: they say when
      // reasoning started and ended, not that anything happened in between.
      if (payload.phase === 'progress') this.heartbeatSinceVisible = true
      if (payload.activity === 'reasoning' && payload.phase !== 'progress') this.reasoningOpen = payload.phase === 'started'
      return
    }
    if (!isVisible(event)) return

    // A long visible gap that heartbeats covered, minus what was already
    // classified inside it, is the model thinking out of sight.
    if (this.lastVisibleAt !== undefined && this.heartbeatSinceVisible) {
      const rest = at - this.lastVisibleAt - this.classifiedSinceVisible
      if (at - this.lastVisibleAt > this.thresholdMs && rest > 0) {
        this.thinking.push({ at: this.lastVisibleAt, ms: rest, evidence: 'heartbeat' })
      }
    }
    this.lastVisibleAt = at
    this.classifiedSinceVisible = 0
    this.heartbeatSinceVisible = false
    // Visible assistant output ends any reasoning codex did not close itself.
    if (event.role === 'assistant') this.reasoningOpen = false
  }
}

function sum(entries: ReadonlyArray<{ ms: number }>): number {
  return entries.reduce((total, entry) => total + entry.ms, 0)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
