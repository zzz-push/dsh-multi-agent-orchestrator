import type {
  CommunicationCapabilities,
  CommunicationRequirements,
} from './capabilities.js'
import type {
  MessageFilter,
  MessageHandler,
  RequestOptions,
  Scope,
} from './types.js'

/** Versioned message envelope carried by a communication provider. */
export interface CommunicationMessage {
  schemaVersion: 1
  messageId: string
  runId: string
  attemptId?: string
  type: string
  sender: string
  recipient?: string
  correlationId?: string
  causationId?: string
  idempotencyKey?: string
  createdAt: number
  payload: unknown
}

/** A run/attempt-scoped communication port. */
export interface CommunicationPort {
  /** Accepts a message locally; acceptedAt does not imply remote handling. */
  send(message: CommunicationMessage): Promise<{ acceptedAt: number }>
  /** Sends a request and resolves with the first matching response. */
  request(
    message: CommunicationMessage,
    options: RequestOptions,
  ): Promise<CommunicationMessage>
  /** Adds a filtered subscription and returns an idempotent disposer. */
  subscribe(filter: MessageFilter, handler: MessageHandler): () => void
  /** Closes the port and rejects any pending requests. */
  close(): Promise<void>
}

/** Provider declaration and scoped port factory. */
export interface CommunicationProvider {
  readonly name: string
  readonly version: string
  readonly capabilities: CommunicationCapabilities
  /** Opens one independent port for a run/attempt scope. */
  open(scope: Scope): Promise<CommunicationPort>
}

/** Options used to acquire a provider lease. */
export interface AcquireOptions {
  /** Explicit provider name; omitted means deterministic capability matching. */
  provider?: string
  /** Required provider capabilities. */
  requirements: CommunicationRequirements
  /** Owning run identifier. */
  runId: string
  /** Optional attempt identifier. */
  attemptId?: string
  /** Cancels only the acquisition/open operation. */
  signal?: AbortSignal
}

/** A generation-pinned lease over one provider port. */
export interface CommunicationLease {
  readonly provider: string
  readonly version: string
  readonly generation: string
  readonly capabilities: CommunicationCapabilities
  readonly port: CommunicationPort
  /** Releases the lease and closes its port; safe to call repeatedly. */
  release(): Promise<void>
}

/** Registry service for provider registration, preflight, and leases. */
export interface CommunicationRegistry {
  /** Registers a provider and returns an idempotent unregister function. */
  register(provider: CommunicationProvider): () => void
  /** Resolves a compatible provider and opens a generation-pinned lease. */
  acquire(options: AcquireOptions): Promise<CommunicationLease>
}

export type {
  CommunicationCapabilities,
  CommunicationRequirements,
  MessageFilter,
  MessageHandler,
  RequestOptions,
  Scope,
}
