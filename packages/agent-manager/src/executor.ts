import type { AgentExecutor, AgentExecutionRequest, AgentExecutionHandle } from '@dsh/core'
import type { AgentCompletion } from '@dsh/core'
import { ChannelAbortedError, ChannelTimeoutError } from './errors.js'
import type { AgentChatReply, AgentManager } from './manager.js'

/** Options for {@link AgentManagerExecutor}. */
export interface AgentManagerExecutorOptions {
  /**
   * Wall-clock cap on one step's command turn, in milliseconds. A wedged
   * harness must not hang the Scheduler forever; on expiry the agent is
   * closed and the completion is `failed` with a timeout error.
   * Default: one hour.
   */
  maxWaitMs?: number
  /**
   * Explicit `sendChat` timeout for the step's turn, overriding the role's
   * own `chatTimeoutMs`. Unset (the default) means every role runs under the
   * budget it declared. A caller that must give several roles the same
   * budget — a role comparison, where two versions declaring different
   * timeouts would otherwise be compared on unequal clocks — sets this.
   */
  turnTimeoutMs?: number
}

const DEFAULT_MAX_WAIT_MS = 3_600_000

/**
 * Harness turn errors that mean "the account ran out", not "the agent did
 * something wrong". Heuristic by necessity: neither harness gives these a
 * structured code over its protocol. Observed during testing from claude-code:
 * "You've hit your session limit · resets 9:50am". Classifying them lets a
 * reader (and the comparison verdict) tell an environment failure from a
 * role failure; a miss only means the failure stays the generic
 * `agent_failed`.
 */
const PROVIDER_LIMIT = /session limit|usage limit|rate[ -]?limit|quota|too many requests|\b429\b|credit balance/i

/**
 * Adapts AgentManager to the AgentExecutor port interface required by Scheduler.
 *
 * The step's instructions go out as one `sendChat()` turn and the reply is
 * the completion signal. Two reasons this is `sendChat` and not
 * `sendCommand`:
 *
 * - `sendCommand` discards the reply and never runs the role's own declared
 *   `verification` rules — those only run inside `sendChat`. A
 *   governed pipeline step that skipped the role's self-check would be
 *   throwing away the one mechanical signal the role itself offers.
 * - `sendChat` resolves when the turn completes, honours the role's
 *   `chatTimeoutMs` and an AbortSignal natively. It does not wait for the
 *   child process to exit — a role with `keepAliveAfterTask: true` never
 *   exits after a turn, and the previous exit-polling implementation would
 *   have sat on such a role until its one-hour cap and then reported a
 *   timeout for work that finished long before (that was earlier behavior polling,
 *   and a real hole for the current `example-builder`, which keeps
 *   alive).
 *
 * Every completion carries `agentId`: the join key between the persisted
 * `RunAggregate` (completions per attempt) and the agent journal
 * (`agent.spawned` with `roleHash`, `tool_call`, `verification.completed`,
 * …). The reply's own facts ride along — `summary` (reply text), `model`,
 * `toolCalls` (count), `verification` (pass/fail counts) — because the run
 * record should say what the attempt produced without a journal lookup. The
 * journal stays the detailed source; these are the channel's numbers, not a
 * second count that could drift from it.
 */
export class AgentManagerExecutor implements AgentExecutor {
  private readonly maxWaitMs: number
  private readonly turnTimeoutMs: number | undefined

  constructor(private readonly manager: AgentManager, options: AgentManagerExecutorOptions = {}) {
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
    this.turnTimeoutMs = options.turnTimeoutMs
  }

  async start(request: AgentExecutionRequest): Promise<AgentExecutionHandle> {
    // behavior (resolved): roleId now comes from the Scheduler, which reads it out of
    // StepAggregate.metadata.role (populated by createRunFromWorkflow() from the compiled
    // workflow's per-step `role:` declaration). Requests built by hand (existing tests, or any
    // caller that isn't going through the workflow compiler) may still omit it, so the
    // 'default-worker' fallback is kept for backward compatibility.
    const roleId = request.roleId ?? 'default-worker'

    const handle = await this.manager.spawn({
      roleId,
      cwd: request.worktreePath,
      env: {
        DSH_RUN_ID: request.runId,
        DSH_STEP_ID: request.stepId,
        DSH_ATTEMPT: String(request.attempt),
        DSH_WORKSPACE_ID: request.workspaceId ?? '',
        DSH_WORKTREE_PATH: request.worktreePath ?? '',
        DSH_INPUT_COMMIT: request.inputCommit,
      },
      ...(request.sandbox === undefined ? {} : { sandbox: request.sandbox }),
      ...(request.harness === undefined ? {} : { harness: request.harness }),
    })
    const { agentId } = handle

    const instructions = request.prompt ?? `Execute step ${request.stepId} for run ${request.runId}`

    const close = async (): Promise<void> => {
      // Best effort: a close failure must never mask the completion outcome.
      await Promise.resolve().then(() => this.manager.close(agentId)).catch(() => undefined)
    }

    const completion = new Promise<AgentCompletion>((resolve) => {
      let settled = false
      const settle = (value: AgentCompletion): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
        resolve({ ...value, agentId })
      }
      const timer = setTimeout(() => {
        void close().then(() => settle({ outcome: 'failed', failureCode: 'step_timeout', error: `Agent execution timeout after ${this.maxWaitMs}ms` }))
      }, this.maxWaitMs)
      const onAbort = (): void => {
        void close().then(() => settle({ outcome: 'cancelled', failureCode: 'cancelled', error: 'Agent execution aborted' }))
      }
      if (request.signal?.aborted) {
        onAbort()
        return
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })

      const fail = (error: unknown): void => {
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof ChannelTimeoutError) {
          settle({ outcome: 'failed', failureCode: 'step_timeout', error: message })
        } else if (error instanceof ChannelAbortedError) {
          settle({ outcome: 'cancelled', failureCode: 'cancelled', error: message })
        } else if (PROVIDER_LIMIT.test(message)) {
          settle({ outcome: 'failed', failureCode: 'provider_rate_limited', error: message })
        } else {
          settle({ outcome: 'failed', error: message })
        }
      }
      const chatOptions = {
        signal: request.signal,
        ...(this.turnTimeoutMs === undefined ? {} : { timeoutMs: this.turnTimeoutMs }),
        ...(request.scenario === undefined ? {} : { scenario: request.scenario }),
      }
      this.manager.sendChat(agentId, instructions, chatOptions).then(
        (reply) => {
          try {
            settle(describeReply(reply))
          } catch (error) {
            fail(error)
          }
        },
        fail,
      )
    })

    return {
      wait: () => completion,
      cancel: close,
      dispose: close,
    }
  }
}

/** Facts from the reply that belong in the persisted run record. */
function describeReply(reply: AgentChatReply): AgentCompletion {
  return {
    outcome: 'succeeded',
    summary: reply.text,
    ...(reply.model === undefined ? {} : { model: reply.model }),
    ...(reply.stopReason === undefined ? {} : { stopReason: reply.stopReason }),
    toolCalls: reply.toolCalls.length,
    ...(reply.verification === undefined
      ? {}
      : {
          verification: {
            passed: reply.verification.passed,
            failedRules: reply.verification.results.filter((result) => !result.passed).length,
            totalRules: reply.verification.results.length,
          },
        }),
  }
}
