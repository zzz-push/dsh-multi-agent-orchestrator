import { describe, expect, it, vi } from 'vitest'
import { MessageValidationError } from '../src/errors.js'
import {
  COMM_RESPONSE_TYPE,
  createMessage,
  isResponse,
  makeResponse,
} from '../src/messages.js'

describe('message helpers', () => {
  it('creates a protocol-v1 envelope', () => {
    vi.spyOn(Date, 'now').mockReturnValue(123)
    const message = createMessage({
      runId: 'run',
      attemptId: 'attempt',
      type: 'question',
      sender: 'kernel',
      correlationId: 'correlation',
      payload: { value: 1 },
    })
    expect(message).toMatchObject({
      schemaVersion: 1,
      runId: 'run',
      attemptId: 'attempt',
      type: 'question',
      sender: 'kernel',
      correlationId: 'correlation',
      createdAt: 123,
      payload: { value: 1 },
    })
    expect(message.messageId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('builds and identifies a correlated response', () => {
    const request = createMessage({
      runId: 'run',
      type: 'question',
      sender: 'kernel',
      correlationId: 'correlation',
    })
    const response = makeResponse(request, 'answer', 'worker')
    expect(response).toMatchObject({
      type: COMM_RESPONSE_TYPE,
      runId: request.runId,
      sender: 'worker',
      recipient: 'kernel',
      correlationId: 'correlation',
      causationId: request.messageId,
      payload: 'answer',
    })
    expect(isResponse(response)).toBe(true)
    expect(isResponse(request)).toBe(false)
  })

  it('rejects a response to an uncorrelated request', () => {
    const request = createMessage({
      runId: 'run',
      type: 'notification',
      sender: 'kernel',
    })
    expect(() => makeResponse(request, null, 'worker'))
      .toThrow(MessageValidationError)
  })
})
