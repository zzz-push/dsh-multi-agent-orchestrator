import { randomUUID } from 'node:crypto'
import { ChannelSpawnError, ChannelTurnError } from '../errors.js'
import { spawnManaged, type ProcessExitInfo } from '../process.js'
import type {
  AgentCommand,
  Channel,
  ChannelCapabilities,
  ChannelOpenOptions,
  ChannelSession,
  ChatReply,
  SendChatOptions,
} from './types.js'

/** Command description used to attach a visible TUI to one agent. */
export interface TuiWindowSpec {
  /** Interactive CLI executable. */
  command: string
  /** CLI arguments for this agent's existing session. */
  args: readonly string[]
  /** Working directory for the TUI process. */
  cwd?: string
  /** Environment overlay for the TUI process. */
  env?: Record<string, string>
  /** Optional human-readable tmux window title. */
  title?: string
  /** Optional explicit tmux session name; generated when omitted. */
  sessionName?: string
}

/** One independently managed visible Agent window. */
export interface TuiWindow {
  readonly handle: string
  /** Optional health probe used to recreate a window after its CLI exits. */
  isAlive?(): Promise<boolean>
  open(): Promise<void>
  close(): Promise<void>
  terminate(): Promise<void>
}

/** Generic window backend; tmux is the first implementation. */
export interface TuiWindowManager {
  create(spec: TuiWindowSpec): Promise<TuiWindow>
}

/** Context supplied to a harness-neutral launch-argument builder. */
export interface TuiLaunchContext {
  agentId: string
  session: ChannelSession
  options: ChannelOpenOptions
}

/** Harness-specific data needed by the generic TUI decorator. */
export interface TuiLaunchSpec {
  /** Inner channel id this spec belongs to. */
  harness: string
  /** Whether this launch integration is enabled by policy/configuration. */
  enabled: boolean
  /** When the remote TUI can safely attach to the agent session. */
  ready: 'immediate' | 'afterFirstTurnStart'
  /** Interactive executable used by the window backend. */
  command: string
  /** Builds arguments for exactly one Agent session. */
  buildArgs(context: TuiLaunchContext): readonly string[]
  /** Optional environment overlay for the visible process. */
  env?: Record<string, string>
  /** Whether a future process restart may reattach the same session. */
  reattachOnRestart: boolean
  /** Whether the window is view-only or accepts user turns. */
  interaction: 'view-only' | 'interactive'
}

/** Options for wrapping any structured Channel with generic TUI lifecycle. */
export interface TuiWindowChannelOptions {
  channel: Channel
  launch: TuiLaunchSpec
  windowManager: TuiWindowManager
  logger?: { warn(message: string): void }
}

interface ManagedTuiSession {
  readonly inner: ChannelSession
  readonly options: ChannelOpenOptions
  readonly launch: TuiLaunchSpec
  readonly handle: string
  window?: TuiWindow
  windowPromise?: Promise<void>
  windowOpen: boolean
  closing: boolean
  firstTurnStarted: boolean
}

/**
 * Generic Channel decorator. The wrapped harness id is preserved, while each
 * Agent gets an isolated TUI window and an independent close lifecycle.
 */
export class TuiWindowChannel implements Channel {
  readonly harness: string
  readonly capabilities: ChannelCapabilities
  private readonly channel: Channel
  private readonly launch: TuiLaunchSpec
  private readonly windowManager: TuiWindowManager
  private readonly logger?: { warn(message: string): void }
  private readonly sessions = new Map<string, ManagedTuiSession>()

  constructor(options: TuiWindowChannelOptions) {
    if (options.launch.harness !== options.channel.harness) {
      throw new Error(`TUI launch harness "${options.launch.harness}" does not match channel "${options.channel.harness}"`)
    }
    this.channel = options.channel
    this.harness = options.channel.harness
    this.capabilities = options.channel.capabilities
    this.launch = options.launch
    this.windowManager = options.windowManager
    this.logger = options.logger
  }

