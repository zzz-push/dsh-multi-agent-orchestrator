import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type {
  CommunicationCapabilities,
  CommunicationPort,
  CommunicationProvider,
  Scope,
} from '@dsh/spec'
import {
  InvalidAcquireOptionsError,
  InvalidProviderError,
  PreflightError,
  ProviderDrainingError,
  ProviderNotFoundError,
  ProviderOpenError,
  RegistryClosedError,
  RequestAbortedError,
} from '../src/errors.js'
import { CommunicationRegistryImpl } from '../src/registry.js'
import {
  DEFAULT_CAPABILITIES,
  FakeProvider,
  RecordingPort,
} from './helpers.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('CommunicationRegistryImpl', () => {
  it('registers, acquires, and releases a generation-pinned lease', async () => {
    const registry = new CommunicationRegistryImpl()
    const provider = new FakeProvider()
    registry.register(provider)

    const lease = await registry.acquire({
      provider: 'fake',
      requirements: { requestReply: true },
      runId: 'run-1',
      attemptId: 'attempt-1',
    })

    expect(lease.provider).toBe('fake')
    expect(lease.version).toBe('1.0.0')
    expect(lease.generation).toBe('gen-0001')
    expect(provider.openedScopes).toEqual([
      { runId: 'run-1', attemptId: 'attempt-1' },
    ])
    expect(registry.inspect().leases[0]).toMatchObject({
      runId: 'run-1',
      state: 'active',
      generation: 'gen-0001',
    })

    const port = provider.openedPorts[0]
    await Promise.all([lease.release(), lease.release()])
    expect(port?.closeCalls).toBe(1)
    expect(registry.inspect().leases).toEqual([])
  })

  it('uses the first compatible active provider deterministically', async () => {
    const registry = new CommunicationRegistryImpl()
    const incompatible = new FakeProvider('volatile', '1', {
      ...DEFAULT_CAPABILITIES,
      durable: false,
    })
    const first = new FakeProvider('durable-a', '1', {
      ...DEFAULT_CAPABILITIES,
      durable: true,
    })
    const second = new FakeProvider('durable-b', '1', {
      ...DEFAULT_CAPABILITIES,
      durable: true,
    })
    registry.register(incompatible)
    registry.register(first)
    registry.register(second)

    const lease = await registry.acquire({
      requirements: { durable: true },
      runId: 'run-selection',
    })
    expect(lease.provider).toBe('durable-a')
    await lease.release()
  })

  it('reports named, missing, and aggregate capability failures', async () => {
    const registry = new CommunicationRegistryImpl()
    registry.register(new FakeProvider('one'))
    registry.register(new FakeProvider('two'))

    await expect(registry.acquire({
      provider: 'missing',
      requirements: {},
      runId: 'run',
    })).rejects.toBeInstanceOf(ProviderNotFoundError)

    const named = registry.acquire({
      provider: 'one',
      requirements: { durable: true },
      runId: 'run',
    })
    await expect(named).rejects.toMatchObject({
      code: 'PREFLIGHT_FAILED',
      failures: [{ code: 'DURABILITY_UNSATISFIED' }],
    })

    try {
      await registry.acquire({
        requirements: { durable: true },
        runId: 'run',
      })
      throw new Error('expected preflight failure')
    } catch (error) {
      expect(error).toBeInstanceOf(PreflightError)
      const details = (error as PreflightError).details as {
        providers: unknown[]
      }
      expect(details.providers).toHaveLength(2)
      expect((error as PreflightError).failures).toHaveLength(2)
    }
  })

  it('pins old leases while a replacement becomes the active generation', async () => {
    const registry = new CommunicationRegistryImpl({ drainTimeoutMs: 1_000 })
    const oldProvider = new FakeProvider('replaceable', '1')
    const oldDispose = registry.register(oldProvider)
    const oldLease = await registry.acquire({
      provider: 'replaceable',
      requirements: {},
      runId: 'old-run',
    })
    const oldDrained = registry.whenDrained(oldLease.generation)

    const newProvider = new FakeProvider('replaceable', '2')
    registry.register(newProvider)
    const newLease = await registry.acquire({
      provider: 'replaceable',
      requirements: {},
      runId: 'new-run',
    })

    expect(oldLease.generation).toBe('gen-0001')
    expect(newLease.generation).toBe('gen-0002')
    expect(registry.inspect().providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ generation: 'gen-0001', status: 'draining' }),
      expect.objectContaining({ generation: 'gen-0002', status: 'active' }),
    ]))

    oldDispose()
    await oldLease.release()
    await oldDrained
    expect(registry.inspect().providers).toHaveLength(1)
    await newLease.release()
  })

  it('rejects new named leases while the only generation drains', async () => {
    const registry = new CommunicationRegistryImpl({ drainTimeoutMs: 1_000 })
    const disposeProvider = registry.register(new FakeProvider())
    const lease = await registry.acquire({
      provider: 'fake',
      requirements: {},
      runId: 'run',
    })
    disposeProvider()

    await expect(registry.acquire({
      provider: 'fake',
      requirements: {},
      runId: 'new-run',
    })).rejects.toBeInstanceOf(ProviderDrainingError)

    const drained = registry.whenDrained(lease.generation)
    await lease.release()
    await drained
    expect(registry.inspect().providers).toEqual([])
    await expect(registry.whenDrained('unknown')).resolves.toBeUndefined()
  })

  it('normalizes open failures and leaves no lease behind', async () => {
    const registry = new CommunicationRegistryImpl()
    const provider = new FakeProvider()
    provider.openBehavior = 'throw'
    registry.register(provider)

    await expect(registry.acquire({
      provider: 'fake',
      requirements: {},
      runId: 'run',
    })).rejects.toMatchObject({
      code: 'PROVIDER_OPEN_FAILED',
      cause: expect.objectContaining({ message: 'injected open failure' }),
    })
    expect(registry.inspect().leases).toEqual([])
  })

  it('times out a hanging open without leaking a lease', async () => {
    vi.useFakeTimers()
    const registry = new CommunicationRegistryImpl({ openTimeoutMs: 20 })
    const provider = new FakeProvider()
    provider.openBehavior = 'hang'
    registry.register(provider)

    const acquisition = registry.acquire({
      provider: 'fake',
      requirements: {},
      runId: 'run',
    })
    const assertion = expect(acquisition).rejects.toBeInstanceOf(ProviderOpenError)
    await vi.advanceTimersByTimeAsync(20)
    await assertion
    expect(registry.inspect().leases).toEqual([])
  })

  it('aborts a hanging open and cleans its abort listener path', async () => {
    const registry = new CommunicationRegistryImpl({ openTimeoutMs: 1_000 })
    const provider = new FakeProvider()
    provider.openBehavior = 'hang'
    registry.register(provider)
    const controller = new AbortController()

    const acquisition = registry.acquire({
      provider: 'fake',
      requirements: {},
      runId: 'run',
      signal: controller.signal,
    })
    controller.abort()
    await expect(acquisition).rejects.toBeInstanceOf(RequestAbortedError)
    expect(registry.inspect().leases).toEqual([])

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await expect(registry.acquire({
      provider: 'fake',
      requirements: {},
      runId: 'run',
      signal: alreadyAborted.signal,
    })).rejects.toBeInstanceOf(RequestAbortedError)
  })

  it('closes a port that arrives after an acquisition timeout', async () => {
    vi.useFakeTimers()
    let resolveOpen: ((port: CommunicationPort) => void) | undefined
    const latePort = new RecordingPort()
    const provider: CommunicationProvider = {
      name: 'late',
      version: '1',
      capabilities: DEFAULT_CAPABILITIES,
      open: async (_scope: Scope) => new Promise<CommunicationPort>((resolve) => {
        resolveOpen = resolve
      }),
    }
    const registry = new CommunicationRegistryImpl({ openTimeoutMs: 10 })
    registry.register(provider)

    const acquisition = registry.acquire({
      provider: 'late',
      requirements: {},
      runId: 'run',
    })
    const assertion = expect(acquisition).rejects.toBeInstanceOf(ProviderOpenError)
    await vi.advanceTimersByTimeAsync(10)
    await assertion
    resolveOpen?.(latePort)
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve()
    }
    expect(latePort.closeCalls).toBe(1)
  })

  it('ignores close failures while completing release', async () => {
    const warnings: string[] = []
    const registry = new CommunicationRegistryImpl({
      logger: {
        info: () => undefined,
        warn: (message) => warnings.push(message),
        error: () => undefined,
      },
    })
    const provider = new FakeProvider()
    registry.register(provider)
    const lease = await registry.acquire({
      provider: 'fake',
      requirements: {},
      runId: 'run',
    })
    const port = provider.openedPorts[0]
    if (port) port.closeError = new Error('close failed')

    await expect(lease.release()).resolves.toBeUndefined()
    expect(registry.inspect().leases).toEqual([])
    expect(warnings[0]).toContain('close failed')
  })

  it('forces remaining leases after the drain deadline', async () => {
    vi.useFakeTimers()
    const forced: Array<{ runId: string; reason: string; generation: string }> = []
    const registry = new CommunicationRegistryImpl({
      drainTimeoutMs: 25,
      now: () => 100,
      onLeaseForced: (event) => forced.push(event),
    })
    const provider = new FakeProvider()
    const unregister = registry.register(provider)
    const lease = await registry.acquire({
      provider: 'fake',
      requirements: {},
      runId: 'forced-run',
    })
    unregister()

    const drained = registry.whenDrained(lease.generation)
    await vi.advanceTimersByTimeAsync(25)
    await drained
    expect(forced).toEqual([expect.objectContaining({
      runId: 'forced-run',
      reason: 'unregistered',
      generation: 'gen-0001',
    })])
    expect(provider.openedPorts[0]?.closeCalls).toBe(1)
    expect(registry.inspect()).toEqual({ providers: [], leases: [] })
    await expect(lease.release()).resolves.toBeUndefined()
  })

  it('disposes immediately, cancels opening leases, and rejects future calls', async () => {
    const forced: string[] = []
    const registry = new CommunicationRegistryImpl({
      openTimeoutMs: 1_000,
      onLeaseForced: (event) => forced.push(event.reason),
    })
    const provider = new FakeProvider()
    provider.openBehavior = 'hang'
    registry.register(provider)
    const acquisition = registry.acquire({
      provider: 'fake',
      requirements: {},
      runId: 'opening-run',
    })

    registry.dispose()
    await expect(acquisition).rejects.toBeInstanceOf(RegistryClosedError)
    expect(forced).toEqual(['registry-disposed'])
    expect(() => registry.register(new FakeProvider('later')))
      .toThrow(RegistryClosedError)
    await expect(registry.acquire({
      requirements: {},
      runId: 'later',
    })).rejects.toBeInstanceOf(RegistryClosedError)
    registry.dispose()
  })

  it('validates provider declarations and acquisition requirements', async () => {
    const registry = new CommunicationRegistryImpl()
    const invalid = {
      name: '',
      version: '1',
      capabilities: DEFAULT_CAPABILITIES,
      open: async () => new RecordingPort(),
    } as unknown as CommunicationProvider
    expect(() => registry.register(invalid)).toThrow(InvalidProviderError)

    registry.register(new FakeProvider())
    await expect(registry.acquire({
      provider: 'fake',
      requirements: { allowedDelivery: [] },
      runId: 'run',
    })).rejects.toBeInstanceOf(InvalidAcquireOptionsError)
    await expect(registry.acquire({
      provider: 'fake',
      requirements: { minMessageBytes: 0 },
      runId: 'run',
    })).rejects.toBeInstanceOf(InvalidAcquireOptionsError)
  })

  it('rejects a provider that returns an invalid port', async () => {
    const provider: CommunicationProvider = {
      name: 'invalid-port',
      version: '1',
      capabilities: DEFAULT_CAPABILITIES,
      open: async () => ({ close: async () => undefined }) as unknown as CommunicationPort,
    }
    const registry = new CommunicationRegistryImpl()
    registry.register(provider)
    await expect(registry.acquire({
      provider: 'invalid-port',
      requirements: {},
      runId: 'run',
    })).rejects.toBeInstanceOf(ProviderOpenError)
  })

  it('validates registry duration options', () => {
    expect(() => new CommunicationRegistryImpl({ drainTimeoutMs: -1 }))
      .toThrow(RangeError)
    expect(() => new CommunicationRegistryImpl({ openTimeoutMs: 1.5 }))
      .toThrow(RangeError)
  })

  it('accepts an active provider with richer capabilities only when explicitly allowed', async () => {
    const capabilities: CommunicationCapabilities = {
      delivery: 'at-least-once',
      durable: true,
      ordering: 'global',
      requestReply: true,
      cancellation: 'propagated',
    }
    const registry = new CommunicationRegistryImpl()
    registry.register(new FakeProvider('rich', '1', capabilities))
    const lease = await registry.acquire({
      provider: 'rich',
      requirements: {
        allowedDelivery: ['at-least-once'],
        allowedOrdering: ['global'],
        cancellation: 'local',
      },
      runId: 'run',
    })
    await lease.release()
  })
})
