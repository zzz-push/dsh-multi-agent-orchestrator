import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import { requestCancellation } from '../cancellation.js'
import {
  createFailureRecord,
  FailureCode,
  LeaseLostError,
  RunLeaseHeldError,
  RunNotFoundError,
  type FailureCodeValue,
} from '../run/errors.js'
import {
  getStepDependencies,
  isTerminalRunStatus,
  type AttemptStatus,
  type RunAggregate,
  type RunId,
  type StepAggregate,
  type StepId,
  type StepStatus,
  type VerificationEvidence,
} from '../run/types.js'
import { canTransitionStep, transitionRunStatus, transitionStepStatus } from '../run/transitions.js'
import { DEFAULT_LEASE_TTL_MS, type RunLease, type RunLeaseStore } from '../repository/lease.js'
import { evaluatePathPolicy, readPathPolicy } from '../workflow/path-policy.js'
import { composeStepPrompt, renderUpstreamArtifacts } from '../workflow/upstream-artifacts.js'
import type { RunRepository } from '../repository/types.js'
import { systemClock, type AgentExecutionHandle, type AgentExecutor, type Clock, type StepCheck, type WorkspaceDriver, type WorkspaceResult, type VerificationDriver } from '../ports.js'
import type { IdempotencyRegistry } from './idempotency.js'

export interface SchedulerConfig {
  globalMaxParallel?: number
  maxParallel?: number
  totalDeadlineMs?: number
  /**
   * While steps execute, how often the owner re-reads the run to notice a
   * cancellation requested by someone else — another process, or a
   * `CancellationService` that never talks to this scheduler. Default 1 s.
   */
  pollIntervalMs?: number
  idempotency?: IdempotencyRegistry
  /**
   * After a cancellation aborts the running agents and checks, how long they
   * get to stop before the run is marked `interrupted` instead of `cancelled`
 * Never pretend something stopped when that
   * cannot be shown. Default 30 s.
   */
  cancelGraceMs?: number
  /** Lease lifetime when `leases` is set; renewed every third of it. Default 30 s. */
  leaseTtlMs?: number
  /** This scheduler's identity in leases. Default: `<host>:<pid>:<random>`. */
  owner?: string
}

export interface SchedulerOptions extends SchedulerConfig {
  repository: RunRepository
  agentExecutor?: AgentExecutor
  workspaceDriver?: WorkspaceDriver
  verificationDriver?: VerificationDriver
  clock?: Clock
  /**
   * Cross-process run ownership. With it, `run()` holds a lease on
   * the run for as long as it works on it and refuses a run another scheduler
   * holds. Without it, ownership is enforced within this process only.
   */
  leases?: RunLeaseStore
}

/** What `recoverAbandoned()` did with one run nobody was driving. */
export interface AbandonedRunRecovery {
  runId: RunId
  /** The run after it was reclaimed; absent when reclaiming it failed. */
  run?: RunAggregate
  /** Why it could not be reclaimed. */
  error?: string
}

/**
 * Run states in which some scheduler must be advancing the run. A run in one
 * of them with no live lease was left behind by a scheduler that stopped.
 * (`waiting_*` and `delivery_ready` are resting states nobody drives;
 * `interrupted` is the honest end of a cancellation that did not stop.)
 */
const DRIVEN_RUN_STATUSES = ['validating', 'ready', 'running', 'cancelling'] as const

export interface SchedulerBatchResult {
  run: RunAggregate
  batch: StepId[]
}

/** A run this scheduler is currently advancing. */
interface OwnedRun {
  readonly id: RunId
  /** The newest state this scheduler wrote or read. */
  latest: RunAggregate | undefined
  /** Aborted on cancellation (or a lost lease); reaches every agent and check. */
  readonly abort: AbortController
  readonly handles: Set<AgentExecutionHandle>
  lease?: RunLease
  leaseLost?: LeaseLostError
  /** Set once the run was finalized with steps still running; their late writes are refused. */
  closed: boolean
  /** Tail of this run's write queue: writes are applied one at a time, in order. */
  writes: Promise<unknown>
}

/** A step in one of these states has run and cannot merge; later steps must not merge past it. */
const MERGE_BLOCKING = new Set<StepStatus>(['failed', 'merge_conflict', 'interrupted', 'waiting_approval', 'ready', 'provisioning', 'running', 'verifying'])
/** Non-terminal step states a cancelled run finalizes to `cancelled`. */
const CANCEL_ON_FINALIZE = new Set<StepStatus>(['ready', 'provisioning', 'running', 'verifying', 'waiting_approval', 'merge_queued'])
const LIVE_ATTEMPT = new Set<AttemptStatus>(['provisioning', 'running', 'verifying'])
const LIVE_STEP = new Set<StepStatus>(['provisioning', 'running', 'verifying'])

class RunClosedError extends Error {
  constructor(runId: RunId) {
    super(`Run ${runId} was finalized while this step was still running; its result is not recorded`)
    this.name = 'RunClosedError'
  }
}

/**
 * Read a string field out of a step's `metadata` bag.
 *
 * `metadata` is an untyped `Record<string, unknown>` — hand-built `StepDefinition`s (many
 * existing tests, and any caller that isn't going through `createRunFromWorkflow`) may omit it
 * entirely or leave individual keys undefined/non-string. This must never throw in that case;
 * it degrades to `undefined` instead.
 */
function readStringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key]
  return typeof value === 'string' ? value : undefined
}

function allowsNoChanges(step: StepAggregate): boolean {
  const policy = step.metadata?.policy
  return typeof policy === 'object' && policy !== null && (policy as Record<string, unknown>).allow_no_changes === true
}

/**
 * Why the candidate's changes are out of the step's bounds, or `undefined`
 * when they are within them (or nothing is known about them):
 * - a read-only step changed something;
 * - a compiled write step (`metadata.mode === 'write'`) changed nothing;
 * - a changed path is outside `paths.allow_changes` or inside `deny_changes`.
 */
