import type {
  AcquireOptions,
  CapabilityFailure,
  CommunicationCapabilities,
  CommunicationLease,
  CommunicationPort,
  CommunicationProvider,
  CommunicationRegistry,
  Scope,
} from '@dsh/spec'
import {
  buildNoMatchMessage,
  buildPreflightMessage,
  explainCompatibility,
} from './capability-checker.js'
import {
  InvalidAcquireOptionsError,
  InvalidProviderError,
  PreflightError,
  ProviderDrainingError,
  ProviderNotFoundError,
  ProviderOpenError,
  RegistryClosedError,
  RequestAbortedError,
} from './errors.js'
import type { LeaseEntry, ProviderEntry } from './internal-types.js'
import { LeaseManager } from './lease-manager.js'
import type {
  DrainReason,
  EntrySummary,
  ForcedReleaseEvent,
  RegistrySnapshot,
} from './types.js'

/** Logger surface used by the registry without depending on a host framework. */
export interface RegistryLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** Runtime settings and lifecycle hooks for CommunicationRegistryImpl. */
export interface CommunicationRegistryOptions {
  /** Drain grace period in milliseconds; zero forces immediately. */
  drainTimeoutMs?: number
  /** Maximum provider.open duration in milliseconds. */
  openTimeoutMs?: number
  /** Injectable clock for deterministic tests. */
  now?: () => number
  /** Called once for every lease released by a drain deadline or disposal. */
  onLeaseForced?: (event: ForcedReleaseEvent) => void
  /** Called after a provider generation is fully removed. */
  onEntryRemoved?: (summary: EntrySummary) => void
  /** Optional host logger. */
  logger?: RegistryLogger
}

const noopLogger: RegistryLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const DELIVERY_VALUES = ['best-effort', 'at-most-once', 'at-least-once'] as const
const ORDERING_VALUES = ['none', 'per-key', 'global'] as const
const CANCELLATION_VALUES = ['local', 'propagated'] as const

/**
 * In-process provider registry with deterministic selection, generation pinning,
 * lease ownership, and graceful draining.
 */
export class CommunicationRegistryImpl implements CommunicationRegistry {
  private readonly entriesByName = new Map<string, ProviderEntry>()
  private readonly entriesByGeneration = new Map<string, ProviderEntry>()
  private readonly leaseManager = new LeaseManager<LeaseEntry>()
  private readonly drainTimers = new Map<string, NodeJS.Timeout>()
  private readonly drainPromises = new Map<string, Promise<void>>()
  private readonly drainTimeoutMs: number
  private readonly openTimeoutMs: number
  private readonly now: () => number
  private readonly onLeaseForced?: (event: ForcedReleaseEvent) => void
  private readonly onEntryRemoved?: (summary: EntrySummary) => void
  private readonly logger: RegistryLogger
  private generationCounter = 0
  private leaseCounter = 0
  private disposed = false

  constructor(options: CommunicationRegistryOptions = {}) {
    this.drainTimeoutMs = validateDuration(
      options.drainTimeoutMs ?? 60_000,
      'drainTimeoutMs',
    )
    this.openTimeoutMs = validateDuration(
      options.openTimeoutMs ?? 10_000,
      'openTimeoutMs',
    )
    this.now = options.now ?? Date.now
    this.onLeaseForced = options.onLeaseForced
    this.onEntryRemoved = options.onEntryRemoved
    this.logger = options.logger ?? noopLogger
  }

  /** Registers a new active generation and starts draining any active predecessor. */
  register(provider: CommunicationProvider): () => void {
    this.assertOpen('register')
    validateProvider(provider)

    const generation = `gen-${String(++this.generationCounter).padStart(4, '0')}`
    const entry: ProviderEntry = {
      name: provider.name,
      version: provider.version,
      generation,
      capabilities: cloneCapabilities(provider.capabilities),
      provider,
      status: 'active',
      leases: new Set<LeaseEntry>(),
    }

    const previous = this.entriesByName.get(entry.name)
    if (previous) {
      this.startDraining(previous, 'replaced')
    }

    this.entriesByName.set(entry.name, entry)
    this.entriesByGeneration.set(generation, entry)
    this.logger.info(
      `[communication] provider "${entry.name}@${entry.version}" registered as ${generation}`,
    )

    let unregistered = false
    return () => {
      if (unregistered) return
      unregistered = true
      if (this.entriesByName.get(entry.name) === entry) {
        this.startDraining(entry, 'unregistered')
      }
    }
  }

