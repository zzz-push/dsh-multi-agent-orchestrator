import type { Context } from '@deepseek-ai/cordis'
import { DshAgentManagerConfigSchema, resolveAgentManagerPaths } from './config.js'
import { agentManagerService } from './cordis.js'
import { AgentManager } from './manager.js'
import type { JournalLogger } from './journal/writer.js'
import { ClaudeCodeChannel } from './channel/claude-code.js'
import { CodexWebSocketChannel } from './channel/codex-websocket.js'
import { FileRoleProvider } from './role/file-provider.js'
import { registerAgentManagerWebSurface } from './web.js'

/** Harness plugin identity. */
export const name = '@dsh/agent-manager'

/**
 * Cordis plugin that provides one journal-backed {@link AgentManager} and
 * disposes every child process before unregistering the service.
 */
export function DshAgentManagerPlugin(ctx: Context, config: unknown = {}): () => void | Promise<void> {
  const parsed = DshAgentManagerConfigSchema.parse(config ?? {})
  const paths = resolveAgentManagerPaths(parsed)
  const logger = ctx.logger(name)
  const journalLogger: JournalLogger = {
    info: (message) => logger.info(message),
    warn: (message) => logger.warn(message),
    error: (message) => logger.error(message),
  }
  // TODO: FileRoleProvider is the temporary disk-backed role source;
  // replace it with SkillRoleProvider when ctx.skills is available.
  const roles = new FileRoleProvider({ rolesDir: paths.rolesDir, logger: journalLogger })
  const codexEnv = paths.codexHome === undefined
    ? undefined
    : { CODEX_HOME: paths.codexHome }
  const codex = new CodexWebSocketChannel({
    command: paths.codexCommand,
    env: codexEnv,
    logger: journalLogger,
  })
  const manager = new AgentManager({
    roleProvider: roles,
    journalFile: paths.journalFile,
    cwd: paths.cwd,
    logger: journalLogger,
    channels: [
      new ClaudeCodeChannel({
        command: paths.claudeCommand,
        ...(parsed.claudeModel === undefined ? {} : { model: parsed.claudeModel }),
        ...(parsed.claudeEffort === undefined ? {} : { effort: parsed.claudeEffort }),
        logger: journalLogger,
      }),
      codex,
    ],
  })
  registerAgentManagerWebSurface(ctx, manager, journalLogger, { trustedHosts: parsed.trustedHosts })
  const unprovide = ctx.provide(agentManagerService, manager)
  logger.info('Agent manager provided')
  return async () => {
    try {
      await manager.dispose()
    } finally {
      await unprovide()
      logger.info('Agent manager disposed')
    }
  }
}

export default DshAgentManagerPlugin
