import { describe, expect, it } from 'vitest'

import type { RunRepository } from '../src/repository/types.js'
import { DuplicateRunError, RevisionConflictError, RunNotFoundError } from '../src/run/errors.js'
import { createRunAggregate } from '../src/run/types.js'

export function makeRun(id: string) {
  return createRunAggregate({
    id,
    repository: { root: '/repo', baseCommit: 'base' },
    steps: [{ id: 'a' }, { id: 'b', dependsOn: ['a'] }],
    now: 1_000,
  })
}

/**
 * The `RunRepository` port contract, run identically against every
 * implementation. `factory` must return a fresh, empty repository per test.
 * A behaviour that only one implementation can offer belongs in that
 * implementation's own test file, not here.
 */
export function describeRunRepositoryContract(name: string, factory: () => Promise<RunRepository> | RunRepository) {
  describe(`${name}: RunRepository contract`, () => {
    it('creates and retrieves a run as independent clones', async () => {
      const repo = await factory()
      const run = makeRun('run-1')
      await repo.create(run)

      const fetched = await repo.get('run-1')
      expect(fetched).toEqual(run)
      expect(fetched).not.toBe(run)

      // Mutating the fetched clone must not leak back into the store.
      fetched!.status = 'failed'
      const fetchedAgain = await repo.get('run-1')
      expect(fetchedAgain!.status).toBe('ready')
    })

    it('rejects creating the same run id twice', async () => {
      const repo = await factory()
      await repo.create(makeRun('run-1'))
      await expect(repo.create(makeRun('run-1'))).rejects.toThrow(DuplicateRunError)
    })

    it('returns undefined for an unknown run', async () => {
      const repo = await factory()
      await expect(repo.get('missing')).resolves.toBeUndefined()
    })

    it('increments the revision monotonically on every successful update', async () => {
      const repo = await factory()
      await repo.create(makeRun('run-1'))

      const first = await repo.update('run-1', 0, (run) => ({ ...run, status: 'running' }))
      expect(first.revision).toBe(1)
      const second = await repo.update('run-1', 1, (run) => ({ ...run, status: 'waiting_action' }))
      expect(second.revision).toBe(2)
    })

    it('rejects an update with a stale expectedRevision (CAS conflict)', async () => {
      const repo = await factory()
      await repo.create(makeRun('run-1'))
      await repo.update('run-1', 0, (run) => ({ ...run, status: 'running' }))

      await expect(repo.update('run-1', 0, (run) => ({ ...run, status: 'failed' })))
        .rejects.toThrow(RevisionConflictError)
    })

    it('rejects updating a run that does not exist', async () => {
      const repo = await factory()
      await expect(repo.update('missing', 0, (run) => run)).rejects.toThrow(RunNotFoundError)
    })

    it('supports concurrent updaters where exactly one wins per revision', async () => {
      const repo = await factory()
      await repo.create(makeRun('run-1'))

      const attempts = await Promise.allSettled([
        repo.update('run-1', 0, (run) => ({ ...run, status: 'running' })),
        repo.update('run-1', 0, (run) => ({ ...run, status: 'cancelling' })),
      ])

      const fulfilled = attempts.filter((result) => result.status === 'fulfilled')
      const rejected = attempts.filter((result) => result.status === 'rejected')
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(RevisionConflictError)
    })

    it('filters and limits list() results by status and workflowId', async () => {
      const repo = await factory()
      await repo.create(makeRun('run-1'))
      await repo.create(makeRun('run-2'))
      await repo.update('run-2', 0, (run) => ({ ...run, status: 'running' }))

      const running = await repo.list({ status: 'running' })
      expect(running.map((summary) => summary.id)).toEqual(['run-2'])

      const limited = await repo.list({ limit: 1 })
      expect(limited).toHaveLength(1)
    })
  })
}
