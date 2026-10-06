import { describe, expect, it } from 'vitest'
import { requestCancellation, CancellationService } from '../src/cancellation.js'
import { InMemoryRunRepository } from '../src/repository/in-memory.js'
import { RunNotFoundError } from '../src/run/errors.js'
import { createRunAggregate } from '../src/run/types.js'
import type { Clock } from '../src/ports.js'

function makeRun(id: string, status: ReturnType<typeof createRunAggregate>['status'] = 'ready') {
  return createRunAggregate({
    id,
    repository: { root: '/repo', baseCommit: 'base' },
    steps: [{ id: 'a' }],
    status,
    now: 1_000,
  })
}

function fixedClock(now: number): Clock {
  return { now: () => now }
}

describe('requestCancellation', () => {
  it('writes cancelRequestedAt and moves the run to cancelling', async () => {
    const repo = new InMemoryRunRepository()
    await repo.create(makeRun('run-1', 'running'))

    const result = await requestCancellation(repo, 'run-1', fixedClock(5_000))
    expect(result.changed).toBe(true)
    expect(result.run.status).toBe('cancelling')
    expect(result.run.cancelRequestedAt).toBe(5_000)
  })

  it('is idempotent: a second call returns the existing fact without rewriting it', async () => {
    const repo = new InMemoryRunRepository()
    await repo.create(makeRun('run-1', 'running'))

    const first = await requestCancellation(repo, 'run-1', fixedClock(5_000))
    const second = await requestCancellation(repo, 'run-1', fixedClock(9_000))

    expect(second.changed).toBe(false)
    expect(second.run.cancelRequestedAt).toBe(5_000)
    expect(second.run.revision).toBe(first.run.revision)
  })

  it('does not cancel a run already in a terminal state', async () => {
    const repo = new InMemoryRunRepository()
    await repo.create(makeRun('run-1', 'applied'))

    const result = await requestCancellation(repo, 'run-1', fixedClock(5_000))
    expect(result.changed).toBe(false)
    expect(result.run.cancelRequestedAt).toBeUndefined()
    expect(result.run.status).toBe('applied')
  })

  it('throws RunNotFoundError for an unknown run', async () => {
    const repo = new InMemoryRunRepository()
    await expect(requestCancellation(repo, 'missing', fixedClock(1))).rejects.toThrow(RunNotFoundError)
  })

  it('never reverses a previously written cancelRequestedAt, even under repeated calls', async () => {
    const repo = new InMemoryRunRepository()
    await repo.create(makeRun('run-1', 'waiting_approval'))

    const results = await Promise.all([
      requestCancellation(repo, 'run-1', fixedClock(1_000)),
      requestCancellation(repo, 'run-1', fixedClock(2_000)),
      requestCancellation(repo, 'run-1', fixedClock(3_000)),
    ])

    const timestamps = new Set(results.map((result) => result.run.cancelRequestedAt))
    expect(timestamps.size).toBe(1)
  })

  it('CancellationService.request/cancel delegate to the same idempotent behavior', async () => {
    const repo = new InMemoryRunRepository()
    await repo.create(makeRun('run-1', 'running'))
    const service = new CancellationService(repo, fixedClock(4_000))

    const run = await service.cancel('run-1')
    expect(run.status).toBe('cancelling')
    const again = await service.request('run-1')
    expect(again.changed).toBe(false)
  })
})
