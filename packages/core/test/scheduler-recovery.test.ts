import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { FileRunRepository } from '../src/repository/file.js'
import { FileRunLeaseStore } from '../src/repository/file-lease.js'
import { InMemoryRunRepository } from '../src/repository/in-memory.js'
import { InMemoryRunLeaseStore } from '../src/repository/lease.js'
import { FailureCode, RunLeaseHeldError } from '../src/run/errors.js'
import { createRunAggregate, type RunAggregate, type StepAggregate } from '../src/run/types.js'
import { Scheduler } from '../src/scheduler/scheduler.js'
import type {
  AgentExecutionHandle,
  AgentExecutionRequest,
  AgentExecutor,
  Clock,
  CreateAttemptWorkspace,
  MergeWorkspaceResult,
  WorkspaceDriver,
} from '../src/ports.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function manualClock(start: number): Clock & { advance(ms: number): void } {
  let now = start
  return { now: () => now, advance: (ms) => { now += ms } }
}

class CountingAgents implements AgentExecutor {
  readonly started: AgentExecutionRequest[] = []
  async start(request: AgentExecutionRequest): Promise<AgentExecutionHandle> {
    this.started.push(request)
    return { wait: async () => ({ outcome: 'succeeded', summary: `done ${request.stepId}` }) }
  }
}

class Workspace implements WorkspaceDriver {
  readonly merges: string[] = []
  private integration = 0
  async createAttempt(request: CreateAttemptWorkspace) {
    return { workspaceId: `ws-${request.stepId}-${request.attempt}`, worktreePath: `/tmp/${request.stepId}` }
  }
  async captureResult(request: { stepId: string; attempt: number }) {
    return { resultCommit: `commit-${request.stepId}-${request.attempt}`, changedPaths: [`${request.stepId}.txt`] }
  }
  async mergeResult(request: MergeWorkspaceResult) {
    this.merges.push(request.stepId)
    this.integration += 1
    return { merged: true, integrationCommit: `integration-${this.integration}` }
  }
  async removeAttempt() {}
}

const T0 = 1_000_000

/**
 * What a scheduler that died mid-run leaves behind: `c` merged in the first
 * batch, then `a` still "running" and `b` verified but not merged in the
 * second.
 */
function abandonedRun(id: string, overrides: Partial<RunAggregate> = {}): RunAggregate {
  const run = createRunAggregate({
    id,
    repository: { root: '/repo', baseCommit: 'base' },
    steps: [{ id: 'c' }, { id: 'a', dependsOn: ['c'] }, { id: 'b', dependsOn: ['c'] }],
    workflow: { failureMode: 'stop_after_batch', maxParallel: 2 },
    now: T0,
  })
  const step = (id: string, patch: Partial<StepAggregate>): StepAggregate => ({ ...run.steps[id]!, ...patch })
  return {
    ...run,
    status: 'running',
    steps: {
      c: step('c', { status: 'merged', batch: 1, resultCommit: 'commit-c-1', attempts: [{ attempt: 1, status: 'completed', inputCommit: 'base', completions: [], resultCommit: 'commit-c-1' }] }),
      a: step('a', { status: 'running', batch: 2, attempts: [{ attempt: 1, status: 'running', inputCommit: 'integration-0', completions: [], startedAt: T0, workspaceId: 'ws-dead', worktreePath: '/tmp/dead' }] }),
      b: step('b', { status: 'merge_queued', batch: 2, resultCommit: 'commit-b-1', attempts: [{ attempt: 1, status: 'completed', inputCommit: 'integration-0', completions: [], resultCommit: 'commit-b-1' }] }),
    },
    integration: { ...run.integration, batch: 2, commit: 'integration-0' },
    updatedAt: T0,
    ...overrides,
  }
}

function setup() {
  const clock = manualClock(T0)
  const repository = new InMemoryRunRepository()
  const leases = new InMemoryRunLeaseStore(clock)
  const agents = new CountingAgents()
  const workspace = new Workspace()
  const scheduler = new Scheduler({ repository, leases, agentExecutor: agents, workspaceDriver: workspace, clock, leaseTtlMs: 30_000, owner: 'recoverer' })
  return { clock, repository, leases, agents, workspace, scheduler }
}

