/** Failure categories used by the execution engine. */
export enum FailureCode {
  WorkflowInvalid = 'workflow_invalid',
  RepositoryInvalid = 'repository_invalid',
  ProviderUnavailable = 'provider_unavailable',
  ProviderRateLimited = 'provider_rate_limited',
  ProviderAuthFailed = 'provider_auth_failed',
  ProviderRequestInvalid = 'provider_request_invalid',
  ContextLimitExceeded = 'context_limit_exceeded',
  AgentProtocolInvalid = 'agent_protocol_invalid',
  StepTimeout = 'step_timeout',
  PolicyViolation = 'policy_violation',
  VerificationFailed = 'verification_failed',
  MergeConflict = 'merge_conflict',
  BudgetExceeded = 'budget_exceeded',
  SandboxUnavailable = 'sandbox_unavailable',
  HostIoFailed = 'host_io_failed',
  /** The agent's completion report was `failed`/`blocked` with no more specific category. */
  AgentFailed = 'agent_failed',
  Cancelled = 'cancelled',
  Interrupted = 'interrupted',
  InternalInvariant = 'internal_invariant',
}

export type FailureCodeValue = `${FailureCode}`

/** A bounded, user-actionable failure; secrets and provider payloads are deliberately absent. */
export interface FailureRecord {
  code: FailureCode | FailureCodeValue
  message: string
  retryable: boolean
  stepId?: string
  attempt?: number
  causeRef?: string
  occurredAt: number
  runRevision: number
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /(?:api[_-]?key|authorization|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
  /sk-[A-Za-z0-9_-]+/g,
]

/** Redacts common credential-shaped fragments before a message is persisted. */
export function sanitizeFailureMessage(message: string): string {
  let result = message
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[redacted]')
  }
  return result.slice(0, 4_096)
}

export interface FailureInput {
  code: FailureCode | FailureCodeValue
  message: string
  retryable: boolean
  stepId?: string
  attempt?: number
  causeRef?: string
  occurredAt: number
  runRevision: number
}

export function createFailureRecord(input: FailureInput): FailureRecord {
  return {
    code: input.code,
    message: sanitizeFailureMessage(input.message),
    retryable: input.retryable,
    stepId: input.stepId,
    attempt: input.attempt,
    causeRef: input.causeRef?.slice(0, 512),
    occurredAt: input.occurredAt,
    runRevision: input.runRevision,
  }
}

/** Raised when a state transition is not present in the design table. */
export class InvalidTransitionError extends Error {
  readonly entity: 'run' | 'step'
  readonly current: string
  readonly target: string
  readonly revision: number

  constructor(entity: 'run' | 'step', current: string, target: string, revision: number) {
    super(`Invalid ${entity} transition: ${current} -> ${target} at revision ${revision}`)
    this.name = 'InvalidTransitionError'
    this.entity = entity
    this.current = current
    this.target = target
    this.revision = revision
  }
}

export class RevisionConflictError extends Error {
  readonly runId: string
  readonly expectedRevision: number
  readonly actualRevision: number

  constructor(runId: string, expectedRevision: number, actualRevision: number) {
    super(`Run ${runId} revision conflict: expected ${expectedRevision}, actual ${actualRevision}`)
    this.name = 'RevisionConflictError'
    this.runId = runId
    this.expectedRevision = expectedRevision
    this.actualRevision = actualRevision
  }
}

export class DuplicateRunError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} already exists`)
    this.name = 'DuplicateRunError'
  }
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} was not found`)
    this.name = 'RunNotFoundError'
  }
}

export class RepositoryInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RepositoryInvariantError'
  }
}

/** Another scheduler — in this process or another one — currently owns the run. */
export class RunLeaseHeldError extends Error {
  readonly runId: string
  readonly owner: string
  readonly expiresAt: number

  constructor(runId: string, owner: string, expiresAt: number) {
    super(`Run ${runId} is owned by scheduler ${owner} until ${new Date(expiresAt).toISOString()}`)
    this.name = 'RunLeaseHeldError'
    this.runId = runId
    this.owner = owner
    this.expiresAt = expiresAt
  }
}

/**
 * A scheduler's lease on a run expired and was taken by another owner. The
 * old owner must stop writing: whatever it would write next is based on a
 * view of the run the new owner may already have moved past.
 */
export class LeaseLostError extends Error {
  readonly runId: string

  constructor(runId: string, detail: string) {
    super(`Lost the lease on run ${runId}: ${detail}`)
    this.name = 'LeaseLostError'
    this.runId = runId
  }
}
