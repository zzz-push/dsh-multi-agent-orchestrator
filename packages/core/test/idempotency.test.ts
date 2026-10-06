import { describe, expect, it } from 'vitest'
import { IdempotencyRegistry, isDuplicateCommand } from '../src/scheduler/idempotency.js'
import { createRunAggregate } from '../src/run/types.js'

describe('IdempotencyRegistry', () => {
  it('reports no command as seen until it has been remembered', () => {
    const registry = new IdempotencyRegistry()
    expect(registry.hasCommand('run-1', 'cmd-1')).toBe(false)
  })

  it('remembers a command once and reports duplicates on the second attempt', () => {
    const registry = new IdempotencyRegistry()
    expect(registry.rememberCommand('run-1', 'cmd-1')).toBe(true)
    expect(registry.hasCommand('run-1', 'cmd-1')).toBe(true)
    expect(registry.rememberCommand('run-1', 'cmd-1')).toBe(false)
  })

  it('seeds start and command idempotency state from an existing run', () => {
    const registry = new IdempotencyRegistry()
    const run = {
      ...createRunAggregate({
        id: 'run-1',
        repository: { root: '/repo', baseCommit: 'base' },
        steps: [],
        now: 1_000,
      }),
      idempotencyKey: 'key-1',
      processedCommandIds: ['cmd-1', 'cmd-2'],
    }

    registry.seed(run)

    expect(registry.getStart('key-1', run.workflowHash)).toBe('run-1')
    expect(registry.hasCommand('run-1', 'cmd-1')).toBe(true)
    expect(registry.hasCommand('run-1', 'cmd-2')).toBe(true)
    expect(registry.hasCommand('run-1', 'cmd-3')).toBe(false)
  })

  it('seeds nothing when the run has no idempotencyKey or processedCommandIds', () => {
    const registry = new IdempotencyRegistry()
    const run = createRunAggregate({
      id: 'run-1',
      repository: { root: '/repo', baseCommit: 'base' },
      steps: [],
      now: 1_000,
    })

    expect(() => registry.seed(run)).not.toThrow()
    expect(registry.getStart('any-key', run.workflowHash)).toBeUndefined()
    expect(registry.hasCommand('run-1', 'cmd-1')).toBe(false)
  })
})

describe('isDuplicateCommand', () => {
  it('is false the first time a command is seen and true on repeats', () => {
    const registry = new IdempotencyRegistry()
    expect(isDuplicateCommand(registry, 'run-1', 'cmd-1')).toBe(false)
    expect(isDuplicateCommand(registry, 'run-1', 'cmd-1')).toBe(true)
  })
})
