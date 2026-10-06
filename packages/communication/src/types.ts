export type {
  AcquireOptions,
  AttemptId,
  CancellationSemantics,
  CapabilityFailure,
  CapabilityFailureCode,
  CommunicationCapabilities,
  CommunicationLease,
  CommunicationMessage,
  CommunicationPort,
  CommunicationProvider,
  CommunicationRegistry,
  CommunicationRequirements,
  CompatibilityResult,
  DeliverySemantics,
  MessageFilter,
  MessageHandler,
  OrderingSemantics,
  ProviderGeneration,
  ProviderName,
  ProviderVersion,
  RequestOptions,
  RunId,
  Scope,
} from '@dsh/spec'

/** Lifecycle state of a registered provider generation. */
export type EntryStatus = 'active' | 'draining' | 'removed'

/** Lifecycle state of an acquired lease. */
export type LeaseState = 'opening' | 'active' | 'releasing' | 'released'

/** Why a provider generation stopped accepting new leases. */
export type DrainReason = 'unregistered' | 'replaced' | 'registry-disposed'

/** Event emitted when a drain deadline forcibly releases a lease. */
export interface ForcedReleaseEvent {
  leaseId: string
  runId: string
  attemptId?: string
  providerName: string
  generation: string
  reason: DrainReason
  forcedAt: number
}

/** Summary emitted after a provider generation is fully removed. */
export interface EntrySummary {
  name: string
  version: string
  generation: string
  drainReason?: DrainReason
  drainStartedAt?: number
}

/** Read-only registry state intended for diagnostics and tests. */
export interface RegistrySnapshot {
  providers: Array<{
    name: string
    version: string
    generation: string
    capabilities: import('@dsh/spec').CommunicationCapabilities
    status: EntryStatus
    drainReason?: DrainReason
    drainStartedAt?: number
    leaseCount: number
  }>
  leases: Array<{
    leaseId: string
    runId: string
    attemptId?: string
    providerName: string
    generation: string
    state: LeaseState
  }>
}
