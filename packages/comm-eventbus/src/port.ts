import type {
  CommunicationMessage,
  CommunicationPort,
  MessageFilter,
  MessageHandler,
  RequestOptions,
  Scope,
} from '@dsh/spec'
import {
  MessageValidationError,
  PortClosedError,
  RequestAbortedError,
  RequestTimeoutError,
} from '@dsh/communication/errors'
import { COMM_RESPONSE_TYPE } from '@dsh/communication/messages'
import {
  EventBusEmitter,
} from './emitter.js'

interface PendingRequest {
  resolve: (message: CommunicationMessage) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  signal?: AbortSignal
  onAbort?: () => void
  settled: boolean
}

/** Constructor options for EventBusPort. */
export interface EventBusPortOptions {
  /** Maximum EventEmitter listener count before Node warns. */
  maxListeners?: number
  /** Injectable clock for acceptedAt and deterministic tests. */
  now?: () => number
  /** Optional emitter, primarily useful for controlled integration tests. */
  emitter?: EventBusEmitter
}

/** In-process, run-scoped implementation of CommunicationPort. */
export class EventBusPort implements CommunicationPort {
  private readonly emitter: EventBusEmitter
  private readonly pending = new Map<string, PendingRequest>()
  private readonly now: () => number
  private readonly responseListener: (message: CommunicationMessage) => void
  private closed = false

  constructor(
    private readonly scope: Scope,
    options: EventBusPortOptions = {},
  ) {
    validateScope(scope)
    this.now = options.now ?? Date.now
    this.emitter = options.emitter
      ?? new EventBusEmitter(options.maxListeners ?? 64)
    if (options.emitter && options.maxListeners !== undefined) {
      this.emitter.setMaxListeners(options.maxListeners)
    }

    this.responseListener = (message) => {
      if (message.type !== COMM_RESPONSE_TYPE || !message.correlationId) return
      const pending = this.pending.get(message.correlationId)
      if (!pending) return
      this.resolvePending(message.correlationId, pending, message)
    }
    this.emitter.onMessage(this.responseListener)
  }

  /** Returns the port's underlying emitter for diagnostics and tests. */
  get eventEmitter(): EventBusEmitter {
    return this.emitter
  }

  /** Number of unresolved request/reply operations. */
  get pendingCount(): number {
    return this.pending.size
  }

  /** Whether close() has been called. */
  get isClosed(): boolean {
    return this.closed
  }

  /** Sends a message after applying the port's scope stamp. */
  async send(message: CommunicationMessage): Promise<{ acceptedAt: number }> {
    this.assertOpen()
    validateMessageForSend(message)

    const stamped: CommunicationMessage = {
      ...message,
      runId: this.scope.runId,
      attemptId: message.attemptId ?? this.scope.attemptId,
    }
    const acceptedAt = this.now()
    this.emitter.emitMessage(stamped)
    return { acceptedAt }
  }

  /** Adds a filtered subscriber and returns an idempotent unsubscribe function. */
  subscribe(filter: MessageFilter, handler: MessageHandler): () => void {
    this.assertOpen()
    if (typeof filter !== 'function' || typeof handler !== 'function') {
      throw new MessageValidationError('subscribe 需要 filter 和 handler 函数')
    }

    const listener = (message: CommunicationMessage): void => {
      try {
        if (!filter(message)) return
        const result = handler(message)
        if (isPromiseLike(result)) {
          void Promise.resolve(result)
            .catch((error: unknown) => this.reportHandlerError(error))
        }
      } catch (error) {
        this.reportHandlerError(error)
      }
    }

    this.emitter.onMessage(listener)
    let unsubscribed = false
    return () => {
      if (unsubscribed) return
      unsubscribed = true
      this.emitter.offMessage(listener)
    }
  }

