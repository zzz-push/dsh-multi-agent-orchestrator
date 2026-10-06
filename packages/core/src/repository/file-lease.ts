import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { LeaseLostError, RepositoryInvariantError } from '../run/errors.js'
import type { RunId } from '../run/types.js'
import { systemClock, type Clock } from '../ports.js'
import { isErrno, listSequence, publishExclusive, pruneSequence, replaceAtomic, sequenceFileName } from './fs-atomic.js'
import type { RunLease, RunLeaseStore } from './lease.js'

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Options for {@link FileRunLeaseStore}. */
export interface FileRunLeaseStoreOptions {
  /**
   * Base directory. Leases live under `<dir>/.leases/<runId>/`; pointing this
   * at the same directory as a `FileRunRepository` is the intended setup —
   * the leading dot keeps the repository's listing from mistaking it for a
   * run.
   */
  dir: string
  clock?: Clock
}

interface StoredLease extends RunLease {
  released?: boolean
}

/**
 * Cross-process `RunLeaseStore` on a plain directory.
 *
 * Every hand-over of a run's lease creates a new file named by its fencing
 * token (`000000000003.json`), created with `link(2)` so exactly one of two
 * racing schedulers can claim token N+1. The newest file is the lease;
 * renewals and releases rewrite only that file, and only its holder writes
 * it. A scheduler that dies simply stops renewing, and the lease becomes
 * free when `expiresAt` passes — there is no lock to be left stale.
 *
 * Clock caveat: expiry compares wall clocks, so schedulers on different
 * machines sharing one directory need clocks closer together than the TTL.
 */
export class FileRunLeaseStore implements RunLeaseStore {
  private readonly root: string
  private readonly clock: Clock

  constructor(options: FileRunLeaseStoreOptions) {
    this.root = path.join(options.dir, '.leases')
    this.clock = options.clock ?? systemClock
  }

  async acquire(runId: RunId, owner: string, ttlMs: number): Promise<RunLease | undefined> {
    const dir = this.dirFor(runId)
    // Each round either returns or observed someone else's move; a handful of
    // rounds is plenty — a live contender wins and we report the run as held.
    for (let round = 0; round < 8; round += 1) {
      const latestToken = (await listSequence(dir)).at(-1)
      const current = latestToken === undefined ? undefined : await this.read(dir, latestToken)
      if (latestToken !== undefined && current === undefined) continue // pruned under us; look again
      const now = this.clock.now()
      if (current !== undefined && current.released !== true && current.expiresAt > now) {
        if (current.owner !== owner) return undefined
        return this.renew(current, ttlMs)
      }
      const next: RunLease = { runId, owner, token: (latestToken ?? 0) + 1, expiresAt: now + ttlMs }
      await mkdir(dir, { recursive: true })
      try {
        await publishExclusive(path.join(dir, sequenceFileName(next.token)), JSON.stringify(next))
      } catch (error) {
        if (isErrno(error, 'EEXIST')) continue
        throw error
      }
      await pruneSequence(dir, next.token)
      return next
    }
    return undefined
  }

  async renew(lease: RunLease, ttlMs: number): Promise<RunLease> {
    const dir = this.dirFor(lease.runId)
    await this.readLatestHeldBy(dir, lease)
    const renewed: RunLease = { runId: lease.runId, owner: lease.owner, token: lease.token, expiresAt: this.clock.now() + ttlMs }
    await replaceAtomic(path.join(dir, sequenceFileName(lease.token)), JSON.stringify(renewed))
    // A taker can only have published a newer token if ours had already
    // expired; if one appeared while we were writing, it is theirs now.
    const after = (await listSequence(dir)).at(-1)
    if (after !== lease.token) {
      throw new LeaseLostError(lease.runId, `taken over with token ${String(after)} while renewing token ${lease.token}`)
    }
    return renewed
  }

  async release(lease: RunLease): Promise<void> {
    const dir = this.dirFor(lease.runId)
    try {
      await this.readLatestHeldBy(dir, lease)
    } catch (error) {
      if (error instanceof LeaseLostError) return
      throw error
    }
    const released: StoredLease = { ...lease, expiresAt: 0, released: true }
    await replaceAtomic(path.join(dir, sequenceFileName(lease.token)), JSON.stringify(released))
  }

  async get(runId: RunId): Promise<RunLease | undefined> {
    const dir = this.dirFor(runId)
    for (let round = 0; round < 3; round += 1) {
      const latestToken = (await listSequence(dir)).at(-1)
      if (latestToken === undefined) return undefined
      const current = await this.read(dir, latestToken)
      if (current === undefined) continue
      const { released: _released, ...lease } = current
      return lease
    }
    return undefined
  }

  private async readLatestHeldBy(dir: string, lease: RunLease): Promise<StoredLease> {
    const latestToken = (await listSequence(dir)).at(-1)
    if (latestToken !== lease.token) {
      throw new LeaseLostError(lease.runId, `newest token is ${String(latestToken)}, held token is ${lease.token}`)
    }
    const current = await this.read(dir, latestToken)
    if (current === undefined || current.owner !== lease.owner || current.released === true) {
      throw new LeaseLostError(lease.runId, current === undefined ? 'lease file vanished' : `token ${lease.token} is no longer held by ${lease.owner}`)
    }
    return current
  }

  /** A lease file, or `undefined` when it vanished. An unreadable file reads as free. */
  private async read(dir: string, token: number): Promise<StoredLease | undefined> {
    let text: string
    try {
      text = await readFile(path.join(dir, sequenceFileName(token)), 'utf8')
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined
      throw error
    }
    try {
      const value = JSON.parse(text) as StoredLease
      if (typeof value.owner === 'string' && typeof value.expiresAt === 'number') return { ...value, token }
    } catch {
      // fall through: a damaged lease file must not wedge the run forever
    }
    return { runId: path.basename(dir), owner: '', token, expiresAt: 0, released: true }
  }

  private dirFor(runId: RunId): string {
    if (!SAFE_RUN_ID.test(runId)) {
      throw new RepositoryInvariantError(`Run id ${JSON.stringify(runId)} is not a safe file name`)
    }
    return path.join(this.root, runId)
  }
}
