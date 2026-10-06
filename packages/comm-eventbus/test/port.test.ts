import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  MessageValidationError,
  PortClosedError,
  RequestAbortedError,
  RequestTimeoutError,
} from '@dsh/communication/errors'
import {
  COMM_RESPONSE_TYPE,
  makeResponse,
} from '@dsh/communication/messages'
import {
  EventBusEmitter,
  HANDLER_ERROR_EVENT,
} from '../src/emitter.js'
import { EventBusPort } from '../src/port.js'
import { makeMessage } from './helpers.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('EventBusPort', () => {
  it('sends scoped messages to matching subscribers', async () => {
    const port = new EventBusPort(
      { runId: 'scoped-run', attemptId: 'attempt-1' },
      { now: () => 123 },
    )
    const received: string[] = []
    let stampedAttempt: string | undefined
    const unsubscribe = port.subscribe(
      (message) => message.type === 'wanted',
      (message) => {
        received.push(message.runId)
        stampedAttempt = message.attemptId
      },
    )

    await port.send(makeMessage({ type: 'ignored' }))
    const result = await port.send(makeMessage({
      runId: 'forged-run',
      type: 'wanted',
    }))

    expect(result).toEqual({ acceptedAt: 123 })
    expect(received).toEqual(['scoped-run'])
    expect(stampedAttempt).toBe('attempt-1')
    unsubscribe()
    unsubscribe()
    await port.send(makeMessage({ type: 'wanted' }))
    expect(received).toHaveLength(1)
  })

  it('preserves an explicit attempt ID while forcing run scope', async () => {
    const port = new EventBusPort({ runId: 'scope', attemptId: 'default-attempt' })
    const received: Array<{ runId: string; attemptId?: string }> = []
    port.subscribe(() => true, (message) => received.push(message))
    await port.send(makeMessage({ attemptId: 'explicit-attempt' }))
    expect(received[0]).toMatchObject({
      runId: 'scope',
      attemptId: 'explicit-attempt',
    })
  })

  it('reports sync, async, and filter errors without blocking other handlers', async () => {
    const port = new EventBusPort({ runId: 'run' })
    const errors: unknown[] = []
    const received: string[] = []
    port.eventEmitter.on(HANDLER_ERROR_EVENT, (error: unknown) => errors.push(error))
    port.subscribe(() => {
      throw new Error('filter failed')
    }, () => undefined)
    port.subscribe(() => true, () => {
      throw new Error('sync failed')
    })
    port.subscribe(() => true, async () => {
      throw new Error('async failed')
    })
    port.subscribe(() => true, (message) => received.push(message.messageId))

    await port.send(makeMessage({ messageId: 'delivered' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(received).toEqual(['delivered'])
    expect(errors.map((error) => String(error))).toEqual(expect.arrayContaining([
      expect.stringContaining('filter failed'),
      expect.stringContaining('sync failed'),
      expect.stringContaining('async failed'),
    ]))
  })

  it('completes request/reply with only the first matching response', async () => {
    const port = new EventBusPort({ runId: 'run' })
    port.subscribe(
      (message) => message.type === 'question',
      (request) => {
        void port.send(makeResponse(request, { answer: 1 }, 'responder'))
        void port.send(makeResponse(request, { answer: 2 }, 'responder'))
      },
    )
    const request = makeMessage({
      type: 'question',
      correlationId: 'correlation-1',
    })

    const response = await port.request(request, { timeoutMs: 100 })
    expect(response.type).toBe(COMM_RESPONSE_TYPE)
    expect(response.correlationId).toBe('correlation-1')
    expect(response.payload).toEqual({ answer: 1 })
    expect(port.pendingCount).toBe(0)
  })

  it('times out and removes the pending request', async () => {
    vi.useFakeTimers()
    const port = new EventBusPort({ runId: 'run' })
    const request = port.request(makeMessage({
      correlationId: 'timeout',
    }), { timeoutMs: 25 })
    const assertion = expect(request).rejects.toBeInstanceOf(RequestTimeoutError)
    expect(port.pendingCount).toBe(1)
    await vi.advanceTimersByTimeAsync(25)
    await assertion
    expect(port.pendingCount).toBe(0)
  })

  it('aborts both before and during a request without leaking pending state', async () => {
    const port = new EventBusPort({ runId: 'run' })
    const controller = new AbortController()
    const request = port.request(makeMessage({
      correlationId: 'abort-during',
    }), { timeoutMs: 1_000, signal: controller.signal })
    controller.abort()
    await expect(request).rejects.toBeInstanceOf(RequestAbortedError)
    expect(port.pendingCount).toBe(0)

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await expect(port.request(makeMessage({
      correlationId: 'abort-before',
    }), { timeoutMs: 1_000, signal: alreadyAborted.signal }))
      .rejects.toBeInstanceOf(RequestAbortedError)
    expect(port.pendingCount).toBe(0)
  })

  it('rejects correlation ID reuse while a request is pending', async () => {
    const port = new EventBusPort({ runId: 'run' })
    const first = port.request(makeMessage({ correlationId: 'duplicate' }), {
      timeoutMs: 1_000,
    })
    const firstAssertion = expect(first).rejects.toBeInstanceOf(PortClosedError)
    await expect(port.request(makeMessage({ correlationId: 'duplicate' }), {
      timeoutMs: 1_000,
    })).rejects.toBeInstanceOf(MessageValidationError)
    await port.close()
    await firstAssertion
  })

  it('closes idempotently and rejects all operations after close', async () => {
    const port = new EventBusPort({ runId: 'run' })
    const pending = port.request(makeMessage({ correlationId: 'pending' }), {
      timeoutMs: 1_000,
    })
    const pendingAssertion = expect(pending).rejects.toBeInstanceOf(PortClosedError)
    await Promise.all([port.close(), port.close()])
    await pendingAssertion

    await expect(port.send(makeMessage())).rejects.toBeInstanceOf(PortClosedError)
    expect(() => port.subscribe(() => true, () => undefined))
      .toThrow(PortClosedError)
    await expect(port.request(makeMessage({ correlationId: 'later' }), {
      timeoutMs: 10,
    })).rejects.toBeInstanceOf(PortClosedError)
    expect(port.isClosed).toBe(true)
    expect(port.pendingCount).toBe(0)
    expect(port.eventEmitter.listenerCount('message')).toBe(0)
  })

  it('validates request messages, options, subscriptions, and scope', async () => {
    const port = new EventBusPort({ runId: 'run' })
    await expect(port.request(makeMessage(), { timeoutMs: 10 }))
      .rejects.toBeInstanceOf(MessageValidationError)
    await expect(port.request(makeMessage({
      type: COMM_RESPONSE_TYPE,
      correlationId: 'response',
    }), { timeoutMs: 10 })).rejects.toBeInstanceOf(MessageValidationError)
    await expect(port.request(makeMessage({ correlationId: 'negative' }), {
      timeoutMs: -1,
    })).rejects.toBeInstanceOf(MessageValidationError)
    await expect(port.send(makeMessage({ type: '' })))
      .rejects.toBeInstanceOf(MessageValidationError)
    await expect(port.send(makeMessage({ sender: '' })))
      .rejects.toBeInstanceOf(MessageValidationError)
    expect(() => port.subscribe(
      undefined as unknown as () => boolean,
      () => undefined,
    )).toThrow(MessageValidationError)
    expect(() => new EventBusPort({ runId: '' })).toThrow(MessageValidationError)
    expect(() => new EventBusPort({ runId: 'run', attemptId: '' }))
      .toThrow(MessageValidationError)
  })

  it('supports an injected emitter and configured listener limit', () => {
    const emitter = new EventBusEmitter(10)
    const port = new EventBusPort(
      { runId: 'run' },
      { emitter, maxListeners: 20 },
    )
    expect(port.eventEmitter).toBe(emitter)
    expect(emitter.getMaxListeners()).toBe(20)
  })
})
