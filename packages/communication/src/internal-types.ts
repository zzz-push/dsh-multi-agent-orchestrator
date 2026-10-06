import type {
  CommunicationCapabilities,
  CommunicationPort,
  CommunicationProvider,
} from '@dsh/spec'
import type {
  DrainReason,
  EntryStatus,
  LeaseState,
} from './types.js'

export interface ProviderEntry {
  name: string
  version: string
  generation: string
  capabilities: CommunicationCapabilities
  provider: CommunicationProvider
  status: EntryStatus
  leases: Set<LeaseEntry>
  drainReason?: DrainReason
  drainStartedAt?: number
  drainResolve?: () => void
}

export interface LeaseEntry {
  id: string
  runId: string
  attemptId?: string
  providerName: string
  generation: string
  state: LeaseState
  port?: CommunicationPort
  releasePromise?: Promise<void>
  cancelOpen?: (error: Error) => void
}