function checkChangeScope(step: StepAggregate, changedPaths: readonly string[] | undefined): string | undefined {
  if (changedPaths === undefined) return undefined
  if (step.readOnly === true) {
    return changedPaths.length === 0 ? undefined : `Read-only step changed ${changedPaths.length} file(s): ${changedPaths.slice(0, 10).join(', ')}`
  }
  if (step.metadata?.mode === 'write' && changedPaths.length === 0 && !allowsNoChanges(step)) {
    return 'Write step produced no changes'
  }
  const policy = readPathPolicy(step.metadata)
  if (policy === undefined) return undefined
  const { notAllowed, denied } = evaluatePathPolicy(changedPaths, policy)
  if (notAllowed.length === 0 && denied.length === 0) return undefined
  const parts: string[] = []
  if (denied.length > 0) parts.push(`changed denied path(s): ${denied.slice(0, 10).join(', ')}`)
  if (notAllowed.length > 0) parts.push(`changed path(s) outside allow_changes: ${notAllowed.slice(0, 10).join(', ')}`)
  return `Step ${step.id} ${parts.join('; ')}`
}

/**
 * The step's declared checks (compiled workflows put `steps[].checks` into
 * the step metadata), in the port's shape. Malformed entries are dropped
 * rather than guessed at; a step without any gets no `commands` at all.
 */
function stepChecks(metadata: Record<string, unknown> | undefined): { commands?: StepCheck[] } {
  const raw = metadata?.checks
  if (!Array.isArray(raw)) return {}
  const commands: StepCheck[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const check = entry as Record<string, unknown>
    if (typeof check.id !== 'string' || !Array.isArray(check.command) || !check.command.every((part) => typeof part === 'string') || check.command.length === 0) continue
    commands.push({
      id: check.id,
      command: check.command as string[],
      cwd: typeof check.cwd === 'string' ? check.cwd : '.',
      timeoutSeconds: typeof check.timeout_seconds === 'number' ? check.timeout_seconds : 600,
      envAllow: Array.isArray(check.env_allow) ? check.env_allow.filter((name): name is string => typeof name === 'string') : [],
      required: check.required !== false,
    })
  }
  return commands.length === 0 ? {} : { commands }
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof Error && error.name === 'RevisionConflictError'
}

/**
 * Advances runs batch by batch. Real side effects are ports; the core only
 * persists intent and evidence around them.
 *
 * - **Batches run concurrently.** Every step of a batch starts from the same
 *   integration commit, at the same time, up to the effective parallel limit.
 * - **Merges happen after the batch settles, in declaration order**,
 *   each on top of the one before; the run's integration commit advances
 *   with every merge, and the next batch starts from there. A result that
 *   does not apply cleanly is `merge_conflict` — detected by the merge, never
 *   resolved by overwriting. Nothing merges past a step that failed, so the
 *   integration line only ever grows in declaration order.
 * - **Cancellation stops real resources**: agents and checks
 *   are aborted, a cancelled attempt keeps what its worktree held as
 *   evidence, and a run whose resources do not stop within the grace period
 *   ends `interrupted`, not `cancelled`.
 * - **One owner per run**: in-process always; across
 *   processes when a `RunLeaseStore` is configured.
 */
export class Scheduler {
  readonly repository: RunRepository
  private readonly agentExecutor?: AgentExecutor
  private readonly workspaceDriver?: WorkspaceDriver
  private readonly verificationDriver?: VerificationDriver
  private readonly leases?: RunLeaseStore
  private readonly clock: Clock
  private readonly config: SchedulerConfig
  private readonly owner: string
  private readonly owned = new Map<RunId, OwnedRun>()

  constructor(options: SchedulerOptions) {
    this.repository = options.repository
    this.agentExecutor = options.agentExecutor
    this.workspaceDriver = options.workspaceDriver
    this.verificationDriver = options.verificationDriver
    this.leases = options.leases
    this.clock = options.clock ?? systemClock
    this.config = options
    this.owner = options.owner ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
  }

  /**
   * Runs a run until it reaches a wait/terminal state. A second caller is
   * rejected: in-process with an error, across processes (with `leases`)
   * with `RunLeaseHeldError`.
   */
  async run(runId: string): Promise<RunAggregate> {
    return this.withOwnership(runId, (owned) => this.loop(owned))
  }

  /**
   * Runs no scheduler is driving any more: in a driven state
   * (`validating`/`ready`/`running`/`cancelling`), with no live lease, and
   * untouched for a whole lease lifetime (so a run another process has just
   * created and is about to take is left alone). Needs `leases` — without
   * them nobody's ownership is visible, and this returns nothing.
   */
  async findAbandonedRuns(): Promise<RunId[]> {
    if (this.leases === undefined) return []
    const now = this.clock.now()
    const abandoned: RunId[] = []
    for (const summary of await this.repository.list({ status: [...DRIVEN_RUN_STATUSES] })) {
      if (this.owned.has(summary.id) || summary.updatedAt > now - this.leaseTtlMs) continue
      const lease = await this.leases.get(summary.id)
      if (lease === undefined || lease.expiresAt <= now) abandoned.push(summary.id)
    }
    return abandoned
  }

  /**
   * Take over a run and bring it to rest **without running anything**: steps
   * left live by the scheduler that stopped become `interrupted` (as
   * `run()` would do), a pending cancellation is finalized, and the run
   * otherwise waits in `waiting_action` for `resume()`. Nothing here starts
   * an agent or a check — re-running work spends quota, so that is left to
   * an explicit `resume()`.
   */
  async reclaim(runId: RunId): Promise<RunAggregate> {
    return this.withOwnership(runId, async (owned) => {
      await this.recoverOrphans(owned)
      let run = await this.reload(owned)
      if (isTerminalRunStatus(run.status)) return run
      if (run.cancelRequestedAt !== undefined || run.status === 'cancelling') return this.finalizeCancellation(owned)
      if (run.status === 'validating') run = await this.moveRun(owned, 'ready')
      if (run.status === 'ready') run = await this.moveRun(owned, 'running')
      if (run.status === 'running') run = await this.moveRun(owned, 'waiting_action')
      return run
    })
  }

