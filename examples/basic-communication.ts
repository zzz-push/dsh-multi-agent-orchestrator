import { Context } from '@deepseek-ai/cordis'
import { createMessage, makeResponse } from '@dsh/communication/messages'
import CommEventBusPlugin, { getCommunicationRegistry } from '@dsh/comm-eventbus'
import DshOrchestratorPlugin from '@dsh/orchestrator'

const ctx = new Context()
const orchestrator = await ctx.plugin(DshOrchestratorPlugin, {
  drainTimeoutMs: 1_000,
  openTimeoutMs: 500,
})
const eventBus = await ctx.plugin(CommEventBusPlugin)
const registry = getCommunicationRegistry(ctx)
const lease = await registry.acquire({
  provider: 'event-emitter',
  requirements: { requestReply: true },
  runId: 'demo-run-001',
})

console.log('Lease acquired:', {
  provider: lease.provider,
  generation: lease.generation,
})

const unsubscribe = lease.port.subscribe(
  (message) => message.type === 'demo.hello',
  (request) => {
    void lease.port.send(makeResponse(request, {
      message: 'Hello back from EventBus provider.',
    }, 'worker'))
  },
)

const response = await lease.port.request(createMessage({
  runId: 'demo-run-001',
  type: 'demo.hello',
  sender: 'orchestrator',
  recipient: 'worker',
  correlationId: 'demo-correlation-001',
  payload: { message: 'Hello from orchestrator.' },
}), { timeoutMs: 100 })

console.log('Message round-trip:', response.payload)

unsubscribe()
await lease.release()
await eventBus.dispose()
await orchestrator.dispose()
console.log('Demo complete')
