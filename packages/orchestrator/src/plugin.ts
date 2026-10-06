
import type { Context } from '@deepseek-ai/cordis'
import { FileRunLeaseStore, FileRunRepository, Scheduler } from '@dsh/core'
import { CommunicationRegistryImpl } from '@dsh/communication'
import type { RegistryLogger } from '@dsh/communication/registry'
import { GitWorkspaceDriver } from '@dsh/workspace-git'
import { AgentManagerExecutor, agentManagerService, type DshAgentManagerContext } from '@dsh/agent-manager'
import { DshOrchestratorConfigSchema, resolveRunsDir } from './config.js'
import { communicationRegistryService, coreSchedulerService, runRepositoryService } from './cordis.js'

/** Harness plugin identity. */
export const name = '@dsh/orchestrator'

/** Provides the registry service and ties its lifecycle to the owning Fiber. */
export function DshOrchestratorPlugin(
  ctx: Context,
  config: unknown = {},
): () => void | Promise<void> {
  const parsed = DshOrchestratorConfigSchema.parse(config ?? {})
  const runsDir = resolveRunsDir(parsed)
  const logger = ctx.logger(name)
  const registry = new CommunicationRegistryImpl({
    drainTimeoutMs: parsed.drainTimeoutMs,
    openTimeoutMs: parsed.openTimeoutMs,
    logger: createRegistryLogger(logger),
    onLeaseForced: (event) => {
      logger.warn(`Communication lease forced release: ${JSON.stringify(event)}`)
    },
    onEntryRemoved: (summary) => {
      logger.info(`Communication provider removed: ${JSON.stringify(summary)}`)
    },
  })
  const repository = new FileRunRepository({
    dir: runsDir,
    onSkippedFile: (file, error) => {
      logger.warn(`Skipping unreadable run document ${file}: ${String(error)}`)
    },
  })
  const workspaceDriver = new GitWorkspaceDriver()

  const unprovide = ctx.provide(communicationRegistryService, registry)
  const unprovideRepository = ctx.provide(runRepositoryService, repository)
  logger.info('Communication registry provided')

  // AgentManager is an optional dependency. `ctx.inject()` wraps `ctx.plugin()` with a
  // reactive fiber that only *starts* once every injected service is present — it never
  // throws synchronously for a missing one, so a try/catch around it can never observe the
  // "not available" case; that branch was dead code. `ctx.get()` is the synchronous,
  // best-effort read this actually needs: it reflects whatever is already registered in ctx
  // right now (present when @dsh/agent-manager's plugin was loaded before this one — the
  // ordering every current caller uses), and `undefined` otherwise.
  const agentManager = ctx.get(agentManagerService) as DshAgentManagerContext[typeof agentManagerService] | undefined
  const agentExecutor = agentManager ? new AgentManagerExecutor(agentManager) : undefined

  if (agentExecutor) {
    logger.info('AgentManager available - creating Scheduler with agent execution')
  } else {
    logger.warn('AgentManager not available in context - Scheduler will run without agent execution')
  }

  // Leases live next to the runs they guard, so a CLI in another process
  // (`startWorkflow`, `dsh:compare-roles`) and this plugin cannot both
  // advance one run.
  const scheduler = new Scheduler({
    repository,
    leases: new FileRunLeaseStore({ dir: runsDir }),
    workspaceDriver,
    agentExecutor,
    globalMaxParallel: parsed.globalMaxParallel,
  })

  const unprovideScheduler = ctx.provide(coreSchedulerService, scheduler)
  logger.info('Scheduler service provided')

  // Runs a stopped process left mid-flight are brought to rest (nothing is
  // re-run) and announced; the decision is the Scheduler's.
  const recovering = parsed.recoverOnStart
    ? scheduler.recoverAbandoned().then((recoveries) => {
        for (const recovery of recoveries) {
          if (recovery.run === undefined) {
            logger.warn(`Could not take over abandoned run ${recovery.runId}: ${recovery.error ?? 'unknown error'}`)
            continue
          }
          const interrupted = Object.values(recovery.run.steps).filter((step) => step.status === 'interrupted').map((step) => step.id)
          logger.warn(recovery.run.status === 'waiting_action'
            ? `Run ${recovery.runId} was left behind by a process that stopped${interrupted.length === 0 ? '' : `; interrupted: ${interrupted.join(', ')}`}. Resume: pnpm dsh:start-workflow --resume ${recovery.runId}`
            : `Run ${recovery.runId} was left behind by a process that stopped; now ${recovery.run.status}`)
        }
      }, (error: unknown) => {
        logger.warn(`Recovering abandoned runs failed: ${String(error)}`)
      })
    : Promise.resolve()

  return async () => {
    registry.dispose()
    await unprovideScheduler()
    logger.info('Scheduler service disposed')
    await unprovideRepository()
    await unprovide()
    logger.info('Communication registry and execution services disposed')
    // Last, so the services are gone at once: Cordis 4.0.1 does not wait
    // for an async disposer, and a recovery in flight finishes on its own.
    await recovering
  }
}

function createRegistryLogger(logger: ReturnType<Context['logger']>): RegistryLogger {
  return {
    info: (message) => logger.info(message),
    warn: (message) => logger.warn(message),
    error: (message) => logger.error(message),
  }
}

export default DshOrchestratorPlugin
