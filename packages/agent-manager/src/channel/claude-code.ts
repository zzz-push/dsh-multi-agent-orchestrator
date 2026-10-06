import { randomUUID } from 'node:crypto'
import { spawnManaged, type ManagedProcess, type ProcessExitInfo } from '../process.js'
import {
  ChannelAbortedError,
  ChannelClosedError,
  ChannelTimeoutError,
  ChannelTurnError,
} from '../errors.js'
import type { JournalLogger } from '../journal/writer.js'
import {
  DEFAULT_ACTIVITY_HEARTBEAT_MS,
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

/** Thinking effort levels the Claude Code CLI accepts for `--effort`. */
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * Model every Claude sub-agent runs on unless the caller says otherwise.
 */
export const DEFAULT_CLAUDE_SUBAGENT_MODEL = 'sonnet'
/** Thinking effort paired with {@link DEFAULT_CLAUDE_SUBAGENT_MODEL}. */
export const DEFAULT_CLAUDE_SUBAGENT_EFFORT: ClaudeEffort = 'medium'

export interface ClaudeCodeChannelOptions {
  /** Path/name of the Claude Code CLI. Defaults to `claude`. */
  command?: string
  /**
   * Model for every session this channel opens (`--model`): an alias such as
   * `sonnet` / `opus` or a full model name. Default:
   * {@link DEFAULT_CLAUDE_SUBAGENT_MODEL}. `null` passes no flag, leaving the
   * choice to the Claude CLI default.
   */
  model?: string | null
  /**
   * Thinking effort (`--effort`). Default: {@link DEFAULT_CLAUDE_SUBAGENT_EFFORT}.
   * `null` passes no flag.
   */
  effort?: ClaudeEffort | null
  /** Arguments inserted before the adapter's own CLI flags (useful for a wrapper). */
  commandArgs?: readonly string[]
  /** Optional logger for diagnostics. */
  logger?: JournalLogger
  /** Spacing of `agent.activity` heartbeats while the model thinks. Default {@link DEFAULT_ACTIVITY_HEARTBEAT_MS}. */
  activityHeartbeatMs?: number
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

interface SessionState {
  session: ChannelSession
  options: ChannelOpenOptions
  process: ManagedProcess
  queue: TurnEntry[]
  closed: boolean
  buffer: string
  /** When the last `agent.activity` heartbeat was recorded (epoch ms; 0 = never). */
  lastActivityAt: number
}

interface TurnEntry {
  start: 'chat' | 'command'
  startedAt: number
  textParts: string[]
  toolCalls: ChatToolCall[]
  model?: string
  completion: Deferred<ChatReply>
  completed: boolean
  abandoned: boolean
}

/**
 * Claude Code adapter over its official stream-json channel.
 *
 * The adapter never reads Claude's session files. All conversation history is
 * forwarded through `onEvent`, where the manager's journal becomes the sole
 * trusted source of truth.
 */
export class ClaudeCodeChannel implements Channel {
  readonly harness = 'claude-code'

  readonly capabilities: ChannelCapabilities = {
    streaming: true,
    keepAlive: true,
    resumeSession: true,
    forkSession: true,
    readHistory: true,
    injectSystemPrompt: true,
  }

  private readonly command: string
  private readonly commandArgs: readonly string[]
  private readonly modelArgs: readonly string[]
  private readonly logger?: JournalLogger
  private readonly activityHeartbeatMs: number
  private readonly sessions = new Map<string, SessionState>()

  constructor(options: ClaudeCodeChannelOptions = {}) {
    this.command = options.command ?? 'claude'
    this.commandArgs = options.commandArgs ?? []
    this.modelArgs = claudeModelArgs(options)
    this.logger = options.logger
    this.activityHeartbeatMs = options.activityHeartbeatMs ?? DEFAULT_ACTIVITY_HEARTBEAT_MS
  }

  /** Spawn a Claude process and establish a caller-selected session id. */
  async open(options: ChannelOpenOptions): Promise<ChannelSession> {
    if (this.sessions.has(options.agentId)) {
      throw new ChannelTurnError(options.agentId, 'an open Claude channel already exists for this agent')
    }
    const sessionId = options.harnessSessionId ?? randomUUID()
    const args = [
      ...this.commandArgs,
      '-p',
      '--verbose',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--session-id', sessionId,
      ...claudeSettingSourceArgs(this.commandArgs),
    ]
    if (options.systemPrompt !== undefined && options.systemPrompt !== '') {
      args.push('--append-system-prompt', options.systemPrompt)
    }
    // TODO: only a plain tool list reaches here; the policy-filtered file
    // operations and shell patterns are dropped, so they bind nothing yet.
    const requestedTools = claudeTools(options.tools)
    if (requestedTools !== undefined) args.push('--tools', requestedTools)
    args.push(...claudeSandboxArgs(options.sandbox))
    args.push(...claudeMcpArgs(options.mcpServers))
    args.push(...this.modelArgs)

    // The Harness client owns interactive Agent windows. The Channel remains a
    // structured protocol process and never wraps itself in a local terminal.
    const state = {} as SessionState
    const baseSession: ChannelSession = {
      agentId: options.agentId,
      harness: this.harness,
      sessionId,
    }

    state.session = baseSession
    state.options = options
    state.queue = []
    state.closed = false
    state.buffer = ''
    state.lastActivityAt = 0
    state.process = spawnManaged({
      command: this.command,
      args,
      cwd: options.cwd,
      env: options.env,
      onStdout: (chunk) => this.consumeStdout(state, chunk),
      onStderr: (chunk) => {
        const text = chunk.toString('utf8').trim()
        if (text !== '') this.logger?.warn(`claude stderr: ${text}`)
      },
    })
    this.sessions.set(options.agentId, state)
    void state.process.exit.then((info) => this.onExit(state, info))
    try {
      await state.process.spawned
    } catch (error) {
      this.sessions.delete(options.agentId)
      await state.process.killGraceful(250).catch(() => undefined)
      throw error
    }
    state.session = { ...state.session, pid: state.process.pid }
    this.logger?.info(
      `Claude Code channel opened for agent ${options.agentId} (session ${sessionId}, pid ${state.process.pid})`,
    )
    return state.session
  }

  /** Send a structured command and wait for that harness turn to finish. */
  async sendCommand(session: ChannelSession, command: AgentCommand): Promise<void> {
    const state = this.requireSession(session)
    this.emit(state, { kind: 'command.sent', role: 'user', payload: {
      commandKind: command.kind,
      payload: command.payload,
      text: command.text,
    } })
    const text = `[structured command: ${command.kind}]\n${command.text}`
    const entry = this.writeUserMessage(state, text, 'command')
    await this.waitTurn(state, entry, undefined, undefined)
  }

  /** Send free text and wait for one complete reply (default: ten minutes). */
  async sendChat(session: ChannelSession, text: string, options: SendChatOptions = {}): Promise<ChatReply> {
    const state = this.requireSession(session)
    const timeoutMs = options.timeoutMs ?? DEFAULT_SEND_CHAT_TIMEOUT_MS
    this.emit(state, { kind: 'chat.sent', role: 'user', payload: { text } })
    const entry = this.writeUserMessage(state, text, 'chat')
    return this.waitTurn(state, entry, timeoutMs, options.signal)
  }

  /** Close stdin, then terminate the process if Claude does not exit promptly. */
  async close(session: ChannelSession): Promise<void> {
    const state = this.sessions.get(session.agentId)
    if (state === undefined || state.closed) return
    state.closed = true
    state.process.endStdin()
    const exited = await Promise.race([
      state.process.exit.then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 3_000)
        timer.unref?.()
      }),
    ])
    if (!exited) await state.process.killGraceful(2_000)
  }

  private requireSession(session: ChannelSession): SessionState {
    const state = this.sessions.get(session.agentId)
    if (state === undefined || state.closed || !state.process.alive()) {
      throw new ChannelClosedError(session.agentId, state === undefined ? 'no open channel for this session' : undefined)
    }
    return state
  }

  private writeUserMessage(state: SessionState, text: string, start: TurnEntry['start']): TurnEntry {
    const entry = createDeferredTurn(start, Date.now())
    state.queue.push(entry)
    this.emit(state, { kind: 'message', role: 'user', payload: { text } })
    const message = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    })
    try {
      state.process.stdin?.write(`${message}\n`)
    } catch (error) {
      this.emit(state, { kind: 'error', role: 'system', payload: {
        code: 'turn-error', message: String(error),
      } })
      this.completeError(state, entry, new ChannelTurnError(state.session.agentId, String(error)))
    }
    return entry
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
        this.emit(state, { kind: 'error', role: 'system', payload: {
          code: 'aborted',
          message: 'Turn aborted by AbortSignal',
        } })
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
          this.emit(state, { kind: 'error', role: 'system', payload: {
            code: 'timeout',
            message: `Turn timed out after ${timeoutMs} ms`,
          } })
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
        message: `Claude Code exited unexpectedly (code ${String(info.code)}, signal ${String(info.signal)})`,
      } })
    }
    this.emit(state, { kind: 'agent.exited', role: 'system', payload: {
      exitCode: info.code,
      signal: info.signal,
      harnessSessionId: state.session.sessionId,
    } })
    const error = new ChannelClosedError(state.session.agentId)
    for (const entry of state.queue) {
      if (!entry.completed) this.completeError(state, entry, error)
    }
    state.queue = []
    this.sessions.delete(state.session.agentId)
  }

  private consumeStdout(state: SessionState, chunk: Buffer): void {
    state.buffer += chunk.toString('utf8')
    let newline = state.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = state.buffer.slice(0, newline).trim()
      state.buffer = state.buffer.slice(newline + 1)
      if (line !== '') this.handleLine(state, line)
      newline = state.buffer.indexOf('\n')
    }
  }

  private handleLine(state: SessionState, line: string): void {
    let event: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null) throw new Error('record is not an object')
      event = parsed as Record<string, unknown>
    } catch (error) {
      this.logger?.warn(`claude: unparseable stdout line: ${line.slice(0, 120)}`)
      this.emit(state, { kind: 'error', role: 'system', payload: {
        code: 'protocol',
        message: `Unparseable Claude output: ${String(error)}`,
      } })
      return
    }
    switch (event.type) {
      case 'assistant': this.handleAssistant(state, event); break
      case 'user': this.handleUser(state, event); break
      case 'result': this.handleResult(state, event); break
      case 'system': this.handleSystem(state, event); break
      default: this.logger?.info(`claude ${String(event.type)}: ${JSON.stringify(event).slice(0, 200)}`)
    }
  }

  /**
   * Progress and retry reports. `thinking_tokens` arrives about
   * once a second while the model thinks, even without
   * `--include-partial-messages`; it becomes a throttled `agent.activity`
   * heartbeat. `api_retry` is the CLI saying a model request failed and is
   * being retried — an environment fact worth its own event.
   */
  private handleSystem(state: SessionState, event: Record<string, unknown>): void {
    if (event.subtype === 'thinking_tokens') {
      const now = Date.now()
      if (now - state.lastActivityAt < this.activityHeartbeatMs) return
      state.lastActivityAt = now
      const tokens = typeof event.estimated_tokens === 'number' ? event.estimated_tokens : undefined
      this.emit(state, { kind: 'agent.activity', role: 'system', payload: {
        activity: 'thinking',
        phase: 'progress',
        ...(tokens === undefined ? {} : { tokens }),
      } })
      return
    }
    if (event.subtype === 'api_retry') {
      const noResponse = asRecord(event.no_response)
      this.emit(state, { kind: 'agent.provider_retry', role: 'system', payload: {
        message: typeof event.error === 'string' ? event.error : 'model request failed',
        ...(typeof event.attempt === 'number' ? { attempt: event.attempt } : {}),
        ...(typeof event.max_retries === 'number' ? { maxRetries: event.max_retries } : {}),
        ...(typeof event.retry_delay_ms === 'number' ? { delayMs: event.retry_delay_ms } : {}),
        ...(typeof event.error_status === 'number' || event.error_status === null ? { status: event.error_status } : {}),
        ...(typeof noResponse?.waited_ms === 'number' ? { waitedMs: noResponse.waited_ms } : {}),
      } })
      return
    }
    this.logger?.info(`claude system/${String(event.subtype)}: ${JSON.stringify(event).slice(0, 200)}`)
  }

  private handleAssistant(state: SessionState, event: Record<string, unknown>): void {
    const message = asRecord(event.message)
    const content = asArray(message?.content)
    const model = typeof message?.model === 'string' ? message.model : undefined
    const messageId = typeof message?.id === 'string' ? message.id : undefined
    const entry = state.queue[0]
    if (entry !== undefined && model !== undefined) entry.model = model
    for (const item of content) {
      const kind = asRecord(item)?.type
      if (kind === 'text') {
        const text = typeof asRecord(item)?.text === 'string' ? String(asRecord(item)?.text) : ''
        if (text === '') continue
        entry?.textParts.push(text)
        this.emit(state, { kind: 'message', role: 'assistant', payload: { text, messageId } })
      } else if (kind === 'tool_use') {
        const toolUseId = typeof asRecord(item)?.id === 'string' ? String(asRecord(item)?.id) : ''
        const name = typeof asRecord(item)?.name === 'string' ? String(asRecord(item)?.name) : 'unknown'
        const input = asRecord(item)?.input
        entry?.toolCalls.push({ id: toolUseId, name, input })
        this.emit(state, { kind: 'tool_call', role: 'assistant', payload: { toolUseId, name, input } })
      }
    }
  }

  private handleUser(state: SessionState, event: Record<string, unknown>): void {
    const message = asRecord(event.message)
    for (const item of asArray(message?.content)) {
      if (asRecord(item)?.type !== 'tool_result') continue
      const toolUseId = typeof asRecord(item)?.tool_use_id === 'string' ? String(asRecord(item)?.tool_use_id) : ''
      const isError = asRecord(item)?.is_error === true
      this.emit(state, { kind: 'tool_result', role: 'user', payload: {
        toolUseId,
        isError,
        content: asRecord(item)?.content,
      } })
    }
  }

  private handleResult(state: SessionState, event: Record<string, unknown>): void {
    const entry = state.queue.shift()
    if (entry === undefined) {
      this.logger?.warn('claude: result event without a pending turn')
      return
    }
    const isError = event.is_error === true
    const resultText = typeof event.result === 'string' ? event.result : undefined
    const stopReason = typeof event.stop_reason === 'string' ? event.stop_reason : undefined
    const text = resultText !== undefined && resultText !== '' ? resultText : entry.textParts.join('\n')
    if (isError) {
      const failure = new ChannelTurnError(state.session.agentId, text || 'unknown Claude error')
      this.emit(state, { kind: 'error', role: 'system', payload: { code: 'turn-error', message: failure.message } })
      this.completeError(state, entry, failure)
      return
    }
    const reply: ChatReply = {
      text,
      model: entry.model,
      durationMs: Date.now() - entry.startedAt,
      stopReason,
      toolCalls: entry.toolCalls,
      raw: event,
    }
    if (entry.start === 'chat') {
      this.emit(state, { kind: 'chat.replied', role: 'assistant', payload: { text } })
    }
    this.complete(state, entry, reply)
  }

  private complete(state: SessionState, entry: TurnEntry, reply: ChatReply): void {
    if (entry.completed) return
    entry.completed = true
    entry.completion.resolve(reply)
  }

  private completeError(state: SessionState, entry: TurnEntry, error: unknown): void {
    if (entry.completed) return
    entry.completed = true
    entry.completion.reject(error)
  }

  private emit(state: SessionState, event: ChannelEvent): void {
    try {
      state.options.onEvent?.(event)
    } catch (error) {
      // An observer must never break the harness protocol. The manager's
      // journal is expected to be reliable, but third-party observers may not.
      this.logger?.error(`claude event observer failed: ${String(error)}`)
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

function createDeferredTurn(start: TurnEntry['start'], startedAt: number): TurnEntry {
  return {
    start,
    startedAt,
    textParts: [],
    toolCalls: [],
    completion: createDeferred<ChatReply>(),
    completed: false,
    abandoned: false,
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    : []
}

function claudeTools(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value.join(',')
  return undefined
}

/**
 * Flags that give the agent exactly the resolved MCP servers: `--mcp-config`
 * with only those, `--strict-mcp-config` so the user's and project's own MCP
 * configuration is ignored, and `--allowedTools mcp__<name>` so a headless
 * session can call them without a permission prompt nobody would answer.
 * `undefined` (a caller that resolved nothing) adds no flags.
 */
export function claudeMcpArgs(servers: ChannelOpenOptions['mcpServers']): string[] {
  if (servers === undefined) return []
  const names = Object.keys(servers)
  const config = { mcpServers: Object.fromEntries(names.map((name) => [name, { type: 'stdio', ...servers[name] }])) }
  return [
    '--mcp-config', JSON.stringify(config),
    '--strict-mcp-config',
    ...(names.length === 0 ? [] : ['--allowedTools', ...names.map((name) => `mcp__${name}`)]),
  ]
}

/** `--model` / `--effort` flags for a channel's options, applying the sub-agent defaults. */
export function claudeModelArgs(options: Pick<ClaudeCodeChannelOptions, 'model' | 'effort'>): string[] {
  const model = options.model === undefined ? DEFAULT_CLAUDE_SUBAGENT_MODEL : options.model
  const effort = options.effort === undefined ? DEFAULT_CLAUDE_SUBAGENT_EFFORT : options.effort
  return [
    ...(model === null || model.trim() === '' ? [] : ['--model', model]),
    ...(effort === null ? [] : ['--effort', effort]),
  ]
}

/**
 * Claude settings that make `workspace-write` mean on claude-code what it
 * means on codex: edit files inside the working directory, run any shell
 * command, but only inside the OS sandbox — writes outside the cwd fail with
 * EPERM. `autoAllowBashIfSandboxed` lets sandboxed commands run without an
 * approval prompt (a headless session has no one to ask);
 * `allowUnsandboxedCommands: false` removes the model's escape hatch of
 * retrying a command outside the sandbox.
 */
export const CLAUDE_WORKSPACE_WRITE_SETTINGS = {
  sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
} as const

/**
 * Load only the user's own settings, never the project's or the checkout's
 * local ones (`.claude/settings.json`, `.claude/settings.local.json` under the
 * agent's cwd). Those belong to whatever repository the agent runs in, and
 * their `permissions.allow`, `defaultMode` and `hooks` would decide what the
 * agent may do — and run commands — in place of the policy-resolved sandbox.
 * Settings passed with `--settings` (see {@link claudeSandboxArgs}) still apply.
 * An operator who wants project settings back passes their own
 * `--setting-sources` in `commandArgs`, which is then left alone.
 */
export function claudeSettingSourceArgs(commandArgs: readonly string[]): string[] {
  return commandArgs.some((arg) => arg === '--setting-sources' || arg.startsWith('--setting-sources='))
    ? []
    : ['--setting-sources', 'user']
}

/**
 * Command-line flags for a requested sandbox mode.
 *
 * - A native Claude permission mode (`acceptEdits`, `plan`, …) passes through
 *   as `--permission-mode`.
 * - `workspace-write` — the harness-neutral mode task manifests use, and the
 *   codex sandbox name — becomes `acceptEdits` plus the OS sandbox settings
 *   above. Before this mapping existed a `workspace-write` request was
 *   silently dropped on claude-code: the session ran in the default mode, where
 *   a headless agent can neither edit files nor run commands.
 * - `read-only` — likewise harness-neutral — becomes `dontAsk`: tools that need
 *   no permission (reading, searching) run, anything else is refused unless
 *   pre-approved. Without a flag the session ran in whatever `defaultMode` the
 *   user's own Claude settings name, which may be far wider than read-only.
 * - Anything else adds no flags.
 */
export function claudeSandboxArgs(sandbox: unknown): string[] {
  if (sandbox === 'workspace-write') {
    return ['--permission-mode', 'acceptEdits', '--settings', JSON.stringify(CLAUDE_WORKSPACE_WRITE_SETTINGS)]
  }
  if (sandbox === 'read-only') return ['--permission-mode', 'dontAsk']
  if (isClaudePermissionMode(sandbox)) return ['--permission-mode', sandbox]
  return []
}

function isClaudePermissionMode(value: unknown): value is 'acceptEdits' | 'auto' | 'bypassPermissions' | 'manual' | 'dontAsk' | 'plan' {
  return value === 'acceptEdits'
    || value === 'auto'
    || value === 'bypassPermissions'
    || value === 'manual'
    || value === 'dontAsk'
    || value === 'plan'
}
