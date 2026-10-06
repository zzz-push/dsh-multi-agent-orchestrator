import type { Dirent } from 'node:fs'
import { access, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'

import { DuplicateRunError, RepositoryInvariantError, RevisionConflictError, RunNotFoundError } from '../run/errors.js'
import type { RunAggregate } from '../run/types.js'
import { isErrno, listSequence, publishExclusive, pruneSequence, sequenceFileName } from './fs-atomic.js'
import type { RunQuery, RunRepository, RunSummary } from './types.js'

/**
 * Run ids double as file names, so they are held to a conservative shape:
 * no path separators, no leading dot, bounded length. `randomUUID()` (what
 * `startWorkflow()` generates) satisfies this; a caller-supplied id that does
 * not is rejected with `RepositoryInvariantError` rather than resolved
 * relative to `dir` and possibly escaping it.
 */
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** How many revision documents to keep per run: the current one and the one before. */
const KEPT_REVISIONS = 2

/** Options for {@link FileRunRepository}. */
export interface FileRunRepositoryOptions {
  /**
   * Directory holding one sub-directory per run (`<runId>/`, one JSON file
   * per revision). Created lazily on the first write, so constructing the
   * repository has no filesystem side effect.
   */
  dir: string
  /**
   * Called by {@link FileRunRepository.list} for a run that is not a
   * readable, well-formed run document. The run is skipped so one damaged
   * run cannot hide every other run from a listing; `get()` on that specific
   * id still throws, so nothing downstream mistakes it for healthy. Absent,
   * skips are silent — pass a logger hook to make them visible.
   */
  onSkippedFile?: (file: string, error: unknown) => void
}

/**
 * Durable `RunRepository` backed by plain files, safe to share
 * between processes.
 *
 * Why a plain directory of files rather than the Harness `ctx.storageDomain`?
 * The Kernel stays free of Harness imports, and — after the roles-first repositioning in
 * the public design — the main way roles get
 * exercised is a guided-mode call from an ordinary agent session with no DSH
 * runtime in the picture. Runs recorded there have to be readable from there.
 * A `StorageDomainRunRepository` in the plugin layer remains the right adapter
 * for in-Harness deployments; the port isolates that choice from callers.
 *
 * Layout: `<dir>/<runId>/<revision>.json`, one complete document per
 * revision, the highest number being the current state. The two newest are
 * kept; older ones are pruned after each write. (Before behavior the layout
 * was a single `<dir>/<runId>.json`; such a document is still read, and the
 * first update moves the run to the new layout.)
 *
 * Guarantees, and their limits:
 *
 * - **Atomic documents.** A revision is written to a temp file and linked
 *   into place, so a reader never observes a half-written run.
 * - **CAS across processes.** Revision N+1 is created with `link(2)`, which
 *   refuses to overwrite: of any number of writers — in this process or
 *   others — racing from revision N, exactly one creates N+1 and the rest get
 *   `RevisionConflictError`. There is no lock file, so a writer that dies
 *   mid-update leaves nothing to clean up. Same-process calls are
 *   additionally queued per run id, so they do not even race.
 * - **JSON round trip.** Keys whose value is `undefined` are dropped on write.
 *   `RunAggregate` does not distinguish an absent key from an `undefined`
 *   one, so this is invisible to callers, but it does mean a document read
 *   back is `toEqual` to what was stored, not `toStrictEqual`. Non-finite
 *   numbers (`Infinity`, `NaN`) have no JSON form and are refused at write
 *   time with `RepositoryInvariantError` instead of being rewritten to
 *   `null`.
 * - **`list()` reads every run.** Fine for the volumes a single project
 *   accumulates; if it ever is not, an index file is the obvious next step and
 *   nothing in the port shape prevents adding one.
 */
export class FileRunRepository implements RunRepository {
  private readonly dir: string
  private readonly onSkippedFile: ((file: string, error: unknown) => void) | undefined
  /** Per-run tail of the in-process write queue. */
  private readonly tails = new Map<string, Promise<unknown>>()

  constructor(options: FileRunRepositoryOptions) {
    this.dir = options.dir
    this.onSkippedFile = options.onSkippedFile
  }

  async create(run: RunAggregate): Promise<void> {
    const runDir = this.dirFor(run.id)
    await this.serialised(run.id, async () => {
      if (await exists(this.legacyFileFor(run.id)) || (await listSequence(runDir)).length > 0) {
        throw new DuplicateRunError(run.id)
      }
      if (run.revision < 0) {
        throw new RepositoryInvariantError(`Run ${run.id} revision cannot be negative`)
      }
      // Serialise before touching the filesystem: a document that cannot be
      // represented faithfully must fail here, not land on disk altered.
      const text = serialise(run)
      await mkdir(runDir, { recursive: true })
      try {
        await publishExclusive(path.join(runDir, sequenceFileName(run.revision)), text)
      } catch (error) {
        if (isErrno(error, 'EEXIST')) throw new DuplicateRunError(run.id)
        throw error
      }
    })
  }

  async get(runId: string): Promise<RunAggregate | undefined> {
    const runDir = this.dirFor(runId)
    // A concurrent writer may prune the revision we just listed; look again.
    for (let round = 0; round < 5; round += 1) {
      const latest = (await listSequence(runDir)).at(-1)
      if (latest === undefined) return this.read(this.legacyFileFor(runId), runId)
      const run = await this.read(path.join(runDir, sequenceFileName(latest)), runId)
      if (run !== undefined) {
        if (run.revision !== latest) {
          throw new RepositoryInvariantError(`Run document ${runId}/${sequenceFileName(latest)} carries revision ${run.revision}`)
        }
        return run
      }
    }
    throw new RepositoryInvariantError(`Run ${runId} kept changing while being read`)
  }

  async update(
    runId: string,
    expectedRevision: number,
    mutate: (current: RunAggregate) => RunAggregate,
  ): Promise<RunAggregate> {
    const runDir = this.dirFor(runId)
    return this.serialised(runId, async () => {
      const current = await this.get(runId)
      if (current === undefined) {
        throw new RunNotFoundError(runId)
      }
      if (current.revision !== expectedRevision) {
        throw new RevisionConflictError(runId, expectedRevision, current.revision)
      }
      // `current` is a fresh parse, so handing it to `mutate` directly cannot
      // alias anything the repository still holds — unlike the in-memory
      // store, there is no shared object to protect with a clone.
      const candidate = mutate(current)
      if (candidate.id !== runId) {
        throw new RepositoryInvariantError(`Run update changed id from ${runId} to ${candidate.id}`)
      }
      if (candidate.schemaVersion !== 1) {
        throw new RepositoryInvariantError(`Unsupported run schema version for ${runId}`)
      }
      candidate.revision = expectedRevision + 1
      candidate.updatedAt = Math.max(candidate.updatedAt, current.updatedAt)
      const text = serialise(candidate)
      await mkdir(runDir, { recursive: true })
      try {
        await publishExclusive(path.join(runDir, sequenceFileName(candidate.revision)), text)
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error
        // Another process claimed this revision first.
        const actual = (await this.get(runId))?.revision ?? candidate.revision
        throw new RevisionConflictError(runId, expectedRevision, actual)
      }
      // The legacy single document, if this run had one, is superseded now.
      await rm(this.legacyFileFor(runId), { force: true }).catch(() => undefined)
      await pruneSequence(runDir, candidate.revision - KEPT_REVISIONS + 1)
      // Return the persisted shape, not the caller's object graph: what the
      // caller gets back must equal what a later `get()` will return.
      return JSON.parse(text) as RunAggregate
    })
  }

  async list(query: RunQuery = {}): Promise<RunSummary[]> {
    let entries: Dirent[]
    try {
      entries = await readdir(this.dir, { withFileTypes: true })
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return []
      throw error
    }
    const statuses = query.status === undefined
      ? undefined
      : Array.isArray(query.status) ? query.status : [query.status]
    const directories = new Set(entries.filter((entry) => entry.isDirectory() && SAFE_RUN_ID.test(entry.name)).map((entry) => entry.name))
    const ids = new Map<string, string>()
    for (const name of directories) ids.set(name, path.join(this.dir, name))
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const runId = entry.name.slice(0, -'.json'.length)
      if (!directories.has(runId)) ids.set(runId, path.join(this.dir, entry.name))
    }
    const runs: RunAggregate[] = []
    for (const [runId, file] of ids) {
      try {
        const run = await this.get(runId)
        if (run !== undefined) runs.push(run)
      } catch (error) {
        this.onSkippedFile?.(file, error)
      }
    }
    const summaries = runs
      .filter((run) => query.workflowId === undefined || run.workflowId === query.workflowId)
      .filter((run) => statuses === undefined || statuses.includes(run.status))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((run): RunSummary => ({
        id: run.id,
        revision: run.revision,
        status: run.status,
        workflowId: run.workflowId,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      }))
    return query.limit === undefined ? summaries : summaries.slice(0, Math.max(0, query.limit))
  }

  private dirFor(runId: string): string {
    if (!SAFE_RUN_ID.test(runId)) {
      throw new RepositoryInvariantError(`Run id ${JSON.stringify(runId)} is not a safe file name`)
    }
    return path.join(this.dir, runId)
  }

  private legacyFileFor(runId: string): string {
    return `${this.dirFor(runId)}.json`
  }

  /** Parse one run document; `undefined` when absent, throws when present but not a run. */
  private async read(file: string, runId: string): Promise<RunAggregate | undefined> {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch (error) {
      throw new RepositoryInvariantError(`Run document ${file} is not valid JSON: ${String(error)}`)
    }
    if (typeof value !== 'object' || value === null) {
      throw new RepositoryInvariantError(`Run document ${file} is not an object`)
    }
    const run = value as RunAggregate
    if (run.id !== runId) {
      throw new RepositoryInvariantError(`Run document ${file} carries id ${JSON.stringify(run.id)}, expected ${runId}`)
    }
    if (run.schemaVersion !== 1) {
      throw new RepositoryInvariantError(`Unsupported run schema version for ${runId}`)
    }
    if (typeof run.revision !== 'number' || run.revision < 0) {
      throw new RepositoryInvariantError(`Run document ${file} has an invalid revision`)
    }
    return run
  }

  /** Run `operation` after every earlier operation on the same run id has settled. */
  private serialised<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(runId) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    // Keep the chain alive regardless of outcome, and forget it once idle so
    // the map does not grow with every run this process ever touched.
    const tail = next.then(() => undefined, () => undefined)
    this.tails.set(runId, tail)
    void tail.then(() => {
      if (this.tails.get(runId) === tail) this.tails.delete(runId)
    })
    return next
  }
}

/**
 * `JSON.stringify` silently turns `Infinity`/`NaN` into `null`, which is how
 * an "unlimited" `maxParallel` once became a type-violating `null` on its way
 * through this repository. Refuse rather than rewrite: the port promises that
 * what comes back equals what went in.
 */
function serialise(run: RunAggregate): string {
  return JSON.stringify(run, (key, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new RepositoryInvariantError(
        `Run ${run.id} field ${JSON.stringify(key)} is ${String(value)}, which cannot be stored; encode "unlimited" by omitting the field`,
      )
    }
    return value
  })
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false
    throw error
  }
}
