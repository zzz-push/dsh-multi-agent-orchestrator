import { RunNotFoundError } from './run/errors.js'
import { isTerminalRunStatus, type RunAggregate, type RunStatus } from './run/types.js'
import type { RunRepository } from './repository/types.js'
import { systemClock, type Clock } from './ports.js'

export interface CancellationResult {
  run: RunAggregate
  changed: boolean
}

const CANCELLABLE_STATUSES: ReadonlySet<RunStatus> = new Set([
  'validating', 'ready', 'running', 'waiting_approval', 'waiting_action',
  'delivery_ready', 'applying', 'interrupted',
])

/**
 * Performs the state-layer half of cancellation and is safe to call repeatedly.
 *
 * The resource half — aborting the run's agents and checks, then finalizing
 * to `cancelled` or `interrupted` — belongs to whichever scheduler owns the
 * run: it notices the persisted request on its own (within its poll
 * interval). `Scheduler.cancel()` does both halves at once when a scheduler
 * is at hand.
 */
export async function requestCancellation(
  repository: RunRepository,
  runId: string,
  clock: Clock = systemClock,
): Promise<CancellationResult> {
  for (;;) {
    const current = await repository.get(runId)
    if (current === undefined) throw new RunNotFoundError(runId)
    if (current.cancelRequestedAt !== undefined || current.status === 'cancelling' || isTerminalRunStatus(current.status)) {
      return { run: current, changed: false }
    }
    if (!CANCELLABLE_STATUSES.has(current.status)) {
      return { run: current, changed: false }
    }
    try {
      const updated = await repository.update(runId, current.revision, (run) => ({
        ...run,
        cancelRequestedAt: clock.now(),
        status: 'cancelling',
      }))
      return { run: updated, changed: true }
    } catch (error) {
      if (error instanceof Error && error.name === 'RevisionConflictError') continue
      throw error
    }
  }
}

export async function cancelRun(
  repository: RunRepository,
  runId: string,
  clock: Clock = systemClock,
): Promise<RunAggregate> {
  return (await requestCancellation(repository, runId, clock)).run
}

export class CancellationService {
  constructor(private readonly repository: RunRepository, private readonly clock: Clock = systemClock) {}

  request(runId: string): Promise<CancellationResult> {
    return requestCancellation(this.repository, runId, this.clock)
  }

  cancel(runId: string): Promise<RunAggregate> {
    return cancelRun(this.repository, runId, this.clock)
  }
}
