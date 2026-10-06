import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { spawnManaged, type ManagedProcess, type ProcessExitInfo } from '../process.js'
import {
  ChannelAbortedError,
  ChannelClosedError,
  ChannelTimeoutError,
  ChannelTurnError,
} from '../errors.js'
import type { JournalLogger } from '../journal/writer.js'
import {
  DEFAULT_SEND_CHAT_TIMEOUT_MS,
  type AgentCommand,
  type Channel,
  type ChannelCapabilities,
  type ChannelEvent,
  type ChannelOpenOptions,
  type ChannelSession,
  type ChatReply,
  type ChatToolCall,
  type SendChatOptions,
} from './types.js'
import type {
  InitializeParams as CodexInitializeParams,
} from './generated/codex/InitializeParams.js'
import type { UserInput as CodexUserInput } from './generated/codex/v2/UserInput.js'
import type { ThreadStartParams as CodexThreadStartParams } from './generated/codex/v2/ThreadStartParams.js'
import type { TurnInterruptParams as CodexTurnInterruptParams } from './generated/codex/v2/TurnInterruptParams.js'
import type { TurnStartParams as CodexTurnStartParams } from './generated/codex/v2/TurnStartParams.js'

export interface CodexChannelOptions {
  /** Path/name of the codex CLI. Defaults to `codex`. */
  command?: string
  /** Arguments inserted before `app-server --stdio` (useful for a wrapper). */
  commandArgs?: readonly string[]
  /** Optional logger for diagnostics. */
  logger?: JournalLogger
  /** Environment overlay applied to every Codex process. */
  env?: Record<string, string>
  /** Maximum time allowed for initialize/thread-start handshakes. */
  openTimeoutMs?: number
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

interface RpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params: unknown
}

interface RpcResponse {
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface RpcNotification {
  jsonrpc?: '2.0'
  method: string
  params: Record<string, unknown>
}

interface PendingRpc {
  resolve(value: unknown): void
  reject(error: unknown): void
}

interface SessionState {
  session: ChannelSession
  options: ChannelOpenOptions
  process: ManagedProcess
  threadId: string
  model?: string
  nextId: number
  pending: Map<number, PendingRpc>
  turns: Map<string, TurnEntry>
  /** Notifications can arrive in the same stdout chunk as turn/start's response. */
  earlyNotifications: Map<string, RpcNotification[]>
  completedTurns: Set<string>
  closed: boolean
  buffer: string
  /** Undeclared MCP servers already journaled (checkMcpServer). */
  reportedServers: Set<string>
}

interface TurnEntry {
  turnId: string
  start: 'chat' | 'command'
  startedAt: number
  toolCalls: ChatToolCall[]
  completion: Deferred<ChatReply>
  completed: boolean
  abandoned: boolean
}

/** Item types that represent a tool call in codex v2 notifications. */
const TOOL_ITEM_TYPES = new Set([
  'commandExecution',
  'dynamicToolCall',
  'mcpToolCall',
  'fileChange',
  'webSearch',
  'collabAgentToolCall',
])

/**
 * codex adapter over `codex app-server --stdio` using protocol v2.
 *
 * The v2 server returns a thread id from `thread/start`; it is attached to
 * the manager-generated `agentId`, never used as the manager's primary key.
 * No CLI session files are read.
 */
export class CodexChannel implements Channel {
  readonly harness = 'codex'

  readonly capabilities: ChannelCapabilities = {
    streaming: true,
    keepAlive: true,
    resumeSession: true,
    forkSession: true,
    readHistory: true,
    injectSystemPrompt: true,
  }

  protected readonly command: string
  protected readonly commandArgs: readonly string[]
  protected readonly logger?: JournalLogger
  protected readonly env?: Record<string, string>
  private readonly openTimeoutMs: number
  private readonly sessions = new Map<string, SessionState>()

  constructor(options: CodexChannelOptions = {}) {
    this.command = options.command ?? 'codex'
    this.commandArgs = options.commandArgs ?? []
    this.logger = options.logger
    this.env = options.env
    this.openTimeoutMs = options.openTimeoutMs ?? 15_000
  }

