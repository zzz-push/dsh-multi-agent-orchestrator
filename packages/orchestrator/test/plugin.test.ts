import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { makeResponse, createMessage } from '@dsh/communication/messages'
import type { CommunicationRegistry } from '@dsh/spec'
import CommEventBusPlugin, {
  getCommunicationRegistry,
} from '@dsh/comm-eventbus'
import DshAgentManagerPlugin, { agentManagerService } from '@dsh/agent-manager'
import { createRunAggregate, FileRunRepository, type RunRepository } from '@dsh/core'
import DshOrchestratorPlugin, {
  communicationRegistryService,
  coreSchedulerService,
  PLUGIN_CHECKOUT_ROOT,
  resolveRunsDir,
  runRepositoryService,
} from '../src/index.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** Never the project's own `.dsh/runtime/runs`: the plugin reclaims abandoned runs it finds there. */
async function isolatedRunsDir(): Promise<string> {
  return path.join(await tempDir('dsh-orch-runs-'), 'runs')
}

async function loadPlugins() {
  const ctx = new Context()
  const orchestrator = await ctx.plugin(DshOrchestratorPlugin, { runsDir: await isolatedRunsDir() })
  const eventBus = await ctx.plugin(CommEventBusPlugin)
  return { ctx, orchestrator, eventBus }
}

