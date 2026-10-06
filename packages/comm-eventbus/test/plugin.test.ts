import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import DshOrchestratorPlugin, {
  communicationRegistryService,
} from '@dsh/orchestrator'
import { getCommunicationRegistry } from '../src/cordis.js'
import CommEventBusPlugin from '../src/plugin.js'

describe('@dsh/comm-eventbus Cordis integration', () => {
  it('injects the registry and registers EventBusProvider', async () => {
    const ctx = new Context()
    const orchestrator = await ctx.plugin(DshOrchestratorPlugin)
    const eventBus = await ctx.plugin(CommEventBusPlugin, { maxListeners: 16 })
    const registry = getCommunicationRegistry(ctx)

    expect(ctx.get(communicationRegistryService)).toBe(registry)
    expect(registry.inspect().providers).toMatchObject([{
      name: 'event-emitter',
      version: '1.0.0',
      status: 'active',
    }])

    await eventBus.dispose()
    expect(registry.inspect().providers).toEqual([])
    await orchestrator.dispose()
  })
})
