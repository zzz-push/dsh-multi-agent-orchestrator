import { DshError } from '@dsh/spec'
import type { CapabilityFailure } from '@dsh/spec'

/** Thrown when a provider declaration is malformed. */
export class InvalidProviderError extends DshError {
  readonly code = 'INVALID_PROVIDER'
}

/** Thrown when lease acquisition options are malformed. */
export class InvalidAcquireOptionsError extends DshError {
  readonly code = 'INVALID_ACQUIRE_OPTIONS'
}

/** Thrown when an explicitly selected provider is not registered. */
export class ProviderNotFoundError extends DshError {
  readonly code = 'PROVIDER_NOT_FOUND'
}

/** Thrown when only a draining generation exists for a provider name. */
export class ProviderDrainingError extends DshError {
  readonly code = 'PROVIDER_DRAINING'
}

/** Thrown when no provider satisfies the requested capability matrix. */
export class PreflightError extends DshError {
  readonly code = 'PREFLIGHT_FAILED'
  readonly failures: CapabilityFailure[]

  constructor(
    message: string,
    failures: CapabilityFailure[] = [],
    providerFailures: ReadonlyArray<{
      name: string
      version: string
      failures: CapabilityFailure[]
    }> = [],
  ) {
    super(message, {
      details: {
        failures,
        providers: providerFailures,
      },
    })
    this.failures = failures
  }
}

/** Thrown when provider.open fails or misses its deadline. */
export class ProviderOpenError extends DshError {
  readonly code = 'PROVIDER_OPEN_FAILED'
}

/** Thrown when an operation targets a disposed registry. */
export class RegistryClosedError extends DshError {
  readonly code = 'REGISTRY_CLOSED'
}

/** Thrown when an operation targets a closed port. */
export class PortClosedError extends DshError {
  readonly code = 'PORT_CLOSED'
}

/** Thrown when a message or request option violates the port contract. */
export class MessageValidationError extends DshError {
  readonly code = 'MESSAGE_VALIDATION_FAILED'
}

/** Thrown when a request/reply wait exceeds its deadline. */
export class RequestTimeoutError extends DshError {
  readonly code = 'REQUEST_TIMEOUT'
}

/** Thrown when acquisition or request/reply is aborted. */
export class RequestAbortedError extends DshError {
  readonly code = 'REQUEST_ABORTED'
}

export { DshError }