describe('@dsh/orchestrator Cordis integration', () => {
  it('provides the registry service through the real plugin lifecycle', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(DshOrchestratorPlugin, {
      drainTimeoutMs: 100,
      openTimeoutMs: 100,
      runsDir: await isolatedRunsDir(),
    })

    expect(ctx.get(communicationRegistryService)).toBeDefined()
    expect(getCommunicationRegistry(ctx)).toBe(ctx.get(communicationRegistryService))

    await fiber.dispose()
    expect(ctx.get(communicationRegistryService)).toBeUndefined()
  })

  it('delivers request/reply through the loaded provider plugin', async () => {
    const { ctx, orchestrator, eventBus } = await loadPlugins()
    const registry = getCommunicationRegistry(ctx)
    const lease = await registry.acquire({
      provider: 'event-emitter',
      requirements: { requestReply: true },
      runId: 'orchestrator-e2e',
    })

    const unsubscribe = lease.port.subscribe(
      (message) => message.type === 'demo.request',
      (request) => {
        void lease.port.send(makeResponse(request, { ok: true }, 'worker'))
      },
    )
    const response = await lease.port.request(createMessage({
      runId: 'orchestrator-e2e',
      type: 'demo.request',
      sender: 'orchestrator',
      correlationId: 'demo-correlation',
      payload: { value: 42 },
    }), { timeoutMs: 100 })

    expect(response.payload).toEqual({ ok: true })
    unsubscribe()
    await lease.release()
    await eventBus.dispose()
    await orchestrator.dispose()
  })

  it('disposes the registry and unregisters providers', async () => {
    const { ctx, orchestrator, eventBus } = await loadPlugins()
    const registry = getCommunicationRegistry(ctx) as CommunicationRegistry
    expect(registry.inspect().providers).toHaveLength(1)

    await eventBus.dispose()
    expect(registry.inspect().providers).toEqual([])
    await orchestrator.dispose()
    expect(ctx.get(communicationRegistryService)).toBeUndefined()
  })

  it('provides a durable run repository under runsDir that a fresh plugin instance reads back', async () => {
    const runsDir = await isolatedRunsDir()

    // The run is left `running` with nobody on it on purpose; startup
    // recovery would (rightly) take it over, which is not what this tests.
    const first = new Context()
    const firstFiber = await first.plugin(DshOrchestratorPlugin, { runsDir, recoverOnStart: false })
    const firstRepo = first.get(runRepositoryService) as RunRepository
    await firstRepo.create(createRunAggregate({
      id: 'run-durable',
      repository: { root: '/repo', baseCommit: 'base' },
      steps: [{ id: 'a' }],
      now: 1_000,
    }))
    await firstRepo.update('run-durable', 0, (run) => ({ ...run, status: 'running' }))
    await firstFiber.dispose()
    expect(first.get(runRepositoryService)).toBeUndefined()

    // A second, unrelated plugin instance over the same directory is the
    // "process restart" case the in-memory repository could never pass.
    const second = new Context()
    const secondFiber = await second.plugin(DshOrchestratorPlugin, { runsDir, recoverOnStart: false })
    const secondRepo = second.get(runRepositoryService) as RunRepository
    expect(await secondRepo.get('run-durable')).toMatchObject({ id: 'run-durable', revision: 1, status: 'running' })
    await secondFiber.dispose()
  })

  it('provides a Scheduler without agent execution when AgentManager is never loaded', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(DshOrchestratorPlugin, { runsDir: await isolatedRunsDir() })

    expect(ctx.get(coreSchedulerService)).toBeDefined()

    await fiber.dispose()
    expect(ctx.get(coreSchedulerService)).toBeUndefined()
  })

  it('wires a real AgentExecutor into the Scheduler once AgentManager is available', async () => {
    const dir = await tempDir('dsh-orchestrator-agent-manager-')
    const ctx = new Context()
    const agentManagerFiber = await ctx.plugin(DshAgentManagerPlugin, {
      rolesDir: path.join(dir, 'roles'),
      journalFile: path.join(dir, 'events.jsonl'),
      cwd: process.cwd(),
    })
    expect(ctx.get(agentManagerService)).toBeDefined()

    const orchestratorFiber = await ctx.plugin(DshOrchestratorPlugin, { runsDir: await isolatedRunsDir() })
    expect(ctx.get(coreSchedulerService)).toBeDefined()

    await orchestratorFiber.dispose()
    expect(ctx.get(coreSchedulerService)).toBeUndefined()
    await agentManagerFiber.dispose()
    expect(ctx.get(agentManagerService)).toBeUndefined()
  })

  it('on startup, brings runs a stopped process left mid-flight to rest without running them, unless told not to', async () => {
    const seed = async (runsDir: string) => {
      const repository = new FileRunRepository({ dir: runsDir })
      const run = createRunAggregate({ id: 'run-left', repository: { root: '/repo', baseCommit: 'base' }, steps: [{ id: 'a' }], now: 1_000 })
      await repository.create({
        ...run,
        status: 'running',
        steps: { a: { ...run.steps.a!, status: 'running', attempts: [{ attempt: 1, status: 'running', inputCommit: 'base', completions: [] }] } },
      })
      return repository
    }

    // The recovery runs in the background of startup; wait for its outcome.
    const settledStatus = async (repository: RunRepository): Promise<string | undefined> => {
      const deadline = Date.now() + 3_000
      for (;;) {
        const status = (await repository.get('run-left'))?.status
        if (status !== 'running' || Date.now() > deadline) return status
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }

    const on = await isolatedRunsDir()
    const repository = await seed(on)
    const ctx = new Context()
    const fiber = await ctx.plugin(DshOrchestratorPlugin, { runsDir: on })
    expect(await settledStatus(repository)).toBe('waiting_action')
    expect((await repository.get('run-left'))?.steps.a).toMatchObject({ status: 'interrupted', attempts: [{ status: 'interrupted' }] })
    await fiber.dispose()

    const off = await isolatedRunsDir()
    const untouched = await seed(off)
    const quiet = new Context()
    const quietFiber = await quiet.plugin(DshOrchestratorPlugin, { runsDir: off, recoverOnStart: false })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((await untouched.get('run-left'))?.status).toBe('running')
    await quietFiber.dispose()
  })
})

describe('orchestrator runs directory', () => {
  it('resolves against the checkout the plugin runs from, not the process working directory', () => {
    expect(existsSync(path.join(PLUGIN_CHECKOUT_ROOT, 'packages', 'orchestrator', 'package.json'))).toBe(true)
    expect(resolveRunsDir({ runsDir: '.dsh/runtime/runs' }, '/checkout')).toBe('/checkout/.dsh/runtime/runs')
    expect(resolveRunsDir({ root: 'nested', runsDir: 'runs' }, '/checkout')).toBe('/checkout/nested/runs')
    expect(resolveRunsDir({ root: 'nested', runsDir: '/var/runs' }, '/checkout')).toBe('/var/runs')
    expect(resolveRunsDir({ runsDir: '.dsh/runtime/runs' })).toBe(path.join(PLUGIN_CHECKOUT_ROOT, '.dsh', 'runtime', 'runs'))
  })
})
