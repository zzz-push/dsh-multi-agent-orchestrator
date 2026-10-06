import type { RunAggregate, RunId, RunStatus } from '../run/types.js'

export interface RunQuery {
  status?: RunStatus | RunStatus[]
  workflowId?: string
  limit?: number
}

export interface RunSummary {
  id: RunId
  revision: number
  status: RunStatus
  workflowId: string
  createdAt: number
  updatedAt: number
}

export interface RunRepository {
  create(run: RunAggregate): Promise<void>
  get(runId: RunId): Promise<RunAggregate | undefined>
  update(
    runId: RunId,
    expectedRevision: number,
    mutate: (current: RunAggregate) => RunAggregate,
  ): Promise<RunAggregate>
  list(query?: RunQuery): Promise<RunSummary[]>
}