describe('Scheduler: runs abandoned by a scheduler that stopped', () => {
  it('finds driven runs with no live lease that nobody touched for a lease lifetime', async () => {
    const { clock, repository, leases, scheduler } = setup()
    await repository.create(abandonedRun('dead'))
    await leases.acquire('dead', 'crashed-cli', 30_000) // expires at T0 + 30s
    await repository.create(abandonedRun('live'))
    await repository.create(abandonedRun('unleased-old', { status: 'ready' }))
    await repository.create(abandonedRun('resting', { status: 'waiting_action' }))
    await repository.create(abandonedRun('done', { status: 'delivery_ready' }))
    await repository.create(abandonedRun('cancel-pending', { status: 'cancelling', cancelRequestedAt: T0 }))

    clock.advance(45_000)
    await leases.acquire('live', 'busy-cli', 30_000) // someone is on it right now
    await repository.create(abandonedRun('just-created', { status: 'ready', updatedAt: clock.now() - 1_000 }))

    expect((await scheduler.findAbandonedRuns()).sort()).toEqual(['cancel-pending', 'dead', 'unleased-old'])
    // Without leases nobody's ownership is visible: never guess.
    expect(await new Scheduler({ repository }).findAbandonedRuns()).toEqual([])
  })

  it('reclaims them without running anything: live steps become interrupted, a pending cancellation is finalized', async () => {
    const { clock, repository, agents, workspace, leases, scheduler } = setup()
    await repository.create(abandonedRun('dead'))
    await repository.create(abandonedRun('cancel-pending', { status: 'cancelling', cancelRequestedAt: T0 }))
    clock.advance(45_000)

    const recoveries = await scheduler.recoverAbandoned()
    expect(recoveries.map((recovery) => [recovery.runId, recovery.run?.status])).toEqual(expect.arrayContaining([
      ['dead', 'waiting_action'],
      ['cancel-pending', 'cancelled'],
    ]))
    const dead = await repository.get('dead')
    expect(dead?.steps.a).toMatchObject({ status: 'interrupted', failure: { code: FailureCode.Interrupted, retryable: true } })
    expect(dead?.steps.a?.attempts[0]).toMatchObject({ status: 'interrupted', worktreePath: '/tmp/dead' })
    // Verified work is kept as it was; nothing merged, nothing started.
    expect(dead?.steps.b?.status).toBe('merge_queued')
    expect(dead?.steps.c?.status).toBe('merged')
    expect(agents.started).toEqual([])
    expect(workspace.merges).toEqual([])
    // The lease is given back: a later resume (from any process) can take it.
    expect((await leases.get('dead'))?.expiresAt).toBe(0)
    expect(await scheduler.findAbandonedRuns()).toEqual([])
  })

  it('brings a run that died between batches to rest too, so it shows up as waiting', async () => {
    const { clock, repository, agents, scheduler } = setup()
    const run = abandonedRun('between')
    await repository.create({ ...run, steps: { ...run.steps, a: { ...run.steps.a!, status: 'ready', attempts: [] } } })
    clock.advance(45_000)
    const [recovery] = await scheduler.recoverAbandoned()
    expect(recovery?.run?.status).toBe('waiting_action')
    expect(recovery?.run?.steps.a?.status).toBe('ready')
    expect(agents.started).toEqual([])
  })

  it('resume re-runs only the interrupted steps, then merges in declaration order; merged steps are not run again', async () => {
    const { clock, repository, agents, workspace, scheduler } = setup()
    await repository.create(abandonedRun('dead'))
    clock.advance(45_000)
    await scheduler.recoverAbandoned()

    const finished = await scheduler.resume('dead')
    expect(finished.status).toBe('delivery_ready')
    expect(agents.started.map((request) => request.stepId)).toEqual(['a'])
    expect(finished.steps.a?.attempts.map((attempt) => attempt.status)).toEqual(['interrupted', 'completed'])
    expect(workspace.merges).toEqual(['a', 'b'])
  })

  it('resume works straight from the abandoned state as well, without a separate recovery', async () => {
    const { clock, repository, agents, scheduler } = setup()
    await repository.create(abandonedRun('dead'))
    clock.advance(45_000)
    expect((await scheduler.resume('dead')).status).toBe('delivery_ready')
    expect(agents.started.map((request) => request.stepId)).toEqual(['a'])
  })

  it('resume leaves failed steps for a human, and refuses a run another scheduler is driving', async () => {
    const { clock, repository, leases, agents, scheduler } = setup()
    const run = abandonedRun('mixed', { status: 'waiting_action' })
    await repository.create({
      ...run,
      steps: {
        ...run.steps,
        a: { ...run.steps.a!, status: 'failed', attempts: [{ ...run.steps.a!.attempts[0]!, status: 'failed' }] },
        b: { ...run.steps.b!, status: 'interrupted', attempts: [{ ...run.steps.b!.attempts[0]!, status: 'interrupted' }] },
      },
    })
    clock.advance(45_000)
    const resumed = await scheduler.resume('mixed')
    // b is ready to go again, but nothing moves past a's unresolved failure.
    expect(resumed.status).toBe('waiting_action')
    expect(resumed.steps.a?.status).toBe('failed')
    expect(resumed.steps.b?.status).toBe('ready')
    expect(agents.started).toEqual([])

    await repository.create(abandonedRun('busy'))
    await leases.acquire('busy', 'another-process', 60_000)
    await expect(scheduler.resume('busy')).rejects.toBeInstanceOf(RunLeaseHeldError)
  })
})

