import { describe, expect, it } from 'vitest'
import { LeaseManager } from '../src/lease-manager.js'

describe('LeaseManager', () => {
  it('tracks, snapshots, and removes leases', () => {
    const manager = new LeaseManager<{ id: string; runId: string }>()
    const lease = { id: 'lease-1', runId: 'run-1' }
    manager.add(lease)

    expect(manager.size).toBe(1)
    expect(manager.has(lease.id)).toBe(true)
    expect(manager.get(lease.id)).toBe(lease)
    expect(manager.values()).toEqual([lease])
    expect(manager.remove(lease.id)).toBe(true)
    expect(manager.remove(lease.id)).toBe(false)
    expect(manager.size).toBe(0)
  })

  it('rejects duplicate IDs and supports clear', () => {
    const manager = new LeaseManager()
    manager.add({ id: 'same' })
    expect(() => manager.add({ id: 'same' })).toThrow('already exists')
    manager.clear()
    expect(manager.size).toBe(0)
  })
})
