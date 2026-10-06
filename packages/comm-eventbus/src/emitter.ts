import { EventEmitter } from 'node:events'
import type { CommunicationMessage } from '@dsh/spec'

/** Internal event name for message delivery. */
export const MESSAGE_EVENT = 'message'

/** Internal event name for non-fatal subscriber failures. */
export const HANDLER_ERROR_EVENT = 'handler-error'

/**
 * Small typed facade over Node's EventEmitter used by one EventBusPort.
 * A new instance is created for every provider.open call.
 */
export class EventBusEmitter extends EventEmitter {
  constructor(maxListeners = 64) {
    super()
    this.setMaxListeners(maxListeners)
  }

  /** Emits one scoped message to all port subscribers. */
  emitMessage(message: CommunicationMessage): boolean {
    return this.emit(MESSAGE_EVENT, message)
  }

  /** Reports a subscriber failure without closing the port. */
  emitHandlerError(error: unknown): boolean {
    return this.emit(HANDLER_ERROR_EVENT, error)
  }

  /** Adds a message listener with a typed callback. */
  onMessage(listener: (message: CommunicationMessage) => void): this {
    this.on(MESSAGE_EVENT, listener)
    return this
  }

  /** Removes a message listener. */
  offMessage(listener: (message: CommunicationMessage) => void): this {
    this.off(MESSAGE_EVENT, listener)
    return this
  }
}