describe('Scheduler: recovering after a real process was killed (kill -9)', () => {
  it('finds the run the dead process left, and reclaims it once its lease has lapsed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-recover-'))
    dirs.push(dir)
    const repository = new FileRunRepository({ dir })
    await repository.create(createRunAggregate({
      id: 'run-killed',
      repository: { root: '/repo', baseCommit: 'base' },
      steps: [{ id: 'a' }],
      now: Date.now(),
    }))
    const source = (file: string) => JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, '../src', file)).href)
    const script = [
      `import { Scheduler } from ${source('scheduler/scheduler.ts')}`,
      `import { FileRunRepository } from ${source('repository/file.ts')}`,
      `import { FileRunLeaseStore } from ${source('repository/file-lease.ts')}`,
      'const dir = process.argv[2]',
      // An agent that never finishes: the process is killed while it "works".
      "const agents = { async start() { console.log('started'); return { wait: () => new Promise(() => {}) } } }",
      'const scheduler = new Scheduler({ repository: new FileRunRepository({ dir }), leases: new FileRunLeaseStore({ dir }), agentExecutor: agents, leaseTtlMs: 1500 })',
      "await scheduler.run('run-killed')",
    ].join('\n')
    const file = path.join(dir, 'owner.mjs')
    await writeFile(file, script, 'utf8')
    const child = spawn(process.execPath, ['--import', 'tsx', file, dir], { cwd: path.resolve(import.meta.dirname, '../../..'), stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => { if (chunk.toString().includes('started')) resolve() })
      child.on('exit', (code) => reject(new Error(`owner exited early (${code}): ${stderr}`)))
    })
    const exited = new Promise((resolve) => child.on('exit', resolve))
    child.kill('SIGKILL')
    await exited

    const killedAt = Date.now()
    const recoverer = new Scheduler({ repository, leases: new FileRunLeaseStore({ dir }), leaseTtlMs: 1500 })
    // Still inside the dead owner's lease: not abandoned yet.
    expect(await recoverer.findAbandonedRuns()).toEqual([])
    expect((await repository.get('run-killed'))?.steps.a?.status).toBe('running')

    // Nobody renews the lease any more; it lapses within one lifetime.
    let abandoned: string[] = []
    while (abandoned.length === 0 && Date.now() - killedAt < 6_000) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      abandoned = await recoverer.findAbandonedRuns()
    }
    expect(abandoned).toEqual(['run-killed'])
    const [recovery] = await recoverer.recoverAbandoned()
    expect(recovery?.runId).toBe('run-killed')
    expect(recovery?.run?.status).toBe('waiting_action')
    expect(recovery?.run?.steps.a?.status).toBe('interrupted')
  }, 20_000)
})