  async open(options: ChannelOpenOptions): Promise<ChannelSession> {
    let record: ManagedTuiSession | undefined
    const inner = await this.channel.open({
      ...options,
      showWindow: false,
      onEvent: (event) => {
        options.onEvent?.(event)
        if (event.kind === 'agent.exited' && record !== undefined) {
          void this.terminateWindow(record)
        }
      },
      onTurnStarted: (turnId) => {
        options.onTurnStarted?.(turnId)
        if (record !== undefined) {
          record.firstTurnStarted = true
          void this.ensureWindow(record, false)
        }
      },
    })
    if (!options.showWindow || !this.launch.enabled) return inner

    const handle = tuiHandle(this.harness, options.agentId)
    record = {
      inner,
      options,
      launch: this.launch,
      handle,
      windowOpen: false,
      closing: false,
      firstTurnStarted: false,
    }
    this.sessions.set(options.agentId, record)
    if (this.launch.ready === 'immediate') await this.ensureWindow(record, false)

    return {
      ...inner,
      windowHandle: handle,
      openWindow: () => this.ensureWindow(record, true),
      closeWindow: () => this.closeWindow(record),
    }
  }

  async sendCommand(session: ChannelSession, command: AgentCommand): Promise<void> {
    const record = this.sessions.get(session.agentId)
    if (record !== undefined && record.launch.ready === 'immediate') await this.ensureWindow(record, false)
    const result = this.channel.sendCommand(record?.inner ?? session, command)
    await result
    if (record !== undefined) {
      record.firstTurnStarted = true
      await this.ensureWindow(record, false)
    }
  }

  async sendChat(session: ChannelSession, text: string, options?: SendChatOptions): Promise<ChatReply> {
    const record = this.sessions.get(session.agentId)
    if (record !== undefined && record.launch.ready === 'immediate') await this.ensureWindow(record, false)
    const replyPromise = this.channel.sendChat(record?.inner ?? session, text, options)
    const reply = await replyPromise
    if (record !== undefined) {
      record.firstTurnStarted = true
      await this.ensureWindow(record, false)
    }
    return reply
  }

  async close(session: ChannelSession): Promise<void> {
    const record = this.sessions.get(session.agentId)
    if (record !== undefined) {
      record.closing = true
      await this.terminateWindow(record)
      this.sessions.delete(session.agentId)
      await this.channel.close(record.inner)
      return
    }
    await this.channel.close(session)
  }

  private async ensureWindow(record: ManagedTuiSession, strict: boolean): Promise<void> {
    if (record.closing) return
    if (record.window !== undefined) {
      try {
        const alive = await record.window.isAlive?.()
        if (alive !== false) {
          if (strict && !record.windowOpen) {
            await record.window.open()
            record.windowOpen = true
          }
          return
        }
        record.window = undefined
        record.windowOpen = false
      } catch (error) {
        this.logger?.warn(`TUI window health check failed for agent ${record.options.agentId}: ${String(error)}`)
        if (strict) throw error
        return
      }
    }
    if (record.windowPromise !== undefined) {
      try {
        await record.windowPromise
      } catch (error) {
        if (strict) throw error
      }
      return
    }
    if (record.launch.ready === 'afterFirstTurnStart' && !record.firstTurnStarted) {
      const error = new ChannelTurnError(record.options.agentId, 'TUI is ready after the first Agent turn starts')
      if (strict) throw error
      return
    }

    const attempt = this.windowManager.create({
      command: record.launch.command,
      args: record.launch.buildArgs({
        agentId: record.options.agentId,
        session: record.inner,
        options: record.options,
      }),
      cwd: record.options.cwd,
      env: { ...record.options.env, ...record.launch.env },
      title: record.options.windowTitle ?? `${this.harness} Agent ${record.options.agentId}`,
      sessionName: record.handle,
    }).then(async (window) => {
      record.window = window
      try {
        await window.open()
        record.windowOpen = true
      } catch (error) {
        record.window = undefined
        record.windowOpen = false
        await window.terminate().catch(() => undefined)
        throw error
      }
    })
    record.windowPromise = attempt
    try {
      await attempt
    } catch (error) {
      this.logger?.warn(`TUI window unavailable for agent ${record.options.agentId}: ${String(error)}`)
      if (strict) throw error
    } finally {
      if (record.windowPromise === attempt) record.windowPromise = undefined
    }
  }

  private async closeWindow(record: ManagedTuiSession): Promise<void> {
    await record.window?.close()
    record.windowOpen = false
  }

  private async terminateWindow(record: ManagedTuiSession): Promise<void> {
    record.closing = true
    await record.windowPromise?.catch(() => undefined)
    const window = record.window
    record.window = undefined
    record.windowOpen = false
    await window?.terminate().catch(() => undefined)
  }
}

