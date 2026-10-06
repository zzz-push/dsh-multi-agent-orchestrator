import { randomUUID } from 'node:crypto'
import type { CommunicationMessage } from '@dsh/spec'
import { MessageValidationError } from './errors.js'

/** Reserved message type used for request/reply responses. */
export const COMM_RESPONSE_TYPE = 'dsh.comm.response'

/** Arguments accepted by createMessage. */
export interface CreateMessageArgs {
  runId: string
  attemptId?: string
  type: string
  sender: string
  recipient?: string
  correlationId?: string
  causationId?: string
  idempotencyKey?: string
  payload?: unknown
}

/** Creates a protocol-v1 communication message. */
export function createMessage(args: CreateMessageArgs): CommunicationMessage {
  return {
    schemaVersion: 1,
    messageId: randomUUID(),
    runId: args.runId,
    attemptId: args.attemptId,
    type: args.type,
    sender: args.sender,
    recipient: args.recipient,
    correlationId: args.correlationId,
    causationId: args.causationId,
    idempotencyKey: args.idempotencyKey,
    createdAt: Date.now(),
    payload: args.payload,
  }
}

/** Creates a response preserving the request's scope and correlation ID. */
export function makeResponse(
  request: CommunicationMessage,
  payload: unknown,
  sender: string,
): CommunicationMessage {
  if (!request.correlationId) {
    throw new MessageValidationError('makeResponse: 请求缺少 correlationId')
  }

  return createMessage({
    runId: request.runId,
    attemptId: request.attemptId,
    type: COMM_RESPONSE_TYPE,
    sender,
    recipient: request.sender,
    correlationId: request.correlationId,
    causationId: request.messageId,
    payload,
  })
}

/** Returns true when a message uses the reserved response type. */
export function isResponse(message: CommunicationMessage): boolean {
  return message.type === COMM_RESPONSE_TYPE
}
