import type { Context } from '@deepseek-ai/cordis'
import type { CommunicationRegistry } from '@dsh/spec'

/** Cordis service name shared by the orchestrator and provider plugins. */
export const communicationRegistryService = 'dsh.communicationRegistry'

/** Gets the registry after Cordis has satisfied the plugin injection. */
export function getCommunicationRegistry(ctx: Context): CommunicationRegistry {
  const registry = ctx.get(communicationRegistryService)
  if (!registry) {
    throw new Error(
      '缺少 dsh.communicationRegistry，@dsh/comm-eventbus 无法加载',
    )
  }

  return registry as CommunicationRegistry
}
