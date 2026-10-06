import type { Context } from '@deepseek-ai/cordis'
import type { RunRepository, Scheduler } from '@dsh/core'
import type { CommunicationRegistry } from '@dsh/spec'

/** Cordis service name exposed by the orchestrator plugin. */
export const communicationRegistryService = 'dsh.communicationRegistry'

/** Core execution services exposed by the orchestrator host plugin. */
export const coreSchedulerService = 'dsh.core.scheduler'
export const runRepositoryService = 'dsh.core.runRepository'

/** Context shape available after the orchestrator plugin has loaded. */
export type DshCordisContext = Context & {
  'dsh.communicationRegistry': CommunicationRegistry
  'dsh.core.scheduler': Scheduler
  'dsh.core.runRepository': RunRepository
}
