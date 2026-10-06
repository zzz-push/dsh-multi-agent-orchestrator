import type { Context } from '@deepseek-ai/cordis'
import { CommEventBusConfigSchema } from './config.js'
import {
  communicationRegistryService,
  getCommunicationRegistry,
} from './cordis.js'
import { EventBusProvider } from './provider.js'

/** Harness plugin identity. */
export const name = '@dsh/comm-eventbus'

/** Dependency requested by the provider's child injection fiber. */
export const inject = [communicationRegistryService] as const

/**
 * Registers the EventBus provider once the orchestrator service is available.
 * Cordis disposes the returned callback cleanup when this injection fiber unloads.
 */
export function CommEventBusPlugin(ctx: Context, config: unknown = {}): void {
  const parsed = CommEventBusConfigSchema.parse(config ?? {})

  ctx.inject(inject, (injectedCtx) => {
    const registry = getCommunicationRegistry(injectedCtx)
    const unregister = registry.register(new EventBusProvider({
      maxListeners: parsed.maxListeners,
    }))
    injectedCtx.logger(name).info('EventBus provider registered')

    return () => {
      unregister()
      injectedCtx.logger(name).info('EventBus provider unregistered')
    }
  })
}

export default CommEventBusPlugin

/** Minimal context shape retained for callers that used the pre-Cordis helper. */
export interface EventBusPluginContext {
  inject?: (
    dependencies: readonly string[],
    callback: (value: Context | import('@dsh/spec').CommunicationRegistry) =>
      void | (() => void),
  ) => unknown
  on?: (event: 'dispose', callback: () => void) => unknown
  ['dsh.communicationRegistry']?: import('@dsh/spec').CommunicationRegistry
}

/**
 * Compatibility helper for the core-library integration tests. New hosts should
 * load the default Cordis plugin with `ctx.plugin(CommEventBusPlugin, config)`.
 */
export function apply(ctx: EventBusPluginContext, config: unknown = {}): void {
  const parsed = CommEventBusConfigSchema.parse(config ?? {})
  const register = (registry: import('@dsh/spec').CommunicationRegistry): void => {
    const unregister = registry.register(new EventBusProvider({
      maxListeners: parsed.maxListeners,
    }))
    ctx.on?.('dispose', unregister)
  }

  if (ctx.inject) {
    ctx.inject(inject, (value) => {
      if ('get' in value && typeof value.get === 'function') {
        register(getCommunicationRegistry(value))
      } else {
        register(value as import('@dsh/spec').CommunicationRegistry)
      }
    })
    return
  }

  const registry = ctx[communicationRegistryService]
  if (!registry) {
    throw new Error(
      '缺少 dsh.communicationRegistry，@dsh/comm-eventbus 无法加载',
    )
  }
  register(registry)
}