  /** Acquires a compatible provider and pins the resulting lease to its generation. */
  async acquire(options: AcquireOptions): Promise<CommunicationLease> {
    this.assertOpen('acquire')
    validateAcquireOptions(options)

    const entry = this.resolveEntry(options)
    const leaseEntry: LeaseEntry = {
      id: `lease-${++this.leaseCounter}`,
      runId: options.runId,
      attemptId: options.attemptId,
      providerName: entry.name,
      generation: entry.generation,
      state: 'opening',
    }

    entry.leases.add(leaseEntry)
    this.leaseManager.add(leaseEntry)

    try {
      const scope: Scope = {
        runId: options.runId,
        attemptId: options.attemptId,
      }
      const port = await this.openWithGuards(
        entry,
        leaseEntry,
        scope,
        options.signal,
      )

      if (leaseEntry.state === 'released' || !entry.leases.has(leaseEntry)) {
        await this.closePortSafely(port, `late port for ${leaseEntry.id}`)
        if (this.disposed) {
          throw new RegistryClosedError('CommunicationRegistry 在 provider.open 期间已关闭')
        }
        throw new ProviderDrainingError(
          `provider "${entry.name}" 在 open 期间完成排空，租约未建立`,
        )
      }

      leaseEntry.port = port
      leaseEntry.state = 'active'
      return this.makeLease(entry, leaseEntry)
    } catch (error) {
      leaseEntry.cancelOpen = undefined
      entry.leases.delete(leaseEntry)
      this.leaseManager.remove(leaseEntry.id)
      leaseEntry.state = 'released'
      if (entry.status === 'draining' && entry.leases.size === 0) {
        this.finalizeRemoval(entry)
      }
      throw error
    }
  }

  /** Returns a detached diagnostic snapshot of active and draining generations. */
  inspect(): RegistrySnapshot {
    return {
      providers: [...this.entriesByGeneration.values()].map((entry) => ({
        name: entry.name,
        version: entry.version,
        generation: entry.generation,
        capabilities: cloneCapabilities(entry.capabilities),
        status: entry.status,
        drainReason: entry.drainReason,
        drainStartedAt: entry.drainStartedAt,
        leaseCount: entry.leases.size,
      })),
      leases: this.leaseManager.values().map((lease) => ({
        leaseId: lease.id,
        runId: lease.runId,
        attemptId: lease.attemptId,
        providerName: lease.providerName,
        generation: lease.generation,
        state: lease.state,
      })),
    }
  }

  /** Resolves when a generation is removed; unknown generations resolve immediately. */
  whenDrained(generation: string): Promise<void> {
    const entry = this.entriesByGeneration.get(generation)
    if (!entry || entry.status === 'removed') {
      return Promise.resolve()
    }
    return this.ensureDrainPromise(entry)
  }

