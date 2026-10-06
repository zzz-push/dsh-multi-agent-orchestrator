import { describe, expect, it } from 'vitest'

import { CancellationService } from '../src/cancellation.js'
import { InMemoryRunLeaseStore } from '../src/repository/lease.js'
import { InMemoryRunRepository } from '../src/repository/in-memory.js'
import { FailureCode, LeaseLostError, RunLeaseHeldError } from '../src/run/errors.js'
import { createRunAggregate, type AgentCompletion, type StepDefinition } from '../src/run/types.js'
import { Scheduler } from '../src/scheduler/scheduler.js'
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

function makeRun(id: string, steps: StepDefinition[], maxParallel?: number) {
  return createRunAggregate({
    id,
    repository: { root: '/repo', baseCommit: 'base' },
    steps,
    workflow: { failureMode: 'stop_after_batch', ...(maxParallel === undefined ? {} : { maxParallel }) },
    now: 1_000,
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

/**
 * An agent per step that runs until released, cancelled, or — for a
 * stubborn one — never. Records how the scheduler treated it.
 */
class ControlledAgents implements AgentExecutor {
  readonly started: AgentExecutionRequest[] = []
  readonly cancelled = new Set<string>()
  readonly disposed = new Set<string>()
  private readonly releases = new Map<string, (completion: AgentCompletion) => void>()
  private readonly startedSignals = new Map<string, () => void>()

  constructor(private readonly stubborn: ReadonlySet<string> = new Set()) {}

  async start(request: AgentExecutionRequest): Promise<AgentExecutionHandle> {
    this.started.push(request)
    this.startedSignals.get(request.stepId)?.()
    const done = deferred<AgentCompletion>()
    this.releases.set(request.stepId, done.resolve)
    const stubborn = this.stubborn.has(request.stepId)
    request.signal?.addEventListener('abort', () => {
      if (!stubborn) done.resolve({ outcome: 'cancelled', failureCode: 'cancelled', error: 'aborted' })
    })
    return {
      wait: () => done.promise,
      cancel: () => { this.cancelled.add(request.stepId) },
      dispose: () => { this.disposed.add(request.stepId) },
    }
  }

  release(stepId: string, completion: AgentCompletion = { outcome: 'succeeded' }): void {
    this.releases.get(stepId)?.(completion)
  }

  whenStarted(stepId: string): Promise<void> {
    if (this.started.some((request) => request.stepId === stepId)) return Promise.resolve()
    return new Promise((resolve) => this.startedSignals.set(stepId, resolve))
  }
}

class RecordingWorkspace implements WorkspaceDriver {
  readonly created: CreateAttemptWorkspace[] = []
  readonly captured: string[] = []
  readonly merges: MergeWorkspaceResult[] = []
  readonly removed: string[] = []
  private integration = 0

  constructor(readonly conflicts: Set<string> = new Set()) {}

  async createAttempt(request: CreateAttemptWorkspace) {
    this.created.push(request)
    return { workspaceId: `ws-${request.stepId}-${request.attempt}`, worktreePath: `/tmp/${request.stepId}` }
  }
  async captureResult(request: { stepId: string; attempt: number }) {
    this.captured.push(`${request.stepId}#${request.attempt}`)
    return { resultCommit: `commit-${request.stepId}-${request.attempt}`, changedPaths: [`${request.stepId}.txt`], diffHash: `diff-${request.stepId}` }
  }
  async mergeResult(request: MergeWorkspaceResult) {
    this.merges.push(request)
    if (this.conflicts.has(request.stepId)) return { merged: false, conflict: `CONFLICT in ${request.stepId}` }
    this.integration += 1
    return { merged: true, integrationCommit: `integration-${this.integration}`, evidence: { step: request.stepId } }
  }
  async removeAttempt(workspaceId: string) {
    this.removed.push(workspaceId)
  }
}

class ControlledChecks implements VerificationDriver {
  readonly requests: CheckRequest[] = []
  constructor(readonly hang: Set<string> = new Set(), readonly failing: Set<string> = new Set()) {}
  async run(check: CheckRequest): Promise<CheckResult> {
    this.requests.push(check)
    if (this.hang.has(check.stepId)) {
      await new Promise<void>((resolve) => check.signal?.addEventListener('abort', () => resolve()))
      return { passed: false, failureMessage: 'killed' }
    }
    if (this.failing.has(check.stepId)) return { passed: false, failureMessage: `check failed for ${check.stepId}` }
    return { passed: true, evidence: { passed: true } }
  }
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('Scheduler: concurrent batches (stage 4)', () => {
  it('runs every step of a batch at the same time, all from the same integration commit', async () => {
    const repository = new InMemoryRunRepository()
    const agents = new ControlledAgents()
    const workspace = new RecordingWorkspace()
    const scheduler = new Scheduler({ repository, agentExecutor: agents, workspaceDriver: workspace, verificationDriver: new ControlledChecks() })
    await repository.create(makeRun('run-1', [{ id: 'a' }, { id: 'b' }, { id: 'c' }], 3))

    const running = scheduler.run('run-1')
    // All three are live before any finishes: nothing waits for a sibling.
    await Promise.all([agents.whenStarted('a'), agents.whenStarted('b'), agents.whenStarted('c')])
    expect(workspace.merges).toHaveLength(0)
    agents.release('c')
    agents.release('a')
    agents.release('b')
    const run = await running

    expect(run.status).toBe('delivery_ready')
    expect(workspace.created.map((request) => request.inputCommit)).toEqual(['base', 'base', 'base'])
    // Merged in declaration order regardless of finishing order, each on the previous one.
    expect(workspace.merges.map((merge) => [merge.stepId, merge.expectedIntegrationCommit])).toEqual([
      ['a', 'base'], ['b', 'integration-1'], ['c', 'integration-2'],
    ])
    expect(workspace.merges.every((merge) => merge.repositoryRoot === '/repo')).toBe(true)
    expect(run.integration.commit).toBe('integration-3')
  })

  it('starts the next batch from the advanced integration commit', async () => {
    const repository = new InMemoryRunRepository()
    const workspace = new RecordingWorkspace()
    const scheduler = new Scheduler({ repository, workspaceDriver: workspace })
    await repository.create(makeRun('run-1', [{ id: 'a' }, { id: 'b', dependsOn: ['a'] }]))

    const run = await scheduler.run('run-1')

    expect(run.status).toBe('delivery_ready')
    expect(workspace.created.map((request) => [request.stepId, request.inputCommit])).toEqual([['a', 'base'], ['b', 'integration-1']])
  })

  it('stops merging at a conflict and leaves later results queued, in declaration order', async () => {
    const repository = new InMemoryRunRepository()
    const workspace = new RecordingWorkspace(new Set(['b']))
    const scheduler = new Scheduler({ repository, workspaceDriver: workspace })
    await repository.create(makeRun('run-1', [{ id: 'a' }, { id: 'b' }, { id: 'c' }], 3))

    const run = await scheduler.run('run-1')

    expect(run.status).toBe('waiting_action')
    expect(run.steps.a.status).toBe('merged')
    expect(run.steps.b.status).toBe('merge_conflict')
    expect(run.steps.b.failure).toMatchObject({ code: FailureCode.MergeConflict, message: 'CONFLICT in b' })
    expect(run.steps.c.status).toBe('merge_queued')
    expect(workspace.merges.map((merge) => merge.stepId)).toEqual(['a', 'b'])
  })

  it('retryStep: re-runs a failed step from the current integration commit, then merges it and the results held behind it in order', async () => {
    const repository = new InMemoryRunRepository()
    const workspace = new RecordingWorkspace()
    const checks = new ControlledChecks(new Set(), new Set(['a']))
    const scheduler = new Scheduler({ repository, workspaceDriver: workspace, verificationDriver: checks })
    await repository.create(makeRun('run-1', [{ id: 'a' }, { id: 'b' }], 2))

    const first = await scheduler.run('run-1')
    expect(first.steps.a.status).toBe('failed')
    expect(first.steps.b.status).toBe('merge_queued')
    expect(workspace.merges).toHaveLength(0)

    const retried = await scheduler.retryStep('run-1', 'a')
    expect(retried.steps.a.status).toBe('ready')
    expect(retried.steps.a.failure).toBeUndefined()

    checks.failing.delete('a')
    const second = await scheduler.run('run-1')
    expect(second.status).toBe('delivery_ready')
    expect(second.steps.a.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'completed'])
    expect(workspace.merges.map((merge) => merge.stepId)).toEqual(['a', 'b'])
  })

  it('retryStep: a conflicted step goes back to ready and runs again on top of what did merge', async () => {
    const repository = new InMemoryRunRepository()
    const workspace = new RecordingWorkspace(new Set(['b']))
    const scheduler = new Scheduler({ repository, workspaceDriver: workspace })
    await repository.create(makeRun('run-1', [{ id: 'a' }, { id: 'b' }], 2))
    await scheduler.run('run-1')

    await scheduler.retryStep('run-1', 'b')
    workspace.conflicts.delete('b')
    const run = await scheduler.run('run-1')

    expect(run.status).toBe('delivery_ready')
    expect(run.steps.b.attempts).toHaveLength(2)
    expect(run.steps.b.attempts[1]?.inputCommit).toBe('integration-1')
  })
})

describe('Scheduler: cancellation stops real resources', () => {
  it('cancel() aborts running agents, captures their worktrees as evidence, and finalizes to cancelled', async () => {
    const repository = new InMemoryRunRepository()
    const agents = new ControlledAgents()
    const workspace = new RecordingWorkspace()
    const scheduler = new Scheduler({ repository, agentExecutor: agents, workspaceDriver: workspace })
    await repository.create(makeRun('run-1', [{ id: 'a' }, { id: 'b' }, { id: 'c', dependsOn: ['a'] }], 2))

    const running = scheduler.run('run-1')
    await Promise.all([agents.whenStarted('a'), agents.whenStarted('b')])
    const intent = await scheduler.cancel('run-1')
    expect(intent.status).toBe('cancelling')
    const run = await running

    expect(run.status).toBe('cancelled')
    expect(run.finishedAt).toBeDefined()
    expect(agents.started.every((request) => request.signal?.aborted === true)).toBe(true)
    expect([...agents.cancelled].sort()).toEqual(['a', 'b'])
    expect([...agents.disposed].sort()).toEqual(['a', 'b'])
    for (const id of ['a', 'b']) {
      expect(run.steps[id]?.status).toBe('cancelled')
      expect(run.steps[id]?.attempts[0]).toMatchObject({ status: 'cancelled', evidence: { passed: false, changedPaths: [`${id}.txt`] } })
    }
    // Never started, never merged; worktrees removed.
    expect(run.steps.c.status).toBe('pending')
    expect(workspace.merges).toHaveLength(0)
    expect(workspace.removed.sort()).toEqual(['ws-a-1', 'ws-b-1'])
  })

  it('notices a cancellation requested elsewhere (another process) and aborts the checks that are running', async () => {
    const repository = new InMemoryRunRepository()
    const checks = new ControlledChecks(new Set(['a']))
    const scheduler = new Scheduler({ repository, verificationDriver: checks, pollIntervalMs: 10 })
    await repository.create(makeRun('run-1', [{ id: 'a' }]))

    const running = scheduler.run('run-1')
    await until(() => checks.requests.length === 1)
    // Only the run document is shared with whoever cancels.
    await new CancellationService(repository).request('run-1')
    const run = await running

    expect(checks.requests[0]?.signal?.aborted).toBe(true)
    expect(run.status).toBe('cancelled')
    expect(run.steps.a.status).toBe('cancelled')
  })

  it('ends interrupted, not cancelled, when an agent does not stop within the grace period — and refuses its late writes', async () => {
    const repository = new InMemoryRunRepository()
    const agents = new ControlledAgents(new Set(['a']))
    const scheduler = new Scheduler({ repository, agentExecutor: agents, cancelGraceMs: 50 })
    await repository.create(makeRun('run-1', [{ id: 'a' }]))

    const running = scheduler.run('run-1')
    await agents.whenStarted('a')
    await scheduler.cancel('run-1')
    const run = await running

    expect(run.status).toBe('interrupted')
    expect(run.failure).toMatchObject({ code: FailureCode.Interrupted })
    expect(run.failure?.message).toMatch(/a did not stop within 50ms/)
    expect(run.steps.a.status).toBe('interrupted')
    expect(agents.cancelled.has('a')).toBe(true)

    // The agent finally returns: nothing it reports lands on the run.
    const revision = run.revision
    agents.release('a')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((await repository.get('run-1'))?.revision).toBe(revision)
  })

  it('cancel() on a run nobody is advancing finalizes it directly', async () => {
    const repository = new InMemoryRunRepository()
    const scheduler = new Scheduler({ repository, verificationDriver: new ControlledChecks(new Set(), new Set(['a'])) })
    await repository.create(makeRun('run-1', [{ id: 'a' }, { id: 'b' }], 2))
    expect((await scheduler.run('run-1')).status).toBe('waiting_action')

    const run = await scheduler.cancel('run-1')

    expect(run.status).toBe('cancelled')
    expect(run.steps.a.status).toBe('failed')
    expect(run.steps.b.status).toBe('cancelled')
  })
})

describe('Scheduler: one owner per run across schedulers', () => {
  it('refuses a run another scheduler holds the lease on, and frees the lease when done', async () => {
    const repository = new InMemoryRunRepository()
    const leases = new InMemoryRunLeaseStore()
    const agents = new ControlledAgents()
    const first = new Scheduler({ repository, agentExecutor: agents, leases, owner: 'first' })
    const second = new Scheduler({ repository, agentExecutor: agents, leases, owner: 'second' })
    await repository.create(makeRun('run-1', [{ id: 'a' }]))

    const running = first.run('run-1')
    await agents.whenStarted('a')
    await expect(second.run('run-1')).rejects.toBeInstanceOf(RunLeaseHeldError)
    expect(await leases.get('run-1')).toMatchObject({ owner: 'first', token: 1 })

    agents.release('a')
    expect((await running).status).toBe('delivery_ready')
    expect((await leases.get('run-1'))?.expiresAt).toBe(0)
    // Free again: another scheduler can pick the run up (it is already done).
    expect((await second.run('run-1')).status).toBe('delivery_ready')
  })

  it('renews its lease while it works, so a long step does not lose the run', async () => {
    const repository = new InMemoryRunRepository()
    const leases = new InMemoryRunLeaseStore()
    const agents = new ControlledAgents()
    // TTL well above timer jitter under a loaded test run, and a wait of
    // several TTLs: without renewal the lease would certainly have expired.
    const scheduler = new Scheduler({ repository, agentExecutor: agents, leases, owner: 'owner', leaseTtlMs: 300 })
    await repository.create(makeRun('run-1', [{ id: 'a' }]))

    const running = scheduler.run('run-1')
    await agents.whenStarted('a')
    const firstExpiry = (await leases.get('run-1'))!.expiresAt
    await new Promise((resolve) => setTimeout(resolve, 900))
    expect((await leases.get('run-1'))!.expiresAt).toBeGreaterThan(firstExpiry)
    expect(await leases.acquire('run-1', 'intruder', 1_000)).toBeUndefined()
    agents.release('a')
    expect((await running).status).toBe('delivery_ready')
  })

  it('stops, without writing, when its lease is taken over', async () => {
    const repository = new InMemoryRunRepository()
    const leases = new InMemoryRunLeaseStore()
    const agents = new ControlledAgents()
    const scheduler = new Scheduler({ repository, agentExecutor: agents, leases, owner: 'stale', leaseTtlMs: 30 })
    await repository.create(makeRun('run-1', [{ id: 'a' }]))

    const running = scheduler.run('run-1')
    await agents.whenStarted('a')
    const before = (await repository.get('run-1'))!.revision
    // Simulate the owner having been unable to renew: the lease is given to someone else.
    const held = (await leases.get('run-1'))!
    await leases.release(held)
    await leases.acquire('run-1', 'new-owner', 60_000)

    await expect(running).rejects.toBeInstanceOf(LeaseLostError)
    expect(agents.cancelled.has('a')).toBe(true)
    expect((await repository.get('run-1'))!.revision).toBe(before)
  })
})

describe('Scheduler: recovering a run whose scheduler died', () => {
  it('marks steps left running as interrupted instead of leaving them stuck, and lets them be retried', async () => {
    const repository = new InMemoryRunRepository()
    const workspace = new RecordingWorkspace()
    const scheduler = new Scheduler({ repository, workspaceDriver: workspace })
    const run = makeRun('run-1', [{ id: 'a' }, { id: 'b' }], 2)
    // What a crashed owner leaves behind: the run mid-batch, one step still "running".
    await repository.create({
      ...run,
      status: 'running',
      steps: {
        a: { ...run.steps.a, status: 'running', batch: 1, attempts: [{ attempt: 1, status: 'running', inputCommit: 'base', completions: [], startedAt: 1_000, workspaceId: 'ws-dead', worktreePath: '/tmp/dead' }] },
        b: { ...run.steps.b, status: 'merge_queued', batch: 1, resultCommit: 'commit-b-1', attempts: [{ attempt: 1, status: 'completed', inputCommit: 'base', completions: [], startedAt: 1_000, resultCommit: 'commit-b-1' }] },
      },
      integration: { ...run.integration, batch: 1 },
    })

    const recovered = await scheduler.run('run-1')
    expect(recovered.status).toBe('waiting_action')
    expect(recovered.steps.a.status).toBe('interrupted')
    expect(recovered.steps.a.failure).toMatchObject({ code: FailureCode.Interrupted, retryable: true })
    expect(recovered.steps.a.attempts[0]).toMatchObject({ status: 'interrupted', worktreePath: '/tmp/dead' })
    // b is ordered after a: it waits.
    expect(recovered.steps.b.status).toBe('merge_queued')

    await scheduler.retryStep('run-1', 'a')
    const finished = await scheduler.run('run-1')
    expect(finished.status).toBe('delivery_ready')
    expect(finished.steps.a.attempts.map((attempt) => attempt.status)).toEqual(['interrupted', 'completed'])
    expect(workspace.merges.map((merge) => merge.stepId)).toEqual(['a', 'b'])
  })
})

describe('Scheduler: step-declared checks', () => {
  it('hands a compiled step\'s checks to the verification driver, and none when the step declares none', async () => {
    const repository = new InMemoryRunRepository()
    const checks = new ControlledChecks()
    const scheduler = new Scheduler({ repository, verificationDriver: checks })
    await repository.create(makeRun('run-1', [
      { id: 'a', metadata: { checks: [{ id: 'test', command: ['pnpm', 'test'], cwd: '.', timeout_seconds: 60, env_allow: ['CI'], required: true }, { id: 'broken' }] } },
      { id: 'b', dependsOn: ['a'] },
    ]))
    await scheduler.run('run-1')
    expect(checks.requests.map((request) => request.commands)).toEqual([
      [{ id: 'test', command: ['pnpm', 'test'], cwd: '.', timeoutSeconds: 60, envAllow: ['CI'], required: true }],
      undefined,
    ])
  })
})

describe('Scheduler: what a step may change', () => {
  it('fails a step whose candidate changed paths outside its policy, and never merges it', async () => {
    const repository = new InMemoryRunRepository()
    const workspace = new RecordingWorkspace()
    const scheduler = new Scheduler({ repository, workspaceDriver: workspace })
    await repository.create(makeRun('run-1', [
      // RecordingWorkspace reports `<stepId>.txt` as the change.
      { id: 'a', metadata: { mode: 'write', paths: { allow_changes: ['docs/**'], deny_changes: [] } } },
      { id: 'b', metadata: { mode: 'write', paths: { allow_changes: ['b.txt'], deny_changes: [] } } },
      { id: 'c', metadata: { mode: 'write', paths: { allow_changes: [], deny_changes: ['c.txt'] } } },
    ], 3))

    const run = await scheduler.run('run-1')

    expect(run.steps.a.status).toBe('failed')
    expect(run.steps.a.failure).toMatchObject({ code: FailureCode.PolicyViolation, message: 'Step a changed path(s) outside allow_changes: a.txt' })
    expect(run.steps.a.attempts[0]?.evidence).toMatchObject({ passed: false, changedPaths: ['a.txt'] })
    expect(run.steps.b.status).toBe('merge_queued')
    expect(run.steps.c.failure?.message).toBe('Step c changed denied path(s): c.txt')
    expect(workspace.merges).toHaveLength(0)
  })

  it('fails a read-only step that changed files, and a compiled write step that changed none', async () => {
    const repository = new InMemoryRunRepository()
    class Empty extends RecordingWorkspace {
      override async captureResult(request: { stepId: string; attempt: number }) {
        const result = await super.captureResult(request)
        return request.stepId === 'w' ? { ...result, changedPaths: [] } : result
      }
    }
    const scheduler = new Scheduler({ repository, workspaceDriver: new Empty() })
    await repository.create(makeRun('run-1', [
      { id: 'r', readOnly: true, metadata: { mode: 'read' } },
      { id: 'w', metadata: { mode: 'write' } },
      // Not a compiled write step (no mode): an empty diff is not judged here.
      { id: 'x' },
    ], 3))

    const run = await scheduler.run('run-1')

    expect(run.steps.r.failure?.message).toBe('Read-only step changed 1 file(s): r.txt')
    expect(run.steps.w.failure?.message).toBe('Write step produced no changes')
    expect(run.steps.x.status).toBe('merge_queued')
  })

  it('lets a write step that may find nothing to change end succeeded without a merge', async () => {
    const repository = new InMemoryRunRepository()
    class Empty extends RecordingWorkspace {
      override async captureResult(request: { stepId: string; attempt: number }) {
        return { ...(await super.captureResult(request)), changedPaths: [] }
      }
    }
    const workspace = new Empty()
    const scheduler = new Scheduler({ repository, workspaceDriver: workspace })
    await repository.create(makeRun('run-1', [{ id: 'docs', metadata: { mode: 'write', policy: { allow_no_changes: true } } }]))

    const run = await scheduler.run('run-1')

    expect(run.status).toBe('delivery_ready')
    expect(run.steps.docs.status).toBe('succeeded')
    expect(workspace.merges).toHaveLength(0)
  })
})
