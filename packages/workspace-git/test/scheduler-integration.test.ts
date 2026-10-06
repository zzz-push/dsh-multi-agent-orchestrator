import { exec as execCb } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createRunAggregate,
  InMemoryRunRepository,
  Scheduler,
  type AgentExecutionHandle,
  type AgentExecutionRequest,
  type AgentExecutor,
  type StepDefinition,
} from '@dsh/core'

import { GitWorkspaceDriver } from '../src/driver.js'
import { cleanupTempRepo, createTempGitRepoWithContent } from './fixtures/test-repo.js'

const exec = promisify(execCb)

/**
 * Stand-in for a real agent: each step's behaviour is a function of its
 * worktree. What it saw on entry is recorded, so a test can assert which
 * baseline a step was started from.
 */
class ScriptedAgentExecutor implements AgentExecutor {
  readonly sawOnEntry = new Map<string, string[]>()
  constructor(private readonly script: Record<string, (worktree: string) => Promise<void>>) {}

  async start(request: AgentExecutionRequest): Promise<AgentExecutionHandle> {
    const worktree = request.worktreePath ?? ''
    this.sawOnEntry.set(request.stepId, ['a.txt', 'b.txt', 'shared.txt'].filter((file) => existsSync(join(worktree, file))))
    const work = this.script[request.stepId]?.(worktree) ?? Promise.resolve()
    return { wait: async () => { await work; return { outcome: 'succeeded' } } }
  }
}

async function show(repo: string, ref: string, file: string): Promise<string | undefined> {
  try {
    return (await exec(`git show ${ref}:${file}`, { cwd: repo })).stdout
  } catch {
    return undefined
  }
}