  /** Immediately forces all generations to drain and rejects future operations. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    for (const entry of [...this.entriesByGeneration.values()]) {
      if (entry.status === 'removed') continue
      entry.status = 'draining'
      entry.drainReason = 'registry-disposed'
      entry.drainStartedAt ??= this.now()
      if (this.entriesByName.get(entry.name) === entry) {
        this.entriesByName.delete(entry.name)
      }
      this.forceCloseAll(entry)
    }
  }

  private resolveEntry(options: AcquireOptions): ProviderEntry {
    if (options.provider !== undefined) {
      const entry = this.entriesByName.get(options.provider)
      if (!entry) {
        const draining = [...this.entriesByGeneration.values()]
          .reverse()
          .find((candidate) => candidate.name === options.provider
            && candidate.status === 'draining')

        if (draining) {
          throw new ProviderDrainingError(
            `provider "${options.provider}" 正在排空（reason=${draining.drainReason ?? 'unknown'}，`
            + `startedAt=${draining.drainStartedAt ?? 'unknown'}），不接受新租约`,
            {
              details: {
                provider: options.provider,
                generation: draining.generation,
                reason: draining.drainReason,
                startedAt: draining.drainStartedAt,
              },
            },
          )
        }

        throw new ProviderNotFoundError(
          `未注册名为 "${options.provider}" 的 Provider`,
          { details: { provider: options.provider } },
        )
      }

      const check = explainCompatibility(entry.capabilities, options.requirements)
      if (!check.ok) {
        const byProvider = [{
          name: entry.name,
          version: entry.version,
          failures: check.failures,
        }]
        throw new PreflightError(
          buildPreflightMessage(entry, check.failures),
          check.failures,
          byProvider,
        )
      }
      return entry
    }

    const failuresByProvider: Array<{
      name: string
      version: string
      failures: CapabilityFailure[]
    }> = []

    for (const entry of this.entriesByName.values()) {
      const check = explainCompatibility(entry.capabilities, options.requirements)
      if (check.ok) return entry
      failuresByProvider.push({
        name: entry.name,
        version: entry.version,
        failures: check.failures,
      })
    }

    throw new PreflightError(
      buildNoMatchMessage(options.requirements, failuresByProvider),
      failuresByProvider.flatMap((provider) => provider.failures),
      failuresByProvider,
    )
  }

  private async openWithGuards(
    entry: ProviderEntry,
    leaseEntry: LeaseEntry,
    scope: Scope,
    signal?: AbortSignal,
  ): Promise<CommunicationPort> {
    if (signal?.aborted) {
      throw new RequestAbortedError('acquire 已取消')
    }

    let timer: NodeJS.Timeout | undefined
    let onAbort: (() => void) | undefined
    let guardWon = false

    const openPromise = Promise.resolve()
      .then(() => entry.provider.open(scope))
      .then((port) => {
        validatePort(port)
        return port
      })

    const timeoutPromise = new Promise<CommunicationPort>((_resolve, reject) => {
      timer = setTimeout(() => {
        guardWon = true
        reject(new ProviderOpenError(
          `provider "${entry.name}" open 超时（${this.openTimeoutMs}ms）`,
        ))
      }, this.openTimeoutMs)
    })

    const forcedPromise = new Promise<CommunicationPort>((_resolve, reject) => {
      leaseEntry.cancelOpen = (error) => {
        guardWon = true
        reject(error)
      }
    })

    const races: Array<Promise<CommunicationPort>> = [
      openPromise,
      timeoutPromise,
      forcedPromise,
    ]

    if (signal) {
      races.push(new Promise<CommunicationPort>((_resolve, reject) => {
        onAbort = () => {
          guardWon = true
          reject(new RequestAbortedError('acquire 已取消'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }))
    }

    try {
      return await Promise.race(races)
    } catch (error) {
      if (error instanceof ProviderOpenError
        || error instanceof RequestAbortedError
        || error instanceof ProviderDrainingError
        || error instanceof RegistryClosedError) {
        throw error
      }
      throw new ProviderOpenError(`provider "${entry.name}" open 失败`, {
        cause: error,
      })
    } finally {
      if (timer) clearTimeout(timer)
      if (onAbort) signal?.removeEventListener('abort', onAbort)
      leaseEntry.cancelOpen = undefined

      if (guardWon) {
        void openPromise.then((latePort) => this.closePortSafely(
          latePort,
          `late port from ${entry.name}`,
        )).catch(() => undefined)
      }
    }
  }

  private makeLease(
    entry: ProviderEntry,
    leaseEntry: LeaseEntry,
  ): CommunicationLease {
    const release = (): Promise<void> => {
      if (leaseEntry.state === 'released') {
        return Promise.resolve()
      }
      leaseEntry.releasePromise ??= this.releaseLease(entry, leaseEntry)
      return leaseEntry.releasePromise
    }

    return {
      provider: entry.name,
      version: entry.version,
      generation: entry.generation,
      capabilities: cloneCapabilities(entry.capabilities),
      port: leaseEntry.port as CommunicationPort,
      release,
    }
  }

  private async releaseLease(
    entry: ProviderEntry,
    leaseEntry: LeaseEntry,
  ): Promise<void> {
    if (leaseEntry.state === 'released') return
    leaseEntry.state = 'releasing'

    if (leaseEntry.port) {
      await this.closePortSafely(leaseEntry.port, `lease ${leaseEntry.id}`)
    }

    leaseEntry.state = 'released'
    entry.leases.delete(leaseEntry)
    this.leaseManager.remove(leaseEntry.id)
    if (entry.status === 'draining' && entry.leases.size === 0) {
      this.finalizeRemoval(entry)
    }
  }

  private startDraining(entry: ProviderEntry, reason: DrainReason): void {
    if (entry.status !== 'active') return
    entry.status = 'draining'
    entry.drainReason = reason
    entry.drainStartedAt = this.now()
    if (this.entriesByName.get(entry.name) === entry) {
      this.entriesByName.delete(entry.name)
    }

    this.logger.info(
      `[communication] provider "${entry.name}" ${entry.generation} 进入 draining（${reason}）`,
    )

    if (entry.leases.size === 0) {
      this.finalizeRemoval(entry)
      return
    }

    this.ensureDrainPromise(entry)
    if (this.drainTimeoutMs === 0) {
      this.forceCloseAll(entry)
      return
    }

    const timer = setTimeout(() => {
      this.forceCloseAll(entry)
    }, this.drainTimeoutMs)
    this.drainTimers.set(entry.generation, timer)
  }

  private forceCloseAll(entry: ProviderEntry): void {
    if (entry.status === 'removed') return

    for (const lease of [...entry.leases]) {
      const reason = entry.drainReason ?? 'unregistered'
      const error = reason === 'registry-disposed'
        ? new RegistryClosedError('CommunicationRegistry 已关闭，provider.open 被取消')
        : new ProviderDrainingError(
            `provider "${entry.name}" 排空超时，provider.open 被取消`,
          )
      lease.cancelOpen?.(error)
      lease.cancelOpen = undefined
      lease.state = 'released'

      if (lease.port) {
        void this.closePortSafely(lease.port, `forced lease ${lease.id}`)
      }

      entry.leases.delete(lease)
      this.leaseManager.remove(lease.id)

      this.emitForcedRelease({
        leaseId: lease.id,
        runId: lease.runId,
        attemptId: lease.attemptId,
        providerName: entry.name,
        generation: entry.generation,
        reason,
        forcedAt: this.now(),
      })
    }

    this.finalizeRemoval(entry)
  }

  private finalizeRemoval(entry: ProviderEntry): void {
    if (entry.status === 'removed') return
    entry.status = 'removed'
    if (this.entriesByName.get(entry.name) === entry) {
      this.entriesByName.delete(entry.name)
    }
    this.entriesByGeneration.delete(entry.generation)

    const timer = this.drainTimers.get(entry.generation)
    if (timer) {
      clearTimeout(timer)
      this.drainTimers.delete(entry.generation)
    }

    entry.drainResolve?.()
    entry.drainResolve = undefined
    this.drainPromises.delete(entry.generation)
    this.logger.info(
      `[communication] provider "${entry.name}" ${entry.generation} 已移除`,
    )

    if (this.onEntryRemoved) {
      try {
        this.onEntryRemoved({
          name: entry.name,
          version: entry.version,
          generation: entry.generation,
          drainReason: entry.drainReason,
          drainStartedAt: entry.drainStartedAt,
        })
      } catch (error) {
        this.logger.error(
          `[communication] onEntryRemoved 回调失败（忽略）：${String(error)}`,
        )
      }
    }
  }

  private ensureDrainPromise(entry: ProviderEntry): Promise<void> {
    const existing = this.drainPromises.get(entry.generation)
    if (existing) return existing

    const promise = new Promise<void>((resolve) => {
      entry.drainResolve = resolve
    })
    this.drainPromises.set(entry.generation, promise)
    return promise
  }

  private emitForcedRelease(event: ForcedReleaseEvent): void {
    if (!this.onLeaseForced) return
    try {
      this.onLeaseForced(event)
    } catch (error) {
      this.logger.error(
        `[communication] onLeaseForced 回调失败（忽略）：${String(error)}`,
      )
    }
  }

  private async closePortSafely(
    port: CommunicationPort,
    description: string,
  ): Promise<void> {
    try {
      await Promise.resolve().then(() => port.close())
    } catch (error) {
      this.logger.warn(
        `[communication] ${description} close 失败（忽略）：${String(error)}`,
      )
    }
  }

  private assertOpen(operation: string): void {
    if (this.disposed) {
      throw new RegistryClosedError(
        `CommunicationRegistry 已关闭，不能执行 ${operation}`,
      )
    }
  }
}

/** Validates a provider declaration before any registry mutation occurs. */
export function validateProvider(provider: CommunicationProvider): void {
  const fail = (path: string, message: string): never => {
    throw new InvalidProviderError(
      `Provider 声明非法：${path} ${message}`,
      { details: { path } },
    )
  }

  const candidate: unknown = provider
  if ((typeof candidate !== 'object' && typeof candidate !== 'function')
    || candidate === null) {
    fail('provider', '必须为对象')
  }
  const value = candidate as {
    name?: unknown
    version?: unknown
    capabilities?: unknown
    open?: unknown
  }

  if (typeof value.name !== 'string' || value.name.trim().length === 0) {
    fail('name', '必须为非空字符串')
  }
  if (typeof value.version !== 'string' || value.version.trim().length === 0) {
    fail('version', '必须为非空字符串')
  }
  if (typeof value.open !== 'function') {
    fail('open', '必须是函数')
  }
  if (typeof value.capabilities !== 'object' || value.capabilities === null) {
    fail('capabilities', '不能为空')
  }

  const capabilities = value.capabilities as Record<string, unknown>
  if (!isOneOf(capabilities.delivery, DELIVERY_VALUES)) {
    fail('capabilities.delivery', '取值非法')
  }
  if (typeof capabilities.durable !== 'boolean') {
    fail('capabilities.durable', '必须是 boolean')
  }
  if (!isOneOf(capabilities.ordering, ORDERING_VALUES)) {
    fail('capabilities.ordering', '取值非法')
  }
  if (typeof capabilities.requestReply !== 'boolean') {
    fail('capabilities.requestReply', '必须是 boolean')
  }
  if (!isOneOf(capabilities.cancellation, CANCELLATION_VALUES)) {
    fail('capabilities.cancellation', '取值非法')
  }
  if (capabilities.maxMessageBytes !== undefined
    && (!Number.isInteger(capabilities.maxMessageBytes)
      || (capabilities.maxMessageBytes as number) <= 0)) {
    fail('capabilities.maxMessageBytes', '必须是正整数')
  }
}

/** Validates acquisition options before provider selection. */
export function validateAcquireOptions(options: AcquireOptions): void {
  const fail = (message: string, path?: string): never => {
    throw new InvalidAcquireOptionsError(
      `acquire 参数非法：${message}`,
      path ? { details: { path } } : undefined,
    )
  }

  const candidate: unknown = options
  if (typeof candidate !== 'object' || candidate === null) {
    fail('options 必须为对象')
  }
  const value = candidate as Record<string, unknown>

  if (typeof value.runId !== 'string' || value.runId.trim().length === 0) {
    fail('runId 必须为非空字符串', 'runId')
  }
  if (value.attemptId !== undefined
    && (typeof value.attemptId !== 'string'
      || value.attemptId.trim().length === 0)) {
    fail('attemptId 必须为非空字符串', 'attemptId')
  }
  if (value.provider !== undefined
    && (typeof value.provider !== 'string'
      || value.provider.trim().length === 0)) {
    fail('provider 必须为非空字符串', 'provider')
  }
  if (typeof value.requirements !== 'object'
    || value.requirements === null
    || Array.isArray(value.requirements)) {
    fail('requirements 不能为空且必须为对象', 'requirements')
  }

  const requirements = value.requirements as Record<string, unknown>
  validateAllowedValues(
    requirements.allowedDelivery,
    DELIVERY_VALUES,
    'allowedDelivery',
    fail,
  )
  validateAllowedValues(
    requirements.allowedOrdering,
    ORDERING_VALUES,
    'allowedOrdering',
    fail,
  )

  if (requirements.durable !== undefined
    && typeof requirements.durable !== 'boolean') {
    fail('durable 必须是 boolean', 'requirements.durable')
  }
  if (requirements.requestReply !== undefined
    && typeof requirements.requestReply !== 'boolean') {
    fail('requestReply 必须是 boolean', 'requirements.requestReply')
  }
  if (requirements.cancellation !== undefined
    && !isOneOf(requirements.cancellation, CANCELLATION_VALUES)) {
    fail('cancellation 取值非法', 'requirements.cancellation')
  }
  if (requirements.minMessageBytes !== undefined
    && (!Number.isInteger(requirements.minMessageBytes)
      || (requirements.minMessageBytes as number) <= 0)) {
    fail('minMessageBytes 必须是正整数', 'requirements.minMessageBytes')
  }
}

function validatePort(port: CommunicationPort): void {
  const candidate: unknown = port
  if (typeof candidate !== 'object' || candidate === null) {
    throw new ProviderOpenError('provider.open 未返回 CommunicationPort')
  }
  const value = candidate as Record<string, unknown>
  for (const method of ['send', 'request', 'subscribe', 'close'] as const) {
    if (typeof value[method] !== 'function') {
      throw new ProviderOpenError(
        `provider.open 返回的端口缺少 ${method}()`,
        { details: { method } },
      )
    }
  }
}

function validateAllowedValues(
  value: unknown,
  allowed: readonly string[],
  name: string,
  fail: (message: string, path?: string) => never,
): void {
  if (value === undefined) return
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${name} 必须为非空数组`, `requirements.${name}`)
  }
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.includes(item)) {
      fail(`${name} 包含非法取值`, `requirements.${name}`)
    }
  }
}

function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === 'string' && allowed.includes(value)
}

function validateDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} 必须是非负安全整数`)
  }
  return value
}

function cloneCapabilities(
  capabilities: CommunicationCapabilities,
): CommunicationCapabilities {
  return { ...capabilities }
}
