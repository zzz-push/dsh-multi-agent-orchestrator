import type {
  CommunicationCapabilities,
  CommunicationPort,
  CommunicationProvider,
  Scope,
} from '@dsh/spec'
import { EventBusPort } from './port.js'

/** Honest capability declaration for the in-process EventEmitter provider. */
export const EVENTBUS_CAPABILITIES: CommunicationCapabilities = {
  delivery: 'at-most-once',
  durable: false,
  ordering: 'none',
  requestReply: true,
  cancellation: 'local',
  maxMessageBytes: 1_000_000,
}

/** Options shared by ports opened by one provider instance. */
export interface EventBusProviderOptions {
  maxListeners?: number
  now?: () => number
}

/** Communication provider backed by an isolated Node EventEmitter per open. */
export class EventBusProvider implements CommunicationProvider {
  readonly name = 'event-emitter'
  readonly version = '1.0.0'
  readonly capabilities = EVENTBUS_CAPABILITIES

  constructor(private readonly options: EventBusProviderOptions = {}) {
    if (options.maxListeners !== undefined
      && (!Number.isSafeInteger(options.maxListeners) || options.maxListeners <= 0)) {
      throw new RangeError('maxListeners 必须是正安全整数')
    }
  }

  /** Opens a fresh port/emitter, isolating this scope from every other open. */
  async open(scope: Scope): Promise<CommunicationPort> {
    return new EventBusPort(scope, {
      maxListeners: this.options.maxListeners,
      now: this.options.now,
    })
  }
}

/** Factory helper for callers that prefer a plain provider value. */
export function createEventBusProvider(
  options: EventBusProviderOptions = {},
): EventBusProvider {
  return new EventBusProvider(options)
}
