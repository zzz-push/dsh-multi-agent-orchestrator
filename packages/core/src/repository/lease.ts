import { LeaseLostError } from '../run/errors.js'
import type { RunId } from '../run/types.js'
import { systemClock, type Clock } from '../ports.js'

/**
 * The right to advance one run, held by one scheduler for a bounded time
 * (cross-process ownership uses a repository-level lease/lock). The holder
 * renews it while it works; if it dies, the lease expires and another
 * scheduler can take the run over.
 */
export interface RunLease {
  runId: RunId
  /** Scheduler identity, unique per scheduler instance. */
  owner: string
  /**
   * Fencing token: strictly increases every time the lease changes hands, so
   * "the lease I renewed" and "a lease someone took after mine expired" are
   * distinguishable even when the owner string happens to repeat.
   */
  token: number
  /** Epoch milliseconds after which the lease is free for anyone. */
  expiresAt: number
}

/**
 * Where scheduler leases live. Kept apart from `RunRepository` on purpose:
 * renewing a lease every few seconds must not bump the run's revision (every
 * renewal would otherwise conflict with the owner's own step writes), and a
 * lease store can be shared by repositories that know nothing about it.
 */
export interface RunLeaseStore {
  /**
   * Take the run's lease for `owner`, valid for `ttlMs`. Returns `undefined`
   * when another owner holds an unexpired lease. Re-acquiring a lease `owner`
   * already holds renews it.
   */
  acquire(runId: RunId, owner: string, ttlMs: number): Promise<RunLease | undefined>
  /** Extend a held lease. Throws `LeaseLostError` when it has changed hands. */
  renew(lease: RunLease, ttlMs: number): Promise<RunLease>
  /** Give the lease up early. A no-op when it already changed hands. */
  release(lease: RunLease): Promise<void>
  /** The current lease, expired or not; `undefined` when the run never had one. */
  get(runId: RunId): Promise<RunLease | undefined>
}

/** Default lease lifetime; the Scheduler renews at a third of it. */
export const DEFAULT_LEASE_TTL_MS = 30_000

/**
 * Process-local lease store: exact for schedulers sharing one process (and
 * for tests), meaningless across processes — use `FileRunLeaseStore` there.
 */
export class InMemoryRunLeaseStore implements RunLeaseStore {
  private readonly leases = new Map<RunId, RunLease & { released?: boolean }>()

  constructor(private readonly clock: Clock = systemClock) {}

  async acquire(runId: RunId, owner: string, ttlMs: number): Promise<RunLease | undefined> {
    const current = this.leases.get(runId)
    const now = this.clock.now()
    if (current !== undefined && current.released !== true && current.expiresAt > now && current.owner !== owner) {
      return undefined
    }
    const renewing = current !== undefined && current.released !== true && current.expiresAt > now && current.owner === owner
    const lease: RunLease = {
      runId,
      owner,
      token: renewing ? current.token : (current?.token ?? 0) + 1,
      expiresAt: now + ttlMs,
    }
    this.leases.set(runId, lease)
    return { ...lease }
  }

  async renew(lease: RunLease, ttlMs: number): Promise<RunLease> {
    const current = this.leases.get(lease.runId)
    if (current === undefined || current.token !== lease.token || current.owner !== lease.owner || current.released === true) {
      throw new LeaseLostError(lease.runId, current === undefined ? 'no lease on record' : `now held by ${current.owner} (token ${current.token})`)
    }
    const renewed = { ...current, expiresAt: this.clock.now() + ttlMs }
    this.leases.set(lease.runId, renewed)
    return { ...renewed }
  }

  async release(lease: RunLease): Promise<void> {
    const current = this.leases.get(lease.runId)
    if (current !== undefined && current.token === lease.token && current.owner === lease.owner) {
      this.leases.set(lease.runId, { ...current, released: true, expiresAt: 0 })
    }
  }

  async get(runId: RunId): Promise<RunLease | undefined> {
    const current = this.leases.get(runId)
    if (current === undefined) return undefined
    const { released: _released, ...lease } = current
    return lease
  }
}