  /**
   * Reclaim every abandoned run (`findAbandonedRuns`). One run failing to be
   * reclaimed does not stop the others; a run someone else took in the
   * meantime is skipped.
   */
  async recoverAbandoned(): Promise<AbandonedRunRecovery[]> {
    const recoveries: AbandonedRunRecovery[] = []
    for (const runId of await this.findAbandonedRuns()) {
      try {
        recoveries.push({ runId, run: await this.reclaim(runId) })
      } catch (error) {
        if (error instanceof RunLeaseHeldError) continue
        recoveries.push({ runId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return recoveries
  }

  /**
   * Continue a run that was interrupted: reclaim it if its scheduler is gone,
   * put every `interrupted` step back to `ready` (a fresh attempt from the
   * current integration commit, as `retryStep` does), and run it. Steps that
   * merged stay merged. `failed` and `merge_conflict` steps are left alone —
   * they need a human first, then `retryStep`. A run someone else is
   * driving is refused with `RunLeaseHeldError`.
   */
  async resume(runId: RunId): Promise<RunAggregate> {
    const reclaimed = await this.reclaim(runId)
    for (const step of Object.values(reclaimed.steps)) {
      if (step.status === 'interrupted') await this.retryStep(runId, step.id)
    }
    return this.run(runId)
  }

  /** Hold the run (in-process, and with `leases` across processes) while `body` works on it. */
  private async withOwnership(runId: RunId, body: (owned: OwnedRun) => Promise<RunAggregate>): Promise<RunAggregate> {
    if (this.owned.has(runId)) throw new Error(`Scheduler already owns run ${runId}`)
    const owned: OwnedRun = { id: runId, latest: undefined, abort: new AbortController(), handles: new Set(), closed: false, writes: Promise.resolve() }
    this.owned.set(runId, owned)
    owned.abort.signal.addEventListener('abort', () => {
      for (const handle of owned.handles) {
        void Promise.resolve().then(() => handle.cancel?.()).catch(() => undefined)
      }
    }, { once: true })
    let heartbeat: ReturnType<typeof setInterval> | undefined
    try {
      if (this.leases !== undefined) {
        const lease = await this.leases.acquire(runId, this.owner, this.leaseTtlMs)
        if (lease === undefined) {
          const held = await this.leases.get(runId)
          throw new RunLeaseHeldError(runId, held?.owner ?? 'unknown', held?.expiresAt ?? 0)
        }
        owned.lease = lease
        heartbeat = setInterval(() => { void this.renewLease(owned) }, Math.max(1, Math.floor(this.leaseTtlMs / 3)))
        heartbeat.unref?.()
      }
      return await body(owned)
    } finally {
      if (heartbeat !== undefined) clearInterval(heartbeat)
      this.owned.delete(runId)
      if (owned.lease !== undefined && owned.leaseLost === undefined) {
        await this.leases?.release(owned.lease).catch(() => undefined)
      }
    }
  }

  schedule(runId: string): Promise<RunAggregate> {
    return this.run(runId)
  }

  start(runId: string): Promise<RunAggregate> {
    return this.run(runId)
  }

  /**
   * Cancel a run: persist the intent, then stop what is running.
   *
   * When this scheduler is advancing the run, its agents and checks are
   * aborted at once and the pending `run()` call resolves with the final
   * state. When nobody here is, the run is finalized directly — unless
   * another process holds its lease, in which case that owner notices the
   * request within `pollIntervalMs` and finalizes it; the `cancelling` state
   * is returned.
   */
  async cancel(runId: string): Promise<RunAggregate> {
    const { run } = await requestCancellation(this.repository, runId, this.clock)
    const owned = this.owned.get(runId)
    if (owned !== undefined) {
      owned.abort.abort()
      return run
    }
    if (run.status !== 'cancelling') return run
    try {
      return await this.run(runId)
    } catch (error) {
      if (error instanceof RunLeaseHeldError) return run
      throw error
    }
  }

  /**
   * Put a failed, conflicted or interrupted step back to `ready`, so the next
   * `run()` executes it again from the current integration commit — a new
   * attempt in a fresh worktree, never the old one. Results of its
   * batch-mates that were held back behind it merge right after it.
   */
  async retryStep(runId: string, stepId: StepId): Promise<RunAggregate> {
    for (;;) {
      const run = await this.repository.get(runId)
      if (run === undefined) throw new RunNotFoundError(runId)
      try {
        return await this.repository.update(runId, run.revision, (candidate) => this.setStep(candidate, stepId, (step) => {
          const status: StepStatus = step.status === 'merge_conflict'
            ? transitionStepStatus(transitionStepStatus(step.status, 'failed', candidate.revision), 'ready', candidate.revision)
            : transitionStepStatus(step.status, 'ready', candidate.revision)
          const { failure: _failure, resultCommit: _resultCommit, ...rest } = step
          return { ...rest, status }
        }))
      } catch (error) {
        if (!isRevisionConflict(error)) throw error
      }
    }
  }

  /** Creates a run once for an idempotency key, then schedules it. */
  async startRun(run: RunAggregate, options: { idempotencyKey?: string; inputHash?: string } = {}): Promise<RunAggregate> {
    const key = options.idempotencyKey ?? run.idempotencyKey
    const inputHash = options.inputHash ?? run.workflowHash
    const idempotency = this.config.idempotency
    if (key !== undefined && idempotency !== undefined) {
      const existingId = idempotency.getStart(key, inputHash)
      if (existingId !== undefined) {
        const existing = await this.repository.get(existingId)
        if (existing !== undefined) return existing
      }
      idempotency.rememberStart(key, inputHash, run.id)
    }
    await this.repository.create({ ...run, idempotencyKey: key })
    return this.run(run.id)
  }

  createRun(run: RunAggregate, options?: { idempotencyKey?: string; inputHash?: string }): Promise<RunAggregate> {
    return this.startRun(run, options)
  }

  computeReadySteps(run: RunAggregate): StepId[] {
    return Object.values(run.steps)
      .filter((step) => step.status === 'pending' || step.status === 'ready')
      .filter((step) => getStepDependencies(step).every((dependency) => {
        const dependencyStep = run.steps[dependency]
        return dependencyStep !== undefined && (dependencyStep.status === 'merged' || dependencyStep.status === 'succeeded')
      }))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((step) => step.id)
  }

  selectBatch(run: RunAggregate): StepId[] {
    return this.computeReadySteps(run).slice(0, this.effectiveParallelLimit(run))
  }

  private get leaseTtlMs(): number {
    return this.config.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
  }

  private async loop(owned: OwnedRun): Promise<RunAggregate> {
    await this.recoverOrphans(owned)
    for (;;) {
      let run = await this.reload(owned)
      if (isTerminalRunStatus(run.status)) return run
      if (run.cancelRequestedAt !== undefined || run.status === 'cancelling') return this.finalizeCancellation(owned)
      if (run.status === 'validating') run = await this.moveRun(owned, 'ready')

      const deadline = run.budget.deadlineAt ?? run.workflow?.totalDeadlineAt ??
        (this.config.totalDeadlineMs === undefined ? undefined : run.createdAt + this.config.totalDeadlineMs)
      if (deadline !== undefined && this.clock.now() >= deadline) {
        return this.failRun(owned, FailureCode.BudgetExceeded, 'Run deadline exceeded', false)
      }

      // Results that passed but have not merged yet — this batch's, or ones
      // held back behind a failure that has since been retried — go first.
      run = await this.mergeQueued(owned)
      if (run.cancelRequestedAt !== undefined) continue

      if (this.findUnresolvedFailure(run) !== undefined) return this.settle(owned, 'waiting_action')

      const ready = this.computeReadySteps(run)
      if (ready.length === 0) {
        return this.settle(owned, this.allStepsSuccessful(run) ? 'delivery_ready' : 'waiting_action')
      }

      const batch = ready.slice(0, this.effectiveParallelLimit(run))
      if (run.status !== 'running') {
        run = await this.moveRun(owned, 'running')
        if (run.cancelRequestedAt !== undefined) continue
      }
      const settled = await this.executeBatch(owned, batch)
      if (settled === 'interrupted') return owned.latest ?? run
    }
  }

  /**
   * Steps left live by a scheduler that is gone (a crash, a lost lease): this
   * scheduler owns the run now and started none of them, so nobody is
   * driving them. They become `interrupted` — never resumed, since the old
   * agent may have done things its transcript cannot prove — and
   * `retryStep` can run them again from the integration commit. Their
   * worktrees are left in place for inspection.
   */
  private async recoverOrphans(owned: OwnedRun): Promise<void> {
    const run = await this.reload(owned)
    if (isTerminalRunStatus(run.status)) return
    const orphans = Object.values(run.steps).filter((step) => LIVE_STEP.has(step.status)).map((step) => step.id)
    if (orphans.length === 0) return
    const at = this.clock.now()
    await this.commit(owned, (candidate) => {
      let next = candidate
      for (const stepId of orphans) {
        next = this.setStep(next, stepId, (step) => {
          if (!LIVE_STEP.has(step.status)) return step
          const failure = createFailureRecord({
            code: FailureCode.Interrupted,
            message: 'The scheduler running this attempt stopped before it finished (process exit or lost lease); retry the step to run it again',
            retryable: true,
            stepId,
            attempt: step.attempts.at(-1)?.attempt,
            occurredAt: at,
            runRevision: candidate.revision,
          })
          return {
            ...step,
            status: transitionStepStatus(step.status, 'interrupted', candidate.revision),
            failure,
            attempts: step.attempts.map((value) => LIVE_ATTEMPT.has(value.status) ? { ...value, status: 'interrupted', failure } : value),
          }
        })
      }
      return next
    })
  }

  private effectiveParallelLimit(run: RunAggregate): number {
    const workflowLimit = run.workflow?.maxParallel ?? Number.POSITIVE_INFINITY
    const globalLimit = this.config.globalMaxParallel ?? this.config.maxParallel ?? Number.POSITIVE_INFINITY
    return Math.max(1, Math.min(workflowLimit, globalLimit))
  }

  /** Execute every step of the batch concurrently and wait for all of them. */
  private async executeBatch(owned: OwnedRun, batch: StepId[]): Promise<'settled' | 'interrupted'> {
    await this.commit(owned, (candidate) => {
      const nextBatch = candidate.integration.batch + 1
      const steps = { ...candidate.steps }
      for (const stepId of batch) {
        const step = steps[stepId]
        if (step === undefined || step.status === 'ready') continue
        steps[stepId] = { ...step, status: transitionStepStatus(step.status, 'ready', candidate.revision), batch: nextBatch }
      }
      return { ...candidate, steps, integration: { ...candidate.integration, batch: nextBatch } }
    })

    // Cancellation requested elsewhere reaches the run document, not us.
    const poll = setInterval(() => {
      void this.repository.get(owned.id).then((fresh) => {
        if (fresh?.cancelRequestedAt !== undefined) owned.abort.abort()
      }, () => undefined)
    }, this.config.pollIntervalMs ?? 1_000)
    poll.unref?.()

    let unexpected: unknown
    const steps = batch.map((stepId) => this.executeStep(owned, stepId).catch((error: unknown) => {
      if (error instanceof RunClosedError || error instanceof LeaseLostError) return
      unexpected ??= error
    }))
    try {
      const outcome = await settleOrGiveUp(Promise.all(steps), owned.abort.signal, this.config.cancelGraceMs ?? 30_000)
      if (owned.leaseLost !== undefined) {
        owned.closed = true
        throw owned.leaseLost
      }
      if (outcome === 'grace_expired') {
        await this.interruptRun(owned, batch)
        return 'interrupted'
      }
      if (unexpected !== undefined) throw unexpected
      return 'settled'
    } finally {
      clearInterval(poll)
    }
  }

  private async executeStep(owned: OwnedRun, stepId: StepId): Promise<void> {
    const signal = owned.abort.signal
    const step = owned.latest?.steps[stepId]
    if (step === undefined) return
    const attemptNumber = (step.attempts.at(-1)?.attempt ?? 0) + 1
    let current = await this.commit(owned, (candidate) => this.setStep(candidate, stepId, (entry) => ({
      ...entry,
      status: transitionStepStatus(entry.status, 'provisioning', candidate.revision),
      attempts: [...entry.attempts, {
        attempt: attemptNumber,
        status: 'provisioning',
        inputCommit: candidate.integration.commit,
        completions: [],
        startedAt: this.clock.now(),
      }],
    })))

    const currentStep = current.steps[stepId]
    const attempt = currentStep?.attempts.at(-1)
    if (currentStep === undefined || attempt === undefined) return
    let workspaceId: string | undefined
    let worktreePath: string | undefined
    let handle: AgentExecutionHandle | undefined
    try {
      if (signal.aborted) return await this.cancelStep(owned, stepId, attemptNumber, undefined)
      if (this.workspaceDriver !== undefined) {
        const workspace = await this.workspaceDriver.createAttempt({
          runId: current.id,
          stepId,
          attempt: attemptNumber,
          inputCommit: attempt.inputCommit,
          repository: current.repository,
          ...(current.workflow?.setup === undefined ? {} : { setup: current.workflow.setup }),
        })
        workspaceId = workspace.workspaceId
        worktreePath = workspace.worktreePath
        current = await this.commit(owned, (candidate) => this.setAttempt(candidate, stepId, attemptNumber, (value) => ({ ...value, workspaceId, worktreePath })))
      }
      if (signal.aborted) return await this.cancelStep(owned, stepId, attemptNumber, workspaceId)

      // What the step consumes from its upstream steps goes in front of its
      // agent with its own instructions, and on the attempt record.
      const upstream = renderUpstreamArtifacts(current, currentStep)
      current = await this.commit(owned, (candidate) => this.setStep(candidate, stepId, (entry) => ({
        ...entry,
        status: transitionStepStatus(entry.status, 'running', candidate.revision),
        attempts: entry.attempts.map((value) => value.attempt === attemptNumber
          ? { ...value, status: 'running', ...(upstream === undefined ? {} : { consumed: upstream.consumed }) }
          : value),
      })))
      handle = this.agentExecutor === undefined ? undefined : await this.agentExecutor.start({
        runId: current.id,
        stepId,
        attempt: attemptNumber,
        attemptId: attempt.id,
        inputCommit: attempt.inputCommit,
        workspaceId,
        worktreePath,
        roleId: readStringMetadata(currentStep.metadata, 'role'),
        prompt: composeStepPrompt(
          readStringMetadata(currentStep.metadata, 'instructions')
            ?? readStringMetadata(currentStep.metadata, 'instructions_file_content'),
          upstream,
        ),
        sandbox: readStringMetadata(currentStep.metadata, 'sandbox'),
        harness: readStringMetadata(currentStep.metadata, 'harness'),
        scenario: readStringMetadata(currentStep.metadata, 'scenario'),
        signal,
      })
      if (handle !== undefined) {
        owned.handles.add(handle)
        // The abort listener may have fired while start() was in flight.
        if (signal.aborted) void Promise.resolve().then(() => handle?.cancel?.()).catch(() => undefined)
      }
      const completion = handle === undefined ? { outcome: 'succeeded' as const } : await handle.wait()
      current = await this.commit(owned, (candidate) => this.setAttempt(candidate, stepId, attemptNumber, (value) => ({
        ...value,
        status: 'verifying',
        completions: [...value.completions, { round: value.completions.length + 1, submittedAt: this.clock.now(), value: completion }],
      })))
      current = await this.commit(owned, (candidate) => this.setStep(candidate, stepId, (entry) => ({ ...entry, status: transitionStepStatus(entry.status, 'verifying', candidate.revision) })))
      if (signal.aborted) return await this.cancelStep(owned, stepId, attemptNumber, workspaceId)

      if (completion.outcome !== undefined && completion.outcome !== 'succeeded') {
        // The agent did not finish (timeout, abort, harness error, or its own
        // `blocked`). Checks are not run: passing them on a half-done worktree
        // would read as success. What the worktree holds is still captured —
        // pinned under the candidate ref and summarised in the evidence — so a
        // reader can see how far the agent got.
        const captured = this.workspaceDriver?.captureResult === undefined
          ? undefined
          : await this.workspaceDriver.captureResult({ runId: current.id, stepId, attempt: attemptNumber, workspaceId: workspaceId ?? '' })
        const code = completion.failureCode ?? (completion.outcome === 'cancelled' ? FailureCode.Cancelled : FailureCode.AgentFailed)
        const message = completion.error ?? completion.summary ?? `Agent completion outcome: ${completion.outcome}`
        const captureEvidence = mergeEvidence(undefined, captured)
        // No check ran, so nothing "passed" — whatever the capture said.
        await this.failStep(owned, stepId, attemptNumber, message, code, captureEvidence === undefined ? undefined : { ...captureEvidence, passed: false })
        return
      }

      const verification = this.verificationDriver === undefined
        ? { passed: true }
        : await this.verificationDriver.run({
          runId: current.id,
          stepId,
          attempt: attemptNumber,
          workspaceId,
          worktreePath,
          ...stepChecks(currentStep.metadata),
          signal,
        })
      // Checks killed by a cancellation say nothing about the work.
      if (signal.aborted) return await this.cancelStep(owned, stepId, attemptNumber, workspaceId)
      const captured = this.workspaceDriver?.captureResult === undefined
        ? undefined
        : await this.workspaceDriver.captureResult({ runId: current.id, stepId, attempt: attemptNumber, workspaceId: workspaceId ?? '' })
      const evidence = mergeEvidence(verification.evidence, captured)
      if (!verification.passed) {
        // Keep the evidence on the failed attempt: which check broke and what
        // it printed is the most useful thing a reader can see about a failure.
        await this.failStep(owned, stepId, attemptNumber, verification.failureMessage ?? 'Verification failed', FailureCode.VerificationFailed, evidence)
        return
      }
      // What the candidate actually changed, against what the step may change
      // — decided from the diff, not from the agent's report.
      const scope = checkChangeScope(currentStep, captured?.changedPaths)
      if (scope !== undefined) {
        await this.failStep(owned, stepId, attemptNumber, scope, FailureCode.PolicyViolation, evidence === undefined ? undefined : { ...evidence, passed: false })
        return
      }
      const finishedAt = this.clock.now()
      // Read-only, or a write step allowed to find nothing to change and
      // that did not: there is nothing to merge.
      const nothingToMerge = current.steps[stepId]?.readOnly === true
        || (captured?.changedPaths?.length === 0 && allowsNoChanges(currentStep))
      if (nothingToMerge) {
        await this.commit(owned, (candidate) => this.setStep(candidate, stepId, (entry) => ({ ...entry, status: transitionStepStatus(entry.status, 'succeeded', candidate.revision), attempts: entry.attempts.map((value) => value.attempt === attemptNumber ? { ...value, status: 'completed', finishedAt, evidence } : value) })))
        return
      }
      // Verified; it merges once the whole batch has settled (mergeQueued).
      const resultCommit = captured?.resultCommit ?? `result:${current.id}:${stepId}:${attemptNumber}`
      await this.commit(owned, (candidate) => this.setStep(candidate, stepId, (entry) => ({ ...entry, status: transitionStepStatus(entry.status, 'merge_queued', candidate.revision), resultCommit, attempts: entry.attempts.map((value) => value.attempt === attemptNumber ? { ...value, status: 'completed', finishedAt, resultCommit, evidence } : value) })))
    } catch (error) {
      if (error instanceof RunClosedError || error instanceof LeaseLostError) throw error
      if (signal.aborted) return await this.cancelStep(owned, stepId, attemptNumber, workspaceId)
      const message = error instanceof Error ? error.message : 'Step execution failed'
      await this.failStep(owned, stepId, attemptNumber, message, FailureCode.HostIoFailed)
    } finally {
      if (handle !== undefined) {
        owned.handles.delete(handle)
        if (handle.dispose !== undefined) await handle.dispose()
      }
      if (workspaceId !== undefined && this.workspaceDriver?.removeAttempt !== undefined) await this.workspaceDriver.removeAttempt(workspaceId)
    }
  }

  /**
   * Merge verified results into the integration line, in declaration order,
   * each on top of the previous one, advancing `integration.commit` with
   * every merge. Stops at the first conflict, and never merges past a step
   * that ran but is not mergeable — the integration commit only advances
   * through results in declaration order.
   */
  private async mergeQueued(owned: OwnedRun): Promise<RunAggregate> {
    let run = owned.latest ?? await this.reload(owned)
    const ordered = Object.values(run.steps).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    for (const { id: stepId } of ordered) {
      if (owned.abort.signal.aborted) break
      const step = run.steps[stepId]
      if (step === undefined) continue
      if (MERGE_BLOCKING.has(step.status)) break
      if (step.status !== 'merge_queued') continue
      const resultCommit = step.resultCommit ?? `result:${run.id}:${stepId}`
      if (this.workspaceDriver?.mergeResult === undefined) {
        run = await this.commit(owned, (candidate) => this.setStep(candidate, stepId, (entry) => ({ ...entry, status: transitionStepStatus(entry.status, 'merged', candidate.revision) })))
        continue
      }
      const merged = await this.workspaceDriver.mergeResult({
        runId: run.id,
        stepId,
        resultCommit,
        integrationRef: run.integration.ref,
        expectedIntegrationCommit: run.integration.commit,
        repositoryRoot: run.repository.root,
      })
      if (!merged.merged) {
        const attempt = step.attempts.at(-1)?.attempt ?? 0
        return this.conflictStep(owned, stepId, attempt, merged.conflict ?? 'Merge conflict')
      }
      run = await this.commit(owned, (candidate) => ({
        ...this.setStep(candidate, stepId, (entry) => ({ ...entry, status: transitionStepStatus(entry.status, 'merged', candidate.revision), mergeEvidence: merged.evidence, resultCommit })),
        integration: { ...candidate.integration, commit: merged.integrationCommit ?? candidate.integration.commit },
      }))
    }
    return run
  }

  /**
   * A merge that did not land is `merge_conflict`, not `failed`: the step
   * transition table only allows `merge_queued -> merge_conflict`, and the
   * candidate commit is intact and worth keeping for a human to resolve.
   */
  private async conflictStep(owned: OwnedRun, stepId: StepId, attempt: number, message: string): Promise<RunAggregate> {
    // The attempt itself is left as it is — `completed`, with its verified
    // candidate and evidence. Failing to land is a property of the step's
    // integration, not of the work the attempt did.
    return this.commit(owned, (candidate) => this.setStep(candidate, stepId, (entry) => ({
      ...entry,
      status: transitionStepStatus(entry.status, 'merge_conflict', candidate.revision),
      failure: createFailureRecord({ code: FailureCode.MergeConflict, message, retryable: true, stepId, attempt, occurredAt: this.clock.now(), runRevision: candidate.revision }),
    })))
  }

  private async failStep(owned: OwnedRun, stepId: StepId, attempt: number, message: string, code: FailureCode | FailureCodeValue = FailureCode.VerificationFailed, evidence?: VerificationEvidence): Promise<RunAggregate> {
    return this.commit(owned, (candidate) => this.setStep(candidate, stepId, (entry) => ({
      ...entry,
      status: transitionStepStatus(entry.status, 'failed', candidate.revision),
      failure: createFailureRecord({ code, message, retryable: false, stepId, attempt, occurredAt: this.clock.now(), runRevision: candidate.revision }),
      attempts: entry.attempts.map((value) => value.attempt === attempt ? { ...value, status: 'failed', finishedAt: this.clock.now(), ...(evidence === undefined ? {} : { evidence }), failure: createFailureRecord({ code, message, retryable: false, stepId, attempt, occurredAt: this.clock.now(), runRevision: candidate.revision }) } : value),
    })))
  }

  /**
   * The run was cancelled while this step was live. Whatever the worktree
   * holds is captured as evidence (keep the diff) before the worktree
   * goes away; the attempt and step end `cancelled`.
   */
  private async cancelStep(owned: OwnedRun, stepId: StepId, attempt: number, workspaceId: string | undefined): Promise<void> {
    const captured = workspaceId === undefined || this.workspaceDriver?.captureResult === undefined
      ? undefined
      : await this.workspaceDriver.captureResult({ runId: owned.id, stepId, attempt, workspaceId }).catch(() => undefined)
    const evidence = mergeEvidence(undefined, captured)
    const finishedAt = this.clock.now()
    await this.commit(owned, (candidate) => this.setStep(candidate, stepId, (entry) => ({
      ...entry,
      status: canTransitionStep(entry.status, 'cancelled') ? 'cancelled' : entry.status,
      attempts: entry.attempts.map((value) => value.attempt === attempt
        ? { ...value, status: 'cancelled', finishedAt, ...(evidence === undefined ? {} : { evidence: { ...evidence, passed: false } }) }
        : value),
    })))
  }

  private findUnresolvedFailure(run: RunAggregate): StepAggregate | undefined {
    return Object.values(run.steps).find((step) => step.status === 'failed' || step.status === 'merge_conflict' || step.status === 'interrupted')
  }

  private allStepsSuccessful(run: RunAggregate): boolean {
    return Object.values(run.steps).every((step) => step.status === 'merged' || step.status === 'succeeded' || step.status === 'skipped_dependency_failed')
  }

  /**
   * Move the run to `status`. A cancellation that landed in the meantime
   * wins: the run is left as it is (the write only bumps its revision) and
   * the caller's next look at it finalizes the cancellation.
   */
  private async moveRun(owned: OwnedRun, status: RunAggregate['status']): Promise<RunAggregate> {
    return this.commit(owned, (candidate) => candidate.cancelRequestedAt !== undefined
      ? candidate
      : { ...candidate, status: transitionRunStatus(candidate.status, status, candidate.revision) })
  }

  /** End this call in `status` (a wait state), unless a cancellation got there first. */
  private async settle(owned: OwnedRun, status: 'waiting_action' | 'delivery_ready'): Promise<RunAggregate> {
    const current = owned.latest
    const run = current !== undefined && current.status === status ? current : await this.moveRun(owned, status)
    return run.cancelRequestedAt !== undefined ? this.finalizeCancellation(owned) : run
  }

  private async failRun(owned: OwnedRun, code: FailureCode, message: string, retryable: boolean): Promise<RunAggregate> {
    // `failed` is not a direct successor of every status (see RUN_TRANSITIONS): `ready` and
    // `running` must route through `waiting_action` first, per the state-machine contract
    let current = owned.latest ?? await this.reload(owned)
    if (current.status === 'ready') current = await this.moveRun(owned, 'running')
    if (current.status === 'running') current = await this.moveRun(owned, 'waiting_action')
    return this.commit(owned, (candidate) => ({
      ...candidate,
      status: transitionRunStatus(candidate.status, 'failed', candidate.revision),
      failure: createFailureRecord({ code, message, retryable, occurredAt: this.clock.now(), runRevision: candidate.revision }),
      finishedAt: this.clock.now(),
    }))
  }

  /**
   * Nothing of this run is running any more (the batch settled, or none was
   * in flight): every step still waiting to run or merge is cancelled, and so
   * is the run.
   */
  private async finalizeCancellation(owned: OwnedRun): Promise<RunAggregate> {
    owned.abort.abort()
    let run = owned.latest ?? await this.reload(owned)
    if (run.status !== 'cancelling') {
      run = (await requestCancellation(this.repository, owned.id, this.clock)).run
      owned.latest = run
    }
    if (run.status !== 'cancelling') return run
    const finishedAt = this.clock.now()
    return this.commit(owned, (candidate) => {
      if (candidate.status !== 'cancelling') return candidate
      const steps: Record<StepId, StepAggregate> = {}
      for (const [stepId, step] of Object.entries(candidate.steps)) {
        steps[stepId] = CANCEL_ON_FINALIZE.has(step.status)
          ? {
              ...step,
              status: 'cancelled',
              attempts: step.attempts.map((value) => LIVE_ATTEMPT.has(value.status) ? { ...value, status: 'cancelled', finishedAt } : value),
            }
          : step
      }
      return { ...candidate, steps, status: transitionRunStatus(candidate.status, 'cancelled', candidate.revision), finishedAt }
    })
  }

  /**
   * Cancelled, but some agent or check did not stop within the grace period.
   * Claiming `cancelled` would be claiming something unproven; the run
   * is `interrupted`, the steps still live are marked so, and whatever those
   * steps try to write later is refused.
   */
  private async interruptRun(owned: OwnedRun, batch: StepId[]): Promise<RunAggregate> {
    const graceMs = this.config.cancelGraceMs ?? 30_000
    const run = await this.commit(owned, (candidate) => {
      const steps = { ...candidate.steps }
      const stuck: StepId[] = []
      for (const stepId of batch) {
        const step = steps[stepId]
        if (step === undefined || !canTransitionStep(step.status, 'interrupted')) continue
        stuck.push(stepId)
        steps[stepId] = {
          ...step,
          status: 'interrupted',
          attempts: step.attempts.map((value) => LIVE_ATTEMPT.has(value.status) ? { ...value, status: 'interrupted' } : value),
        }
      }
      return {
        ...candidate,
        steps,
        status: candidate.status === 'cancelling' ? transitionRunStatus(candidate.status, 'interrupted', candidate.revision) : candidate.status,
        failure: createFailureRecord({
          code: FailureCode.Interrupted,
          message: `Cancellation requested, but ${stuck.join(', ') || 'a step'} did not stop within ${graceMs}ms; its agent or checks may still be running`,
          retryable: false,
          occurredAt: this.clock.now(),
          runRevision: candidate.revision,
        }),
      }
    })
    owned.closed = true
    return run
  }

  private async renewLease(owned: OwnedRun): Promise<void> {
    if (owned.lease === undefined || owned.leaseLost !== undefined || this.leases === undefined) return
    try {
      owned.lease = await this.leases.renew(owned.lease, this.leaseTtlMs)
    } catch (error) {
      // A transient I/O failure is retried at the next beat; only a lease
      // that verifiably changed hands stops the run.
      if (!(error instanceof LeaseLostError)) return
      owned.leaseLost = error
      owned.abort.abort()
    }
  }

  private async reload(owned: OwnedRun): Promise<RunAggregate> {
    await owned.writes
    const run = await this.repository.get(owned.id)
    if (run === undefined) throw new RunNotFoundError(owned.id)
    owned.latest = run
    return run
  }

  /**
   * Apply `mutate` to the newest state of the run, one write at a time.
   *
   * Concurrent steps of a batch all write through here, so none of them
   * writes from a stale revision. A conflict can still come from outside —
   * a cancellation request is the expected one — and is resolved by
   * re-reading and re-applying `mutate`, which only ever looks at the state
   * it is handed. With a lease, the lease is re-checked before retrying: an
   * owner that lost the run must not write over its new owner's progress.
   */
  private commit(owned: OwnedRun, mutate: (candidate: RunAggregate) => RunAggregate): Promise<RunAggregate> {
    const write = owned.writes.then(async () => {
      for (let attempt = 0; ; attempt += 1) {
        if (owned.leaseLost !== undefined) throw owned.leaseLost
        if (owned.closed) throw new RunClosedError(owned.id)
        const base = owned.latest ?? await this.repository.get(owned.id)
        if (base === undefined) throw new RunNotFoundError(owned.id)
        try {
          const updated = await this.repository.update(owned.id, base.revision, mutate)
          owned.latest = updated
          if (updated.cancelRequestedAt !== undefined) owned.abort.abort()
          return updated
        } catch (error) {
          if (!isRevisionConflict(error) || attempt >= 8) throw error
          owned.latest = undefined
          if (owned.lease !== undefined && this.leases !== undefined) {
            try {
              owned.lease = await this.leases.renew(owned.lease, this.leaseTtlMs)
            } catch (leaseError) {
              if (leaseError instanceof LeaseLostError) {
                owned.leaseLost = leaseError
                owned.abort.abort()
              }
              throw leaseError
            }
          }
        }
      }
    })
    owned.writes = write.catch(() => undefined)
    return write
  }

  private setStep(run: RunAggregate, stepId: StepId, mutate: (step: StepAggregate) => StepAggregate): RunAggregate {
    const step = run.steps[stepId]
    if (step === undefined) return run
    return { ...run, steps: { ...run.steps, [stepId]: mutate(step) } }
  }

  private setAttempt(run: RunAggregate, stepId: StepId, attempt: number, mutate: (value: StepAggregate['attempts'][number]) => StepAggregate['attempts'][number]): RunAggregate {
    return this.setStep(run, stepId, (step) => ({ ...step, attempts: step.attempts.map((value) => value.attempt === attempt ? mutate(value) : value) }))
  }
}

export const ExecutionScheduler = Scheduler

/**
 * Resolve when `work` settles, or — once `signal` aborts — when `graceMs`
 * has passed without it settling, whichever comes first.
 */
async function settleOrGiveUp(work: Promise<unknown>, signal: AbortSignal, graceMs: number): Promise<'settled' | 'grace_expired'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const gaveUp = new Promise<'grace_expired'>((resolve) => {
    const startGrace = (): void => { timer = setTimeout(() => resolve('grace_expired'), graceMs) }
    if (signal.aborted) startGrace()
    else {
      onAbort = startGrace
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
  try {
    return await Promise.race([work.then(() => 'settled' as const), gaveUp])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * One attempt has two evidence sources with different knowledge: the
 * verification driver knows which checks ran and how they exited, the
 * workspace driver knows what the candidate commit changed. Keeping only one
 * (as `verification.evidence ?? captured?.evidence` did) silently dropped
 * `changedPaths`/`diffHash` whenever any check ran — which is exactly when a
 * reader most wants to see what was changed. Merge them; explicit
 * verification fields win on conflict because they describe the same run.
 */
function mergeEvidence(
  verification: VerificationEvidence | undefined,
  captured: WorkspaceResult | undefined,
): VerificationEvidence | undefined {
  const capturedEvidence = captured?.evidence
  if (verification === undefined && capturedEvidence === undefined && captured?.changedPaths === undefined && captured?.diffHash === undefined) {
    return undefined
  }
  const changedPaths = verification?.changedPaths ?? captured?.changedPaths ?? capturedEvidence?.changedPaths
  const diffHash = verification?.diffHash ?? captured?.diffHash ?? capturedEvidence?.diffHash
  return {
    passed: verification?.passed ?? capturedEvidence?.passed ?? true,
    ...(verification?.checks === undefined ? {} : { checks: verification.checks }),
    ...(changedPaths === undefined ? {} : { changedPaths }),
    ...(diffHash === undefined ? {} : { diffHash }),
  }
}
