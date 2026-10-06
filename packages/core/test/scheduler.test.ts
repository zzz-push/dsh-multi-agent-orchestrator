import { describe, expect, it } from 'vitest'
import { Scheduler } from '../src/scheduler/scheduler.js'
import { requestCancellation } from '../src/cancellation.js'
import { InMemoryRunRepository } from '../src/repository/in-memory.js'
import { FailureCode } from '../src/run/errors.js'
import { createRunAggregate, type AgentCompletion, type StepDefinition } from '../src/run/types.js'
import type {
  AgentExecutionHandle,
  AgentExecutionRequest,
  AgentExecutor,
  CheckRequest,
  CheckResult,
  CreateAttemptWorkspace,
  MergeWorkspaceResult,
  VerificationDriver,
  WorkspaceDriver,
} from '../src/ports.js'
import type { Clock } from '../src/ports.js'

class FakeAgentExecutor implements AgentExecutor {
  readonly started: AgentExecutionRequest[] = []
  async start(request: AgentExecutionRequest): Promise<AgentExecutionHandle> {
    this.started.push(request)
    return { wait: async () => ({ outcome: 'succeeded' }) }
  }
}

class FakeWorkspaceDriver implements WorkspaceDriver {
  readonly removed: string[] = []
  async createAttempt(request: CreateAttemptWorkspace) {
    return { workspaceId: `ws-${request.stepId}-${request.attempt}`, worktreePath: `/tmp/${request.stepId}` }
  }
  async captureResult() {
    return { resultCommit: 'captured-commit' }
  }
  async mergeResult(request: MergeWorkspaceResult) {
    return { merged: true, integrationCommit: request.resultCommit }
  }
  async removeAttempt(workspaceId: string) {
    this.removed.push(workspaceId)
  }
}

class FakeVerificationDriver implements VerificationDriver {
  constructor(private readonly failingSteps: ReadonlySet<string> = new Set()) {}
  async run(check: CheckRequest): Promise<CheckResult> {
    if (this.failingSteps.has(check.stepId)) return { passed: false, failureMessage: `verification failed for ${check.stepId}` }
    return { passed: true, evidence: { passed: true } }
  }
}

function fixedClock(startAt: number): Clock & { advance(ms: number): void } {
  let now = startAt
  return { now: () => now, advance: (ms: number) => { now += ms } }
}

function makeRun(id: string, steps: StepDefinition[], opts: { maxParallel?: number; deadlineAt?: number } = {}) {
  return createRunAggregate({
    id,
    repository: { root: '/repo', baseCommit: 'base' },
    steps,
    workflow: { ...(opts.maxParallel === undefined ? {} : { maxParallel: opts.maxParallel }), failureMode: 'stop_after_batch' },
    budget: opts.deadlineAt === undefined ? undefined : { deadlineAt: opts.deadlineAt },
    now: 1_000,
  })
}