/** Configuration for the generic tmux-backed TUI window manager. */
export interface TmuxTuiWindowManagerOptions {
  /** Path/name of tmux. Defaults to `tmux`. */
  command?: string
  /** macOS AppleScript executable used to open Terminal.app. */
  osascriptCommand?: string
  /** Optional logger for command diagnostics. */
  logger?: { warn(message: string): void }
}

/**
 * Creates one tmux session per Agent. It never sends synthetic keystrokes and
 * never scrapes terminal output; the harness CLI owns the interactive protocol.
 */
export class TmuxTuiWindowManager implements TuiWindowManager {
  private readonly command: string
  private readonly osascriptCommand: string
  private readonly logger?: { warn(message: string): void }

  constructor(options: TmuxTuiWindowManagerOptions = {}) {
    this.command = options.command ?? 'tmux'
    this.osascriptCommand = options.osascriptCommand ?? '/usr/bin/osascript'
    this.logger = options.logger
  }

  async create(spec: TuiWindowSpec): Promise<TuiWindow> {
    const handle = spec.sessionName ?? `dsh-tui-${randomUUID()}`
    const title = spec.title ?? handle
    const commandLine = [spec.command, ...spec.args].map(shellQuote).join(' ')
    const tmuxArgs = [
      'new-session',
      '-d',
      '-s',
      handle,
      '-n',
      title,
      ...(spec.cwd === undefined ? [] : ['-c', spec.cwd]),
      commandLine,
    ]
    const result = await runManaged(this.command, tmuxArgs, spec, this.logger)
    if (result.code !== 0 || result.signal !== null) {
      throw new ChannelSpawnError('tui', `failed to create tmux session "${handle}"`)
    }

    const check = await runManaged(this.command, ['has-session', '-t', handle], spec, this.logger)
    if (check.code !== 0 || check.signal !== null) {
      await runManaged(this.command, ['kill-session', '-t', handle], spec, this.logger).catch(() => undefined)
      throw new ChannelSpawnError('tui', `tmux session "${handle}" exited during startup`)
    }

    return {
      handle,
      isAlive: async () => {
        const result = await runManaged(this.command, ['has-session', '-t', handle], spec, this.logger)
        return result.code === 0 && result.signal === null
      },
      open: () => this.openTerminal(handle, spec),
      close: async () => {
        await runManaged(this.command, ['detach-client', '-s', handle], spec, this.logger)
      },
      terminate: async () => {
        await runManaged(this.command, ['kill-session', '-t', handle], spec, this.logger)
      },
    }
  }

  private async openTerminal(handle: string, spec: TuiWindowSpec): Promise<void> {
    if (process.platform !== 'darwin') {
      throw new ChannelSpawnError('tui', 'automatic visible windows currently require macOS Terminal.app')
    }

    const attachCommand = `exec ${shellQuote(this.command)} attach-session -t ${shellQuote(handle)}`
    const script = [
      'tell application "Terminal"',
      'activate',
      `do script "${appleScriptString(attachCommand)}"`,
      'end tell',
    ].join('\n')
    const result = await runManaged(
      this.osascriptCommand,
      ['-e', script],
      spec,
      this.logger,
    )
    if (result.code !== 0 || result.signal !== null) {
      throw new ChannelSpawnError('tui', `failed to open Terminal.app for tmux session "${handle}"`)
    }
  }
}

/** Shared command runner used by window backends. */
function tuiHandle(harness: string, agentId: string): string {
  const safeHarness = harness.replaceAll(/[^A-Za-z0-9_-]/g, '-').slice(0, 24) || 'agent'
  const safeAgent = agentId.replaceAll(/[^A-Za-z0-9_-]/g, '-').slice(0, 32) || 'unknown'
  return `dsh-tui-${safeHarness}-${safeAgent}`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function appleScriptString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

async function runManaged(
  command: string,
  args: readonly string[],
  options: Pick<ChannelOpenOptions, 'cwd' | 'env'>,
  logger?: { warn(message: string): void },
): Promise<ProcessExitInfo> {
  const process = spawnManaged({
    command,
    args,
    cwd: options.cwd,
    env: options.env,
    onStderr: (chunk) => {
      const text = chunk.toString('utf8').trim()
      if (text !== '') logger?.warn(`TUI command stderr: ${text}`)
    },
  })
  await process.spawned
  return process.exit
}