  /** Spawn app-server, negotiate v2, and start a thread. */
  async open(options: ChannelOpenOptions): Promise<ChannelSession> {
    if (this.sessions.has(options.agentId)) {
      throw new ChannelTurnError(options.agentId, 'an open Codex channel already exists for this agent')
    }
    const state = {} as SessionState
    state.session = { agentId: options.agentId, harness: this.harness, sessionId: '' }
    state.options = options
    state.threadId = ''
    state.nextId = 1
    state.pending = new Map()
    state.turns = new Map()
    state.earlyNotifications = new Map()
    state.completedTurns = new Set()
    state.reportedServers = new Set()
    state.closed = false
    state.buffer = ''
    state.process = this.createProcess(options, (chunk) => this.consumeStdout(state, chunk))
    this.sessions.set(options.agentId, state)
    void state.process.exit.then((info) => this.onExit(state, info))
    try {
      await state.process.spawned
      await this.withOpenTimeout(state, this.call(state, 'initialize', {
        clientInfo: { name: '@dsh/agent-manager', title: '@dsh/agent-manager', version: '0.1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      } satisfies CodexInitializeParams))
      const params: CodexThreadStartParams = {
        cwd: options.cwd ?? process.cwd(),
        developerInstructions: options.systemPrompt,
        // Never ask the host for an approval request over an unattended pipe.
        // A future PolicyResolver must replace this default with a
        // policy-derived value before roles can request privileged tools.
        approvalPolicy: 'never',
      }
      if (isCodexSandbox(options.sandbox)) params.sandbox = options.sandbox
      // Exactly the resolved MCP servers. Codex merges config overrides into
      // the user's config rather than replacing tables (probed during testing:
      // `mcp_servers: {}` removed nothing), so every server the user or project
      // config declares that the role did not is switched off by name; plugin
      // servers are off via `features.plugins=false` at launch (launchArgs).
      if (options.mcpServers !== undefined) {
        const configured = await configuredCodexMcpServers(this.codexHomeFor(options), options.cwd ?? process.cwd())
        params.config = { mcp_servers: codexMcpServerConfig(options.mcpServers, configured) }
      }
      const started = await this.withOpenTimeout(state, this.call(state, 'thread/start', params))
      const result = asRecord(started)
      const thread = asRecord(result?.thread)
      const threadId = typeof thread?.id === 'string' ? thread.id : ''
      if (threadId === '') throw new ChannelTurnError(options.agentId, 'thread/start returned no thread id')
      state.threadId = threadId
      state.model = typeof result?.model === 'string' ? result.model : undefined
      // Captured only once the process has fully handshaken (thread/start
      // succeeded), not right after spawnManaged() returns: CodexWebSocketChannel
      // overrides createProcess() with a wrapper whose own .pid briefly reads -1
      // until its inner server process is actually up.
      state.session = { ...state.session, sessionId: threadId, pid: state.process.pid }
    } catch (error) {
      this.sessions.delete(options.agentId)
      await state.process.killGraceful(250).catch(() => undefined)
      throw error
    }
    this.logger?.info(`codex channel opened for agent ${options.agentId} (thread ${state.threadId}, pid ${state.process.pid})`)
    return state.session
  }

  /**
   * Create the protocol transport used by one Codex session.
   * Subclasses can replace stdio with another official app-server transport.
   */
  protected createProcess(
    options: ChannelOpenOptions,
    onStdout: (chunk: Buffer) => void,
  ): ManagedProcess {
    return spawnManaged({
      command: this.command,
      args: [...this.launchArgs(options), 'app-server', '--stdio'],
      cwd: options.cwd,
      env: { ...this.env, ...options.env },
      onStdout,
      onStderr: (chunk) => {
        const text = chunk.toString('utf8').trim()
        if (text !== '') this.logger?.warn(`codex stderr: ${text}`)
      },
    })
  }

  /**
   * Arguments before `app-server`: the caller's own, plus — when the caller
   * resolved the agent's MCP servers — `features.plugins=false`, since plugin
   * MCP servers load at process start and a thread-level override cannot turn
   * them off.
   */
  protected launchArgs(options: ChannelOpenOptions): string[] {
    return [...this.commandArgs, ...(options.mcpServers === undefined ? [] : ['-c', 'features.plugins=false'])]
  }

  /** `CODEX_HOME` the spawned app-server will use. */
  private codexHomeFor(options: ChannelOpenOptions): string {
    return options.env?.CODEX_HOME ?? this.env?.CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')
  }

  /** Send a structured command and wait for its turn to finish. */
  async sendCommand(session: ChannelSession, command: AgentCommand): Promise<void> {
    const state = this.requireSession(session)
    this.emit(state, { kind: 'command.sent', role: 'user', payload: {
      commandKind: command.kind,
      payload: command.payload,
      text: command.text,
    } })
    const text = `[structured command: ${command.kind}]\n${command.text}`
    this.emit(state, { kind: 'message', role: 'user', payload: { text } })
    try {
      const entry = await this.startTurn(state, text, 'command')
      await this.waitTurn(state, entry, undefined, undefined)
    } catch (error) {
      this.emit(state, { kind: 'error', role: 'system', payload: {
        code: error instanceof Error && 'code' in error ? String(error.code) : 'turn-error',
        message: error instanceof Error ? error.message : String(error),
      } })
      throw error
    }
  }

  /** Send free text and wait for one complete reply (default: ten minutes). */
  async sendChat(session: ChannelSession, text: string, options: SendChatOptions = {}): Promise<ChatReply> {
    const state = this.requireSession(session)
    const timeoutMs = options.timeoutMs ?? DEFAULT_SEND_CHAT_TIMEOUT_MS
    if (options.signal?.aborted) throw new ChannelAbortedError(state.session.agentId)
    const startedAt = Date.now()
    this.emit(state, { kind: 'chat.sent', role: 'user', payload: { text } })
    this.emit(state, { kind: 'message', role: 'user', payload: { text } })
    try {
      const entry = await this.startTurn(state, text, 'chat', { timeoutMs, signal: options.signal })
      const remaining = timeoutMs - (Date.now() - startedAt)
      return await this.waitTurn(state, entry, Math.max(0, remaining), options.signal)
    } catch (error) {
      this.emit(state, { kind: 'error', role: 'system', payload: {
        code: error instanceof Error && 'code' in error ? String(error.code) : 'turn-error',
        message: error instanceof Error ? error.message : String(error),
      } })
      throw error
    }
  }

  /** Terminate app-server and wait until the child has been reaped. */
  async close(session: ChannelSession): Promise<void> {
    const state = this.sessions.get(session.agentId)
    if (state === undefined || state.closed) return
    state.closed = true
    await state.process.killGraceful(2_000)
  }

  private async startTurn(
    state: SessionState,
    text: string,
    start: TurnEntry['start'],
    control: SendChatOptions = {},
  ): Promise<TurnEntry> {
    const input: CodexUserInput = { type: 'text', text, text_elements: [] }
    const params: CodexTurnStartParams = { threadId: state.threadId, input: [input] }
    const rpc = this.call(state, 'turn/start', params)
    const timeoutMs = control.timeoutMs
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
      void rpc.catch(() => undefined)
      throw new ChannelTimeoutError(state.session.agentId, timeoutMs)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const cancellation = new Promise<never>((_, reject) => {
      const abort = (): void => reject(new ChannelAbortedError(state.session.agentId))
      onAbort = abort
      if (control.signal !== undefined) {
        if (control.signal.aborted) {
          abort()
          return
        }
        control.signal.addEventListener('abort', abort, { once: true })
      }
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => reject(new ChannelTimeoutError(state.session.agentId, timeoutMs)), timeoutMs)
        timer.unref?.()
      }
    })
    let response: unknown
    try {
      response = await (timeoutMs === undefined && control.signal === undefined
        ? rpc
        : Promise.race([rpc, cancellation]))
    } catch (error) {
      // If turn/start eventually returns an id after the caller gave up, stop
      // that server-side turn and discard its notifications.
      void rpc.then((lateResponse) => {
        const lateTurn = asRecord(asRecord(lateResponse)?.turn)
        const lateTurnId = typeof lateTurn?.id === 'string' ? lateTurn.id : undefined
        if (lateTurnId === undefined) return
        state.completedTurns.add(lateTurnId)
        state.earlyNotifications.delete(lateTurnId)
        void this.call(state, 'turn/interrupt', {
          threadId: state.threadId,
          turnId: lateTurnId,
        } satisfies CodexTurnInterruptParams).catch(() => undefined)
      }, () => undefined)
      throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (control.signal !== undefined && onAbort !== undefined) {
        control.signal.removeEventListener('abort', onAbort)
      }
    }
    const turn = asRecord(asRecord(response)?.turn)
    const turnId = typeof turn?.id === 'string' ? turn.id : ''
    if (turnId === '') throw new ChannelTurnError(state.session.agentId, 'turn/start returned no turn id')
    const entry: TurnEntry = {
      turnId,
      start,
      startedAt: Date.now(),
      toolCalls: [],
      completion: createDeferred<ChatReply>(),
      completed: false,
      abandoned: false,
    }
    state.turns.set(turnId, entry)
    const early = state.earlyNotifications.get(turnId)
    if (early !== undefined) {
      state.earlyNotifications.delete(turnId)
      for (const notification of early) this.handleNotification(state, notification)
    }
    try {
      state.options.onTurnStarted?.(turnId)
    } catch (error) {
      this.logger?.warn(`codex turn-start observer failed: ${String(error)}`)
    }
    return entry
  }

  private call(state: SessionState, method: string, params: unknown): Promise<unknown> {
    if (state.closed || !state.process.alive()) return Promise.reject(new ChannelClosedError(state.session.agentId))
    const id = state.nextId
    state.nextId += 1
    const request: RpcRequest = { jsonrpc: '2.0', id, method, params }
    return new Promise<unknown>((resolve, reject) => {
      state.pending.set(id, { resolve, reject })
      try {
        state.process.stdin?.write(`${JSON.stringify(request)}\n`)
      } catch (error) {
        state.pending.delete(id)
        reject(error)
      }
    })
  }

  private async withOpenTimeout(state: SessionState, promise: Promise<unknown>): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ChannelTimeoutError(state.session.agentId, this.openTimeoutMs))
      }, this.openTimeoutMs)
      timer.unref?.()
      promise.then(
        (value) => { clearTimeout(timer); resolve(value) },
        (error: unknown) => { clearTimeout(timer); reject(error) },
      )
    })
  }

  private waitTurn(
    state: SessionState,
    entry: TurnEntry,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ChatReply> {
    return new Promise<ChatReply>((resolve, reject) => {
      let done = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (callback: () => void): void => {
        if (done) return
        done = true
        if (timer !== undefined) clearTimeout(timer)
        if (signal !== undefined) signal.removeEventListener('abort', onAbort)
        callback()
      }
      const onAbort = (): void => {
        if (done) return
        entry.abandoned = true
        void this.call(state, 'turn/interrupt', {
          threadId: state.threadId,
          turnId: entry.turnId,
        } satisfies CodexTurnInterruptParams).catch(() => undefined)
        finish(() => reject(new ChannelAbortedError(state.session.agentId)))
      }
      entry.completion.promise.then(
        (reply) => finish(() => resolve(reply)),
        (error: unknown) => finish(() => reject(error)),
      )
      if (timeoutMs !== undefined) {
        if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
          finish(() => reject(new ChannelTimeoutError(state.session.agentId, timeoutMs)))
          return
        }
        timer = setTimeout(() => {
          entry.abandoned = true
          void this.call(state, 'turn/interrupt', {
            threadId: state.threadId,
            turnId: entry.turnId,
          } satisfies CodexTurnInterruptParams).catch(() => undefined)
          finish(() => reject(new ChannelTimeoutError(state.session.agentId, timeoutMs)))
        }, timeoutMs)
        timer.unref?.()
      }
      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  private onExit(state: SessionState, info: ProcessExitInfo): void {
    if (!state.closed && (info.code !== 0 || info.signal !== null)) {
      this.emit(state, { kind: 'error', role: 'system', payload: {
        code: 'process-exited',
        message: `Codex app-server exited unexpectedly (code ${String(info.code)}, signal ${String(info.signal)})`,
      } })
    }
    this.emit(state, { kind: 'agent.exited', role: 'system', payload: {
      exitCode: info.code,
      signal: info.signal,
      harnessSessionId: state.session.sessionId || undefined,
    } })
    const error = new ChannelClosedError(state.session.agentId)
    for (const entry of state.turns.values()) {
      if (!entry.completed) this.completeError(entry, error)
    }
    state.turns.clear()
    for (const pending of state.pending.values()) pending.reject(error)
    state.pending.clear()
    this.sessions.delete(state.session.agentId)
  }

  private consumeStdout(state: SessionState, chunk: Buffer): void {
    state.buffer += chunk.toString('utf8')
    let newline = state.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = state.buffer.slice(0, newline).trim()
      state.buffer = state.buffer.slice(newline + 1)
      if (line !== '') this.handleMessage(state, line)
      newline = state.buffer.indexOf('\n')
    }
  }

  private handleMessage(state: SessionState, line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      this.logger?.warn(`codex: unparseable stdout line: ${line.slice(0, 120)}`)
      this.emit(state, { kind: 'error', role: 'system', payload: {
        code: 'protocol', message: `Unparseable Codex output: ${String(error)}`,
      } })
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const message = parsed as Record<string, unknown>
    if (typeof message.method === 'string' && typeof message.id === 'number') {
      this.handleServerRequest(state, message)
      return
    }
    if (typeof message.id === 'number') {
      const response = message as unknown as RpcResponse
      const pending = state.pending.get(response.id)
      if (pending === undefined) return
      state.pending.delete(response.id)
      if (response.error !== undefined) {
        pending.reject(new ChannelTurnError(state.session.agentId, response.error.message))
      } else {
        pending.resolve(response.result)
      }
      return
    }
    if (typeof message.method !== 'string') return
    const params = asRecord(message.params) ?? {}
    this.handleNotification(state, { method: message.method, params })
  }

  private handleServerRequest(state: SessionState, message: Record<string, unknown>): void {
    const id = typeof message.id === 'number' ? message.id : -1
    const method = String(message.method)
    // ApprovalPolicy=never should prevent these in normal operation. Replying
    // with a protocol error is safer than leaving the server waiting forever.
    this.logger?.warn(`codex server request ${method} cannot be serviced by a non-interactive channel`)
    state.process.stdin?.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Unsupported server request ${method}` },
    })}\n`)
  }

  private handleNotification(state: SessionState, notification: RpcNotification): void {
    const params = notification.params ?? {}
    const turnId = typeof params.turnId === 'string'
      ? params.turnId
      : typeof asRecord(params.turn)?.id === 'string'
        ? String(asRecord(params.turn)?.id)
        : undefined
    const turnSpecific = notification.method === 'item/started'
      || notification.method === 'item/completed'
      || notification.method === 'item/agentMessage/delta'
      || notification.method === 'turn/completed'
      || notification.method === 'turn/started'
      // Retries belong to a turn too; buffering them with the rest keeps the
      // journal in the order codex sent them.
      || notification.method === 'error'
    if (turnSpecific && turnId !== undefined && !state.turns.has(turnId)) {
      if (!state.completedTurns.has(turnId)) {
        const pending = state.earlyNotifications.get(turnId) ?? []
        pending.push(notification)
        state.earlyNotifications.set(turnId, pending)
      }
      return
    }
    switch (notification.method) {
      case 'item/started': this.handleItemStarted(state, params); break
      case 'item/completed': this.handleItemCompleted(state, params); break
      case 'turn/completed': this.handleTurnCompleted(state, params); break
      case 'error': this.handleErrorNotification(state, params); break
      case 'mcpServer/startupStatus/updated': this.checkMcpServer(state, params); break
      default: this.logger?.info(`codex ${notification.method}: ${JSON.stringify(params).slice(0, 160)}`)
    }
  }

  private handleItemStarted(state: SessionState, params: Record<string, unknown>): void {
    const item = asRecord(params.item)
    const type = typeof item?.type === 'string' ? item.type : ''
    if (type === 'reasoning') {
      // app-server sends nothing while the model reasons (probed during testing):
      // the open/close of this item is the only evidence that a silence is
      // the model working.
      this.emit(state, { kind: 'agent.activity', role: 'system', payload: { activity: 'reasoning', phase: 'started' } })
      return
    }
    if (!TOOL_ITEM_TYPES.has(type)) return
    const turn = this.turnFor(state, params.turnId)
    const toolUseId = typeof item?.id === 'string' ? item.id : ''
    const name = type === 'commandExecution' && typeof item?.command === 'string'
      ? 'shell'
      : type === 'mcpToolCall' && typeof item?.tool === 'string'
        ? item.tool
        : type
    const input = item?.command ?? item?.arguments ?? item
    turn?.toolCalls.push({ id: toolUseId, name, input })
    this.emit(state, { kind: 'tool_call', role: 'assistant', payload: { toolUseId, name, input } })
  }

  private handleItemCompleted(state: SessionState, params: Record<string, unknown>): void {
    const item = asRecord(params.item)
    const type = typeof item?.type === 'string' ? item.type : ''
    if (type === 'reasoning') {
      this.emit(state, { kind: 'agent.activity', role: 'system', payload: { activity: 'reasoning', phase: 'completed' } })
      return
    }
    if (type === 'agentMessage') {
      const text = typeof item?.text === 'string' ? item.text : ''
      if (text !== '') this.emit(state, { kind: 'message', role: 'assistant', payload: {
        text,
        messageId: typeof item?.id === 'string' ? item.id : undefined,
      } })
      return
    }
    if (!TOOL_ITEM_TYPES.has(type)) return
    const toolUseId = typeof item?.id === 'string' ? item.id : ''
    const failed = typeof item?.exitCode === 'number' && item.exitCode !== 0
    this.emit(state, { kind: 'tool_result', role: 'user', payload: {
      toolUseId,
      isError: failed || item?.status === 'failed',
      content: item?.aggregatedOutput ?? item,
    } })
  }

  /**
   * Safety net for "only declared tools": codex reports every MCP server it
   * starts. One the agent was not given (a server added to the user config
   * after the name list was read, a new bundled plugin) is journaled as a
   * policy violation — it could not be prevented here, but it is not silent.
   */
  private checkMcpServer(state: SessionState, params: Record<string, unknown>): void {
    const allowed = state.options.mcpServers
    const name = typeof params.name === 'string' ? params.name : undefined
    if (allowed === undefined || name === undefined || name in allowed || state.reportedServers.has(name)) return
    state.reportedServers.add(name)
    this.emit(state, { kind: 'policy.violation', role: 'system', payload: {
      type: 'mcp_server',
      requested: name,
      reason: `codex started MCP server "${name}", which the role did not declare`,
    } })
  }

  /**
   * `error` notifications with `willRetry: true` are codex retrying a failed
   * model request (a dropped or idle stream, a 5xx) — the environment, not the
   * agent. Terminal errors surface through `turn/completed` instead.
   */
  private handleErrorNotification(state: SessionState, params: Record<string, unknown>): void {
    const error = asRecord(params.error)
    const message = typeof error?.message === 'string' ? error.message : 'model request failed'
    if (params.willRetry === true) {
      this.emit(state, { kind: 'agent.provider_retry', role: 'system', payload: { message } })
      return
    }
    this.logger?.warn(`codex error: ${message}`)
  }

  private handleTurnCompleted(state: SessionState, params: Record<string, unknown>): void {
    const turn = asRecord(params.turn)
    const turnId = typeof turn?.id === 'string' ? turn.id : ''
    const entry = state.turns.get(turnId)
    if (entry === undefined) return
    state.turns.delete(turnId)
    state.completedTurns.add(turnId)
    const status = typeof turn?.status === 'string' ? turn.status : ''
    if (status !== 'completed') {
      const errorMessage = typeof asRecord(turn?.error)?.message === 'string'
        ? String(asRecord(turn?.error)?.message)
        : `turn ended with status "${status}"`
      const failure = new ChannelTurnError(state.session.agentId, errorMessage)
      this.completeError(entry, failure)
      return
    }
    const textParts: string[] = []
    const finalParts: string[] = []
    for (const item of asArray(turn?.items)) {
      if (item.type !== 'agentMessage' || typeof item.text !== 'string') continue
      // A turn may include commentary plus a final answer; return the final
      // answer when the v2 phase field identifies one, otherwise preserve all.
      textParts.push(item.text)
      if (item.phase === 'final_answer') finalParts.push(item.text)
    }
    const text = (finalParts.length > 0 ? finalParts : textParts).join('\n')
    const reply: ChatReply = {
      text,
      model: state.model,
      durationMs: typeof turn?.durationMs === 'number' ? turn.durationMs : Date.now() - entry.startedAt,
      stopReason: status,
      toolCalls: entry.toolCalls,
      raw: turn,
    }
    if (entry.start === 'chat') this.emit(state, { kind: 'chat.replied', role: 'assistant', payload: { text } })
    this.complete(entry, reply)
  }

  private turnFor(state: SessionState, turnId: unknown): TurnEntry | undefined {
    return typeof turnId === 'string' ? state.turns.get(turnId) : undefined
  }

  private complete(entry: TurnEntry, reply: ChatReply): void {
    if (entry.completed) return
    entry.completed = true
    entry.completion.resolve(reply)
  }

  private completeError(entry: TurnEntry, error: unknown): void {
    if (entry.completed) return
    entry.completed = true
    entry.completion.reject(error)
  }

  private requireSession(session: ChannelSession): SessionState {
    const state = this.sessions.get(session.agentId)
    if (state === undefined || state.closed || !state.process.alive()) {
      throw new ChannelClosedError(session.agentId, state === undefined ? 'no open channel for this session' : undefined)
    }
    return state
  }

  private emit(state: SessionState, event: ChannelEvent): void {
    try {
      state.options.onEvent?.(event)
    } catch (error) {
      this.logger?.error(`codex event observer failed: ${String(error)}`)
    }
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (error: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    : []
}

function isCodexSandbox(value: unknown): value is 'read-only' | 'workspace-write' | 'danger-full-access' {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access'
}

/**
 * The `mcp_servers` override for one thread: the resolved servers as given,
 * and `{ enabled: false }` for every other server the configuration declares.
 */
export function codexMcpServerConfig(
  servers: NonNullable<ChannelOpenOptions['mcpServers']>,
  configured: readonly string[],
): Record<string, { command: string; args: string[]; env?: Record<string, string> } | { enabled: false }> {
  const config: Record<string, { command: string; args: string[]; env?: Record<string, string> } | { enabled: false }> = {}
  for (const name of configured) {
    if (!(name in servers)) config[name] = { enabled: false }
  }
  for (const [name, launch] of Object.entries(servers)) {
    config[name] = { command: launch.command, args: launch.args ?? [], ...(launch.env === undefined ? {} : { env: launch.env }) }
  }
  return config
}

/**
 * Names of the MCP servers codex's own configuration declares: the user's
 * `$CODEX_HOME/config.toml` and the project's `.codex/config.toml`. Read from
 * the table headers (`[mcp_servers.<name>]`, quoted or bare); sub-tables such
 * as `[mcp_servers.<name>.env]` are not separate servers. A missing file
 * declares none.
 */
export async function configuredCodexMcpServers(codexHome: string, cwd: string): Promise<string[]> {
  const names = new Set<string>()
  for (const file of [path.join(codexHome, 'config.toml'), path.join(cwd, '.codex', 'config.toml')]) {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      const match = /^\s*\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/.exec(line)
      const name = match?.[1] ?? match?.[2]
      if (name !== undefined) names.add(name)
    }
  }
  return [...names]
}