describe('Scheduler + GitWorkspaceDriver (real git)', () => {
  let repo: string
  let base: string
  let worktreeRoot: string

  beforeEach(async () => {
    ;[repo, base] = await createTempGitRepoWithContent()
    worktreeRoot = await mkdtemp(join(tmpdir(), 'dsh-sched-wt-'))
  })

  afterEach(async () => {
    await cleanupTempRepo(repo)
    await rm(worktreeRoot, { recursive: true, force: true })
  })

  function makeRun(id: string, steps: StepDefinition[], maxParallel?: number) {
    return createRunAggregate({
      id,
      repository: { root: repo, baseCommit: base },
      steps,
      workflow: { failureMode: 'stop_after_batch', ...(maxParallel === undefined ? {} : { maxParallel }) },
    })
  }

  it('starts a dependent step from its dependency\'s merged result and advances the integration commit', async () => {
    const repository = new InMemoryRunRepository()
    const agentExecutor = new ScriptedAgentExecutor({
      a: (wt) => writeFile(join(wt, 'a.txt'), 'from a\n'),
      b: (wt) => writeFile(join(wt, 'b.txt'), 'from b\n'),
    })
    const scheduler = new Scheduler({ repository, agentExecutor, workspaceDriver: new GitWorkspaceDriver({ worktreeRoot }) })
    await repository.create(makeRun('run-seq', [{ id: 'a' }, { id: 'b', dependsOn: ['a'] }]))

    const run = await scheduler.run('run-seq')

    expect(run.steps.b.failure).toBeUndefined()
    expect(run.status).toBe('delivery_ready')
    expect(run.steps.a.status).toBe('merged')
    expect(run.steps.b.status).toBe('merged')
    expect(agentExecutor.sawOnEntry.get('b')).toEqual(['a.txt'])
    expect(run.steps.b.attempts[0]?.inputCommit).not.toBe(base)

    const head = (await exec(`git rev-parse ${run.integration.ref}`, { cwd: repo })).stdout.trim()
    expect(run.integration.commit).toBe(head)
    expect(await show(repo, head, 'a.txt')).toBe('from a\n')
    expect(await show(repo, head, 'b.txt')).toBe('from b\n')
  })

  it('merges independent steps of one batch in declaration order, all started from the same baseline', async () => {
    const repository = new InMemoryRunRepository()
    const agentExecutor = new ScriptedAgentExecutor({
      a: (wt) => writeFile(join(wt, 'a.txt'), 'from a\n'),
      b: (wt) => writeFile(join(wt, 'b.txt'), 'from b\n'),
    })
    const scheduler = new Scheduler({ repository, agentExecutor, workspaceDriver: new GitWorkspaceDriver({ worktreeRoot }) })
    await repository.create(makeRun('run-par', [{ id: 'a' }, { id: 'b' }], 2))

    const run = await scheduler.run('run-par')

    expect(run.status).toBe('delivery_ready')
    expect(run.steps.a.attempts[0]?.inputCommit).toBe(base)
    expect(run.steps.b.attempts[0]?.inputCommit).toBe(base)
    expect(agentExecutor.sawOnEntry.get('b')).toEqual([])
    const head = run.integration.commit
    expect(await show(repo, head, 'a.txt')).toBe('from a\n')
    expect(await show(repo, head, 'b.txt')).toBe('from b\n')
  })

  it('detects a real conflict between two steps of one batch instead of letting the later one overwrite', async () => {
    await writeFile(join(repo, 'shared.txt'), 'line one\n')
    await exec('git add shared.txt && git commit -m "add shared"', { cwd: repo })
    base = (await exec('git rev-parse HEAD', { cwd: repo })).stdout.trim()

    const repository = new InMemoryRunRepository()
    const agentExecutor = new ScriptedAgentExecutor({
      a: (wt) => writeFile(join(wt, 'shared.txt'), 'line one, as a wrote it\n'),
      b: (wt) => writeFile(join(wt, 'shared.txt'), 'line one, as b wrote it\n'),
    })
    const scheduler = new Scheduler({ repository, agentExecutor, workspaceDriver: new GitWorkspaceDriver({ worktreeRoot }) })
    await repository.create(makeRun('run-conflict', [{ id: 'a' }, { id: 'b' }], 2))

    const run = await scheduler.run('run-conflict')

    expect(run.steps.a.status).toBe('merged')
    expect(run.steps.b.status).toBe('merge_conflict')
    expect(run.steps.b.resultCommit).toBeDefined()
    expect(run.status).toBe('waiting_action')
    // The integration holds a's version, untouched by b.
    expect(await show(repo, run.integration.commit, 'shared.txt')).toBe('line one, as a wrote it\n')
    expect(await readFile(join(repo, 'shared.txt'), 'utf8')).toBe('line one\n')
  })

  it('merges a candidate another driver instance captured, given the repository root (restart or scheduler hand-over)', async () => {
    const capturing = new GitWorkspaceDriver({ worktreeRoot })
    const workspace = await capturing.createAttempt({ runId: 'run-x', stepId: 'a', attempt: 1, inputCommit: base, repository: { root: repo, baseCommit: base } })
    await writeFile(join(workspace.worktreePath!, 'a.txt'), 'from a\n')
    const captured = await capturing.captureResult({ runId: 'run-x', stepId: 'a', attempt: 1, workspaceId: workspace.workspaceId })
    await capturing.removeAttempt(workspace.workspaceId)

    const fresh = new GitWorkspaceDriver({ worktreeRoot })
    const request = { runId: 'run-x', stepId: 'a', resultCommit: captured.resultCommit!, integrationRef: 'refs/dsh-orchestrator/runs/run-x/integration', expectedIntegrationCommit: base }
    expect(await fresh.mergeResult(request)).toMatchObject({ merged: false, conflict: expect.stringMatching(/Unknown result commit/) })
    const merged = await fresh.mergeResult({ ...request, repositoryRoot: repo })
    expect(merged.merged).toBe(true)
    expect(await show(repo, merged.integrationCommit!, 'a.txt')).toBe('from a\n')
  })

  it('refuses a candidate that is not based on the run\'s integration line', async () => {
    const driver = new GitWorkspaceDriver({ worktreeRoot })
    await exec('git checkout -q -b elsewhere && git commit -q --allow-empty -m side && git checkout -q -', { cwd: repo })
    const side = (await exec('git rev-parse elsewhere', { cwd: repo })).stdout.trim()
    const workspace = await driver.createAttempt({ runId: 'run-y', stepId: 'a', attempt: 1, inputCommit: side, repository: { root: repo, baseCommit: side } })
    await writeFile(join(workspace.worktreePath!, 'a.txt'), 'x\n')
    const captured = await driver.captureResult({ runId: 'run-y', stepId: 'a', attempt: 1, workspaceId: workspace.workspaceId })
    await driver.removeAttempt(workspace.workspaceId)

    const merged = await driver.mergeResult({ runId: 'run-y', stepId: 'a', resultCommit: captured.resultCommit!, integrationRef: 'refs/dsh-orchestrator/runs/run-y/integration', expectedIntegrationCommit: base })
    expect(merged).toMatchObject({ merged: false, conflict: expect.stringMatching(/not based on this run/) })
  })

  it('runs the workflow\'s workspace setup in each fresh worktree before the agent, and fails the step when it fails', async () => {
    const repository = new InMemoryRunRepository()
    const sawPrepared: boolean[] = []
    const agentExecutor: AgentExecutor = {
      start: async (request) => {
        sawPrepared.push(existsSync(join(request.worktreePath ?? '', 'node_modules', '.prepared')))
        await writeFile(join(request.worktreePath ?? '', 'a.txt'), 'from a\n')
        return { wait: async () => ({ outcome: 'succeeded' }) }
      },
    }
    const scheduler = new Scheduler({ repository, agentExecutor, workspaceDriver: new GitWorkspaceDriver({ worktreeRoot }) })
    const setup = (command: string[]) => [{ id: 'install', command, cwd: '.', timeoutSeconds: 30, envAllow: [], required: true }]
    const run = makeRun('run-setup', [{ id: 'a' }])
    await repository.create({ ...run, workflow: { ...run.workflow, setup: setup(['sh', '-c', 'mkdir -p node_modules && touch node_modules/.prepared']) } })

    const done = await scheduler.run('run-setup')
    expect(done.status).toBe('delivery_ready')
    expect(sawPrepared).toEqual([true])

    const broken = makeRun('run-setup-broken', [{ id: 'a' }])
    await repository.create({ ...broken, workflow: { ...broken.workflow, setup: setup(['sh', '-c', 'echo no network >&2; exit 1']) } })
    const failed = await scheduler.run('run-setup-broken')
    expect(failed.steps.a.status).toBe('failed')
    expect(failed.steps.a.failure).toMatchObject({ code: 'host_io_failed' })
    expect(failed.steps.a.failure?.message).toMatch(/workspace setup failed: Check "install" exited with code 1\nno network/)
    expect(sawPrepared).toHaveLength(1)
  })
})