describe('Scheduler', () => {
  it('runs an independent step then a dependent step to delivery_ready, merging both', async () => {
    const repository = new InMemoryRunRepository()
    const agentExecutor = new FakeAgentExecutor()
    const workspaceDriver = new FakeWorkspaceDriver()
    const verificationDriver = new FakeVerificationDriver()
    const scheduler = new Scheduler({ repository, agentExecutor, workspaceDriver, verificationDriver })

    await repository.create(makeRun('run-1', [{ id: 'a' }, { id: 'b', dependsOn: ['a'] }]))
    const result = await scheduler.run('run-1')

    expect(result.status).toBe('delivery_ready')
    expect(result.steps.a.status).toBe('merged')
    expect(result.steps.b.status).toBe('merged')
    expect(result.steps.a.batch).toBe(1)
    expect(result.steps.b.batch).toBe(2)
    expect(agentExecutor.started.map((request) => request.stepId)).toEqual(['a', 'b'])
  })

  it('keeps both verification checks and captured changedPaths/diffHash on the attempt evidence', async () => {
    const repository = new InMemoryRunRepository()
    class EvidenceWorkspaceDriver extends FakeWorkspaceDriver {
      override async captureResult() {
        return {
          resultCommit: 'captured-commit',
          changedPaths: ['src/a.ts', 'test/a.test.ts'],
          diffHash: 'diff-123',
          evidence: { passed: true, changedPaths: ['src/a.ts', 'test/a.test.ts'], diffHash: 'diff-123' },
        }
      }
    }
    class CheckingVerificationDriver implements VerificationDriver {
      async run(): Promise<CheckResult> {
        return { passed: true, evidence: { passed: true, checks: [{ name: 'pnpm test', exitCode: 0, durationMs: 42 }] } }
      }
    }
    const scheduler = new Scheduler({
      repository,
      agentExecutor: new FakeAgentExecutor(),
      workspaceDriver: new EvidenceWorkspaceDriver(),
      verificationDriver: new CheckingVerificationDriver(),
      clock: fixedClock(),
    })
    await repository.create(makeRun('run-1', [{ id: 'a' }]))
    const result = await scheduler.run('run-1')
    // Before: `verification.evidence ?? captured?.evidence` kept the checks and lost the diff.
    expect(result.steps.a?.attempts[0]?.evidence).toEqual({
      passed: true,
      checks: [{ name: 'pnpm test', exitCode: 0, durationMs: 42 }],
      changedPaths: ['src/a.ts', 'test/a.test.ts'],
      diffHash: 'diff-123',
    })
  })

  it('keeps the verification evidence on a failed attempt so the failing check output is not lost', async () => {
    const repository = new InMemoryRunRepository()
    class FailingVerificationDriver implements VerificationDriver {
      async run(): Promise<CheckResult> {
        return {
          passed: false,
          failureMessage: 'Check "test" exited with code 1',
          evidence: { passed: false, checks: [{ name: 'test', exitCode: 1, outputSummary: '1 failed' }] },
        }
      }
    }
    const scheduler = new Scheduler({
      repository,
      agentExecutor: new FakeAgentExecutor(),
      workspaceDriver: new FakeWorkspaceDriver(),
      verificationDriver: new FailingVerificationDriver(),
      clock: fixedClock(),
    })
    await repository.create(makeRun('run-1', [{ id: 'a' }]))
    const result = await scheduler.run('run-1')
    expect(result.steps.a?.status).toBe('failed')
    expect(result.steps.a?.attempts[0]).toMatchObject({
      status: 'failed',
      evidence: { passed: false, checks: [{ name: 'test', exitCode: 1, outputSummary: '1 failed' }] },
    })
  })

  it('marks a step merge_conflict (not failed) when the merge does not land, keeping the completed attempt', async () => {
    const repository = new InMemoryRunRepository()
    class ConflictingWorkspaceDriver extends FakeWorkspaceDriver {
      override async mergeResult() {
        return { merged: false, conflict: 'CONFLICT (content): README.md' }
      }
    }
    const scheduler = new Scheduler({
      repository,
      agentExecutor: new FakeAgentExecutor(),
      workspaceDriver: new ConflictingWorkspaceDriver(),
      verificationDriver: new FakeVerificationDriver(),
      clock: fixedClock(),
    })
    await repository.create(makeRun('run-1', [{ id: 'a' }]))
    // Before the fix this threw InvalidTransitionError (merge_queued -> failed) from inside the merge path.
    const result = await scheduler.run('run-1')
    expect(result.steps.a?.status).toBe('merge_conflict')
    expect(result.steps.a?.failure).toMatchObject({ code: 'merge_conflict', message: 'CONFLICT (content): README.md', retryable: true })
    expect(result.steps.a?.attempts[0]).toMatchObject({ status: 'completed', resultCommit: 'captured-commit' })
    expect(result.status).toBe('waiting_action')
  })

  it('defaults the integration ref to the refs/dsh-orchestrator namespace the Git driver accepts', () => {
    expect(makeRun('run-x', [{ id: 'a' }]).integration.ref).toBe('refs/dsh-orchestrator/runs/run-x/integration')
  })

  it('caps batch size at the min of workflow maxParallel and global maxParallel', async () => {
    const repository = new InMemoryRunRepository()
    const agentExecutor = new FakeAgentExecutor()
    const workspaceDriver = new FakeWorkspaceDriver()
    const verificationDriver = new FakeVerificationDriver()
    const scheduler = new Scheduler({ repository, agentExecutor, workspaceDriver, verificationDriver, globalMaxParallel: 2 })

    await repository.create(makeRun('run-1', [{ id: 'a' }, { id: 'b' }, { id: 'c' }], { maxParallel: 5 }))
    const result = await scheduler.run('run-1')

    expect(result.status).toBe('delivery_ready')
    expect(result.steps.a.batch).toBe(1)
    expect(result.steps.b.batch).toBe(1)
    expect(result.steps.c.batch).toBe(2)
    expect(result.integration.batch).toBe(2)
  })

  it('stop_after_batch: a failing step does not cancel its independent batch-mates, but blocks the next batch and holds back their merge', async () => {
    const repository = new InMemoryRunRepository()
    const agentExecutor = new FakeAgentExecutor()
    const workspaceDriver = new FakeWorkspaceDriver()
    const verificationDriver = new FakeVerificationDriver(new Set(['a']))
    const scheduler = new Scheduler({ repository, agentExecutor, workspaceDriver, verificationDriver, globalMaxParallel: 2 })

    await repository.create(makeRun('run-1', [{ id: 'a' }, { id: 'b' }, { id: 'c' }], { maxParallel: 2 }))
    const result = await scheduler.run('run-1')

    expect(result.status).toBe('waiting_action')
    expect(result.steps.a.status).toBe('failed')
    expect(result.steps.a.failure?.code).toBe(FailureCode.VerificationFailed)
    // b passed, but a comes first in declaration order: the integration line
    // only advances in that order, so b waits for a to be resolved.
    expect(result.steps.b.status).toBe('merge_queued')
    expect(result.steps.c.status).toBe('pending')
    expect(result.integration.batch).toBe(1)
  })

  it('never folds a failed step into succeeded', async () => {
    const repository = new InMemoryRunRepository()
    const verificationDriver = new FakeVerificationDriver(new Set(['a']))
    const scheduler = new Scheduler({ repository, verificationDriver })

    await repository.create(makeRun('run-1', [{ id: 'a' }]))
    const result = await scheduler.run('run-1')

    expect(result.steps.a.status).not.toBe('succeeded')
    expect(result.steps.a.status).toBe('failed')
  })

  it('fails the run when the deadline has already passed, without starting any step', async () => {
    const repository = new InMemoryRunRepository()
    const agentExecutor = new FakeAgentExecutor()
    const clock = fixedClock(10_000)
    const scheduler = new Scheduler({ repository, agentExecutor, clock })

    await repository.create(makeRun('run-1', [{ id: 'a' }], { deadlineAt: 5_000 }))
    const result = await scheduler.run('run-1')

    expect(result.status).toBe('failed')
    expect(result.failure?.code).toBe(FailureCode.BudgetExceeded)
    expect(result.finishedAt).toBe(10_000)
    expect(agentExecutor.started).toHaveLength(0)
  })

  it('does not create new steps for a run already in a terminal status', async () => {
    const repository = new InMemoryRunRepository()
    const agentExecutor = new FakeAgentExecutor()
    const scheduler = new Scheduler({ repository, agentExecutor })

    const run = makeRun('run-1', [{ id: 'a' }])
    await repository.create({ ...run, status: 'applied', steps: { a: { ...run.steps.a, status: 'merged' } } })
    const result = await scheduler.run('run-1')

    expect(result.status).toBe('applied')
    expect(agentExecutor.started).toHaveLength(0)
  })

  it('finalizes a cancellation request into the cancelled terminal state without starting steps', async () => {
    const repository = new InMemoryRunRepository()
    const agentExecutor = new FakeAgentExecutor()
    const scheduler = new Scheduler({ repository, agentExecutor })

    await repository.create(makeRun('run-1', [{ id: 'a' }]))
    await requestCancellation(repository, 'run-1')
    const result = await scheduler.run('run-1')

    expect(result.status).toBe('cancelled')
    expect(result.finishedAt).toBeDefined()
    expect(agentExecutor.started).toHaveLength(0)
  })

  it('rejects a second concurrent in-process scheduling call for the same run', async () => {
    const repository = new InMemoryRunRepository()
    let resolveWait!: (value: { outcome: 'succeeded' }) => void
    const waitPromise = new Promise<{ outcome: 'succeeded' }>((resolve) => { resolveWait = resolve })
    const agentExecutor: AgentExecutor = {
      start: async () => ({ wait: () => waitPromise }),
    }
    const scheduler = new Scheduler({ repository, agentExecutor })
    await repository.create(makeRun('run-1', [{ id: 'a' }]))

    const first = scheduler.run('run-1')
    await expect(scheduler.run('run-1')).rejects.toThrow('Scheduler already owns run run-1')
    resolveWait({ outcome: 'succeeded' })
    await first
  })

  it('passes roleId and prompt from step metadata through to the AgentExecutor', async () => {
    const repository = new InMemoryRunRepository()
    const agentExecutor = new FakeAgentExecutor()
    const scheduler = new Scheduler({ repository, agentExecutor })

    await repository.create(makeRun('run-1', [
      { id: 'a', metadata: { role: 'implementer', instructions: 'do the thing' } },
    ]))
    await scheduler.run('run-1')

    expect(agentExecutor.started).toHaveLength(1)
    expect(agentExecutor.started[0]?.roleId).toBe('implementer')
    expect(agentExecutor.started[0]?.prompt).toBe('do the thing')
  })

  it('fails the step without running checks when the agent completion is not succeeded, keeping the captured worktree as evidence', async () => {
    class CutOffExecutor implements AgentExecutor {
      constructor(private readonly completion: AgentCompletion) {}
      async start(): Promise<AgentExecutionHandle> {
        return { wait: async () => this.completion }
      }
    }
    class CountingVerification implements VerificationDriver {
      runs = 0
      async run(): Promise<CheckResult> {
        this.runs += 1
        return { passed: true, evidence: { passed: true } }
      }
    }
    class CapturingDriver extends FakeWorkspaceDriver {
      override async captureResult() {
        return { resultCommit: 'partial-commit', changedPaths: ['half.ts'], diffHash: 'abc' }
      }
    }
    const cases: Array<{ completion: AgentCompletion; code: FailureCode; message: string }> = [
      { completion: { outcome: 'failed', failureCode: 'step_timeout', error: 'sendChat timed out after 10 ms' }, code: FailureCode.StepTimeout, message: 'sendChat timed out after 10 ms' },
      { completion: { outcome: 'cancelled', error: 'aborted' }, code: FailureCode.Cancelled, message: 'aborted' },
      { completion: { outcome: 'blocked', summary: 'cannot proceed without credentials' }, code: FailureCode.AgentFailed, message: 'cannot proceed without credentials' },
      { completion: { outcome: 'failed' }, code: FailureCode.AgentFailed, message: 'Agent completion outcome: failed' },
    ]
    for (const { completion, code, message } of cases) {
      const repository = new InMemoryRunRepository()
      const verificationDriver = new CountingVerification()
      const scheduler = new Scheduler({ repository, agentExecutor: new CutOffExecutor(completion), workspaceDriver: new CapturingDriver(), verificationDriver })
      await repository.create(makeRun('run-1', [{ id: 'a' }]))
      const result = await scheduler.run('run-1')

      expect(result.status).toBe('waiting_action')
      const step = result.steps['a']!
      expect(step.status).toBe('failed')
      expect(step.failure?.code).toBe(code)
      expect(step.failure?.message).toBe(message)
      expect(verificationDriver.runs).toBe(0)
      const attempt = step.attempts[0]!
      expect(attempt.status).toBe('failed')
      expect(attempt.completions[0]?.value).toEqual(completion)
      expect(attempt.evidence).toEqual({ passed: false, changedPaths: ['half.ts'], diffHash: 'abc' })
      expect(attempt.resultCommit).toBeUndefined()
    }
  })

  it('treats a completion without an outcome as succeeded (executors that predate the field)', async () => {
    class LegacyExecutor implements AgentExecutor {
      async start(): Promise<AgentExecutionHandle> {
        return { wait: async () => ({ summary: 'done' }) }
      }
    }
    const repository = new InMemoryRunRepository()
    const scheduler = new Scheduler({ repository, agentExecutor: new LegacyExecutor(), workspaceDriver: new FakeWorkspaceDriver(), verificationDriver: new FakeVerificationDriver() })
    await repository.create(makeRun('run-1', [{ id: 'a' }]))
    const result = await scheduler.run('run-1')
    expect(result.status).toBe('delivery_ready')
    expect(result.steps['a']?.status).toBe('merged')
  })

  it('passes a sandbox from step metadata through to the AgentExecutor, and omits it otherwise', async () => {
    const repository = new InMemoryRunRepository()
    const agentExecutor = new FakeAgentExecutor()
    const scheduler = new Scheduler({ repository, agentExecutor })

    await repository.create(makeRun('run-1', [
      { id: 'a', metadata: { role: 'implementer', instructions: 'x', sandbox: 'workspace-write', harness: 'claude-code' } },
      { id: 'b', metadata: { role: 'implementer', instructions: 'y' } },
    ]))
    await scheduler.run('run-1')

    expect(agentExecutor.started.map((request) => request.sandbox)).toEqual(['workspace-write', undefined])
    expect(agentExecutor.started.map((request) => request.harness)).toEqual(['claude-code', undefined])
  })

  it('leaves roleId and prompt undefined for a step with no metadata, without throwing', async () => {
    const repository = new InMemoryRunRepository()
    const agentExecutor = new FakeAgentExecutor()
    const scheduler = new Scheduler({ repository, agentExecutor })

    await repository.create(makeRun('run-1', [{ id: 'a' }]))
    const result = await scheduler.run('run-1')

    expect(result.status).toBe('delivery_ready')
    expect(agentExecutor.started).toHaveLength(1)
    expect(agentExecutor.started[0]?.roleId).toBeUndefined()
    expect(agentExecutor.started[0]?.prompt).toBeUndefined()
  })

  it('deduplicates startRun calls sharing an idempotency key and input hash', async () => {
    const repository = new InMemoryRunRepository()
    const agentExecutor = new FakeAgentExecutor()
    const { IdempotencyRegistry } = await import('../src/scheduler/idempotency.js')
    const idempotency = new IdempotencyRegistry()
    const scheduler = new Scheduler({ repository, agentExecutor, idempotency })

    const run = makeRun('run-1', [{ id: 'a' }])
    const runWithKey = { ...run, idempotencyKey: 'key-1', workflowHash: 'hash-1' }
    const first = await scheduler.startRun(runWithKey)
    const second = await scheduler.startRun({ ...run, id: 'run-2', idempotencyKey: 'key-1', workflowHash: 'hash-1' })

    expect(second.id).toBe(first.id)
    expect(await repository.get('run-2')).toBeUndefined()
  })
})
