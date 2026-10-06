import type { Context } from '@deepseek-ai/cordis'
import type { AgentManager } from './manager.js'

/** Cordis service name exposed by the agent-manager plugin. */
export const agentManagerService = 'dsh.agentManager'

/** Context shape available after the agent-manager plugin has loaded. */
export type DshAgentManagerContext = Context & {
  'dsh.agentManager': AgentManager
}
