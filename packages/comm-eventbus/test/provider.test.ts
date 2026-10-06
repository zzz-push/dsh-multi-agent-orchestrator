import { describe, expect, it } from 'vitest'
import { EventBusPort } from '../src/port.js'
import {
  createEventBusProvider,
  EVENTBUS_CAPABILITIES,
  EventBusProvider,
} from '../src/provider.js'
import { makeMessage } from './helpers.js'

describe('EventBusProvider', () => {
  it('declares the designed capability matrix', () => {
    expect(EVENTBUS_CAPABILITIES).toEqual({
      delivery: 'at-most-once',
      durable: false,
      ordering: 'none',
      requestReply: true,
      cancellation: 'local',
      maxMessageBytes: 1_000_000,
    })
    const provider = createEventBusProvider()
    expect(provider.name).toBe('event-emitter')
    expect(provider.version).toBe('1.0.0')
  })

  it('isolates every open with a distinct emitter', async () => {
    const provider = new EventBusProvider()
    const first = await provider.open({ runId: 'first' }) as EventBusPort
    const second = await provider.open({ runId: 'second' }) as EventBusPort
    const firstMessages: string[] = []
    const secondMessages: string[] = []
    first.subscribe(() => true, (message) => firstMessages.push(message.runId))
    second.subscribe(() => true, (message) => secondMessages.push(message.runId))

    await first.send(makeMessage())
    expect(first.eventEmitter).not.toBe(second.eventEmitter)
    expect(firstMessages).toEqual(['first'])
    expect(secondMessages).toEqual([])
  })

  it('passes maxListeners and clock options to opened ports', async () => {
    const provider = new EventBusProvider({ maxListeners: 7, now: () => 77 })
    const port = await provider.open({ runId: 'run' }) as EventBusPort
    expect(port.eventEmitter.getMaxListeners()).toBe(7)
    await expect(port.send(makeMessage())).resolves.toEqual({ acceptedAt: 77 })
    expect(() => new EventBusProvider({ maxListeners: 0 })).toThrow(RangeError)
  })
})
