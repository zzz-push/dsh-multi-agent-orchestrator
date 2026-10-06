/** Minimum record shape tracked by LeaseManager. */
export interface TrackedLease {
  id: string
}

/** Small synchronous lease index used by CommunicationRegistryImpl. */
export class LeaseManager<TLease extends TrackedLease = TrackedLease> {
  private readonly leases = new Map<string, TLease>()

  /** Number of currently tracked leases. */
  get size(): number {
    return this.leases.size
  }

  /** Adds a new lease and rejects accidental ID reuse. */
  add(lease: TLease): void {
    if (this.leases.has(lease.id)) {
      throw new Error(`lease id already exists: ${lease.id}`)
    }
    this.leases.set(lease.id, lease)
  }

  /** Finds one tracked lease. */
  get(id: string): TLease | undefined {
    return this.leases.get(id)
  }

  /** Returns whether a lease remains tracked. */
  has(id: string): boolean {
    return this.leases.has(id)
  }

  /** Removes a lease; repeated removals are harmless. */
  remove(id: string): boolean {
    return this.leases.delete(id)
  }

  /** Returns a stable snapshot suitable for safe iteration. */
  values(): TLease[] {
    return [...this.leases.values()]
  }

  /** Removes all tracked leases. */
  clear(): void {
    this.leases.clear()
  }
}