  /** Sends a request and resolves with the first matching response. */
  async request(
    message: CommunicationMessage,
    options: RequestOptions,
  ): Promise<CommunicationMessage> {
    this.assertOpen()
    validateRequestOptions(options)
    validateMessageForSend(message)

    if (message.type === COMM_RESPONSE_TYPE) {
      throw new MessageValidationError('request 不能使用响应保留字类型')
    }
    const correlationId = message.correlationId
    if (!correlationId || correlationId.trim().length === 0) {
      throw new MessageValidationError('request 必须携带 correlationId')
    }
    if (this.pending.has(correlationId)) {
      throw new MessageValidationError(
        `correlationId "${correlationId}" 已有未决请求`,
      )
    }
    if (options.signal?.aborted) {
      throw new RequestAbortedError('request 已取消')
    }

    return new Promise<CommunicationMessage>((resolve, reject) => {
      const entry: PendingRequest = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.rejectPending(
            correlationId,
            entry,
            new RequestTimeoutError(`request 超时（${options.timeoutMs}ms）`),
          )
        }, options.timeoutMs),
        signal: options.signal,
        settled: false,
      }

      if (options.signal) {
        entry.onAbort = () => {
          this.rejectPending(
            correlationId,
            entry,
            new RequestAbortedError('request 已取消'),
          )
        }
        options.signal.addEventListener('abort', entry.onAbort, { once: true })
      }

      this.pending.set(correlationId, entry)
      void this.send(message).catch((error: unknown) => {
        this.rejectPending(
          correlationId,
          entry,
          error instanceof Error ? error : new Error(String(error)),
        )
      })
    })
  }

  /** Closes the port, rejects pending requests, and removes all listeners. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true

    for (const [correlationId, entry] of [...this.pending.entries()]) {
      this.rejectPending(
        correlationId,
        entry,
        new PortClosedError('端口已关闭，未决请求被拒绝'),
      )
    }
    this.pending.clear()
    this.emitter.removeAllListeners()
  }

  private resolvePending(
    correlationId: string,
    entry: PendingRequest,
    message: CommunicationMessage,
  ): void {
    if (!this.markSettled(correlationId, entry)) return
    entry.resolve(message)
  }

  private rejectPending(
    correlationId: string,
    entry: PendingRequest,
    error: Error,
  ): void {
    if (!this.markSettled(correlationId, entry)) return
    entry.reject(error)
  }

  private markSettled(
    correlationId: string,
    entry: PendingRequest,
  ): boolean {
    if (entry.settled) return false
    entry.settled = true
    clearTimeout(entry.timer)
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort)
    }
    this.pending.delete(correlationId)
    return true
  }

  private reportHandlerError(error: unknown): void {
    try {
      this.emitter.emitHandlerError(error)
    } catch {
      // A diagnostic listener must never change port state or break delivery.
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new PortClosedError('端口已关闭')
  }
}

function validateScope(scope: Scope): void {
  if (typeof scope?.runId !== 'string' || scope.runId.trim().length === 0) {
    throw new MessageValidationError('port scope.runId 必须为非空字符串')
  }
  if (scope.attemptId !== undefined
    && (typeof scope.attemptId !== 'string' || scope.attemptId.trim().length === 0)) {
    throw new MessageValidationError('port scope.attemptId 必须为非空字符串')
  }
}

function validateMessageForSend(message: CommunicationMessage): void {
  const candidate: unknown = message
  if (typeof candidate !== 'object' || candidate === null) {
    throw new MessageValidationError('message 必须为对象')
  }
  const value = candidate as Record<string, unknown>
  if (typeof value.type !== 'string' || value.type.trim().length === 0) {
    throw new MessageValidationError('message.type 必须为非空字符串')
  }
  if (typeof value.sender !== 'string' || value.sender.trim().length === 0) {
    throw new MessageValidationError('message.sender 必须为非空字符串')
  }
}

function validateRequestOptions(options: RequestOptions): void {
  const candidate: unknown = options
  if (typeof candidate !== 'object' || candidate === null) {
    throw new MessageValidationError('request options 必须为对象')
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
    throw new MessageValidationError('request timeoutMs 必须是非负有限数')
  }
}

function isPromiseLike(value: unknown): value is Promise<void> {
  return typeof value === 'object'
    && value !== null
    && 'then' in value
    && typeof value.then === 'function'
}
