import { describe, expect, it } from 'vitest'
import type { CommunicationRegistry } from '@dsh/spec'
import { CommunicationRegistryImpl } from '@dsh/communication'
import { makeResponse } from '@dsh/communication/messages'
import { apply, inject, name } from '../src/index.js'
import { EventBusPort } from '../src/port.js'
import { makeMessage } from './helpers.js'

describe('EventBus integration', () => {
  it('runs request/reply through registry acquisition and release', async () => {
    const registry = new CommunicationRegistryImpl()
    const disposers: Array<() => void> = []
    apply({
      'dsh.communicationRegistry': registry,
      on: (_event, callback) => disposers.push(callback),
    }, { maxListeners: 16 })

    const lease = await registry.acquire({
      provider: 'event-emitter',
      requirements: { requestReply: true },
      runId: 'integration-run',
    })
    const port = lease.port as EventBusPort
    port.subscribe(
      (message) => message.type === 'integration.request',
      (request) => {
        void port.send(makeResponse(request, 'ok', 'worker'))
      },
    )

    const response = await port.request(makeMessage({
      type: 'integration.request',
      correlationId: 'integration-correlation',
    }), { timeoutMs: 100 })
    expect(response.payload).toBe('ok')
    expect(lease.generation).toBe('gen-0001')

    disposers.forEach((dispose) => dispose())
    expect(registry.inspect().providers[0]?.status).toBe('draining')
    await lease.release()
    await registry.whenDrained(lease.generation)
    expect(registry.inspect().providers).toEqual([])
  })

  it('supports callback-style injection without opening a port at apply time', () => {
    const registry = new CommunicationRegistryImpl()
    let injectedDependencies: readonly string[] = []
    const disposers: Array<() => void> = []
    apply({
      inject: (dependencies, callback) => {
        injectedDependencies = dependencies
        callback(registry as CommunicationRegistry)
      },
      on: (_event, callback) => disposers.push(callback),
    })

    expect(name).toBe('@dsh/comm-eventbus')
    expect(inject).toEqual(['dsh.communicationRegistry'])
    expect(injectedDependencies).toEqual(inject)
    expect(registry.inspect().providers).toHaveLength(1)
    expect(registry.inspect().leases).toEqual([])
    disposers[0]?.()
    expect(registry.inspect().providers).toEqual([])
  })

  it('fails fast for invalid config or a missing registry', () => {
    expect(() => apply({}, { maxListeners: 0 })).toThrow()
    expect(() => apply({})).toThrow('缺少 dsh.communicationRegistry')
  })
})
