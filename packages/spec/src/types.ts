/** Stable identifiers used by the communication protocol. */
export type RunId = string
export type AttemptId = string
export type ProviderName = string
export type ProviderVersion = string
export type ProviderGeneration = string

/** The scope in which a communication port is allowed to operate. */
export interface Scope {
  runId: RunId
  attemptId?: AttemptId
}

/** A callback invoked for a matching communication message. */
export type MessageHandler = (message: CommunicationMessage) => Promise<void> | void

/** A predicate used to select messages for a subscription. */
export type MessageFilter = (message: CommunicationMessage) => boolean

/** Options controlling a request/reply wait. */
export interface RequestOptions {
  /** Maximum time to wait, in milliseconds. */
  timeoutMs: number
  /** Cancels the local wait when aborted. */
  signal?: AbortSignal
}

// Imported as a type to keep this foundational module free of runtime cycles.
import type { CommunicationMessage } from './communication.js'
