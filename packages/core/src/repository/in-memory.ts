import { DuplicateRunError, RepositoryInvariantError, RevisionConflictError, RunNotFoundError } from '../run/errors.js'
import type { RunAggregate } from '../run/types.js'
import type { RunQuery, RunRepository, RunSummary } from './types.js'

function clone<T>(value: T): T {
  return structuredClone(value)
}

/**
 * Process-local repository used by the MVP and testkit.
 * TODO: replace with a durable repository when runs must survive process restart or
 * multiple scheduler processes must share ownership.
 */
export class InMemoryRunRepository implements RunRepository {
  private readonly runs = new Map<string, RunAggregate>()

  async create(run: RunAggregate): Promise<void> {
    if (this.runs.has(run.id)) {
      throw new DuplicateRunError(run.id)
    }
    if (run.revision < 0) {
      throw new RepositoryInvariantError(`Run ${run.id} revision cannot be negative`)
    }
    this.runs.set(run.id, clone(run))
  }

  async get(runId: string): Promise<RunAggregate | undefined> {
    const run = this.runs.get(runId)
    return run === undefined ? undefined : clone(run)
  }

  async update(
    runId: string,
    expectedRevision: number,
    mutate: (current: RunAggregate) => RunAggregate,
  ): Promise<RunAggregate> {
    const current = this.runs.get(runId)
    if (current === undefined) {
      throw new RunNotFoundError(runId)
    }
    if (current.revision !== expectedRevision) {
      throw new RevisionConflictError(runId, expectedRevision, current.revision)
    }
    const candidate = clone(mutate(clone(current)))
    if (candidate.id !== runId) {
      throw new RepositoryInvariantError(`Run update changed id from ${runId} to ${candidate.id}`)
    }
    if (candidate.schemaVersion !== 1) {
      throw new RepositoryInvariantError(`Unsupported run schema version for ${runId}`)
    }
    candidate.revision = current.revision + 1
    candidate.updatedAt = Math.max(candidate.updatedAt, current.updatedAt)
    this.runs.set(runId, clone(candidate))
    return clone(candidate)
  }

  async list(query: RunQuery = {}): Promise<RunSummary[]> {
    const statuses = query.status === undefined
      ? undefined
      : Array.isArray(query.status) ? query.status : [query.status]
    const summaries = [...this.runs.values()]
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
}
