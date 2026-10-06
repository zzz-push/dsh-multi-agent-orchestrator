import { createServer } from 'node:net'
import { Writable } from 'node:stream'
import WebSocket from 'ws'
import { CodexChannel, type CodexChannelOptions } from './codex.js'
import { ChannelSpawnError } from '../errors.js'
import { spawnManaged, type ManagedProcess, type ProcessExitInfo } from '../process.js'
import type { ChannelOpenOptions, ChannelSession } from './types.js'
import type { JournalLogger } from '../journal/writer.js'

/** Codex app-server transport selection for a structured channel. */
export interface CodexWebSocketChannelOptions extends CodexChannelOptions {}

/**
 * Codex protocol channel using one private loopback WebSocket app-server per
 * Agent. It is transport-only; generic TUI attachment lives in `tui.ts`.
 */
export class CodexWebSocketChannel extends CodexChannel {
  private readonly transports = new Map<string, CodexWebSocketProcess>()

  constructor(options: CodexWebSocketChannelOptions = {}) {
    super(options)
  }

  override async open(options: ChannelOpenOptions): Promise<ChannelSession> {
    const session = await super.open(options)
    const transport = this.transports.get(options.agentId)
    return transport?.endpoint === undefined
      ? session
      : { ...session, endpoint: transport.endpoint }
  }

  override async close(session: ChannelSession): Promise<void> {
    this.transports.delete(session.agentId)
    await super.close(session)
  }

  protected override createProcess(
    options: ChannelOpenOptions,
    onStdout: (chunk: Buffer) => void,
  ): ManagedProcess {
    const process = new CodexWebSocketProcess({
      command: this.command,
      commandArgs: this.launchArgs(options),
      cwd: options.cwd,
      env: { ...this.env, ...options.env },
      onStdout,
      logger: this.logger,
    })
    this.transports.set(options.agentId, process)
    return process
  }
}

interface CodexWebSocketProcessOptions {
  command: string
  commandArgs: readonly string[]
  cwd?: string
  env?: Record<string, string>
  onStdout: (chunk: Buffer) => void
  logger?: JournalLogger
}

/** ManagedProcess facade over one private Codex WebSocket app-server. */
class CodexWebSocketProcess implements ManagedProcess {
  private readonly input: NonNullable<ManagedProcess['stdin']>
  private readonly exitPromise: Promise<ProcessExitInfo>
  private readonly startupPromise: Promise<void>
  private resolveExit!: (info: ProcessExitInfo) => void
  private resolveStartup!: () => void
  private rejectStartup!: (error: unknown) => void
  private server: ManagedProcess | undefined
  private socket: WebSocket | undefined
  private settled = false
  private startupComplete = false
  private exitInfo: ProcessExitInfo = { code: null, signal: null, timestamp: 0 }
  private _endpoint: string | undefined

  constructor(private readonly options: CodexWebSocketProcessOptions) {
    this.input = new Writable({
      write: (chunk: Buffer | string, _encoding, callback) => {
        if (this.socket?.readyState !== WebSocket.OPEN) {
          callback(new Error('Codex WebSocket is not open'))
          return
        }
        try {
          this.socket.send(chunk.toString())
          callback()
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)))
        }
      },
    })
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve })
    this.startupPromise = new Promise((resolve, reject) => {
      this.resolveStartup = resolve
      this.rejectStartup = reject
    })
    void this.start()
  }

  get pid(): number { return this.server?.pid ?? -1 }
  get spawned(): Promise<void> { return this.startupPromise }
  alive(): boolean { return !this.settled && (this.server?.alive() ?? !this.startupComplete) }
  get exit(): Promise<ProcessExitInfo> { return this.exitPromise }
  get stdin(): ManagedProcess['stdin'] { return this.input }
  get endpoint(): string | undefined { return this._endpoint }

  async killGraceful(graceMs = 2_000): Promise<ProcessExitInfo> {
    if (this.settled) return this.exitInfo
    await this.startupPromise.catch(() => undefined)
    this.socket?.close()
    const server = this.server
    if (server !== undefined) await server.killGraceful(graceMs)
    this.finish({ code: 0, signal: null, timestamp: Date.now() })
    return this.exitPromise
  }

  endStdin(): void { this.socket?.close() }

  private async start(): Promise<void> {
    try {
      const port = await findFreePort()
      this._endpoint = `ws://127.0.0.1:${port}`
      this.server = spawnManaged({
        command: this.options.command,
        args: [...this.options.commandArgs, 'app-server', '--listen', this._endpoint],
        cwd: this.options.cwd,
        env: this.options.env,
        onStderr: (chunk) => {
          const text = chunk.toString('utf8').trim()
          if (text !== '') this.options.logger?.warn(`codex app-server stderr: ${text}`)
        },
      })
      await this.server.spawned
      void this.server.exit.then((info) => {
        if (!this.startupComplete) {
          this.failStart(new ChannelSpawnError(this.options.command, `app-server exited before WebSocket startup (${String(info.code)})`))
        }
        this.socket?.close()
        this.finish(info)
      })

      this.socket = await connectWebSocket(this._endpoint, 15_000, () => this.server?.alive() ?? false)
      this.socket.on('message', (data) => {
        const text = typeof data === 'string' ? data : data.toString('utf8')
        this.options.onStdout(Buffer.from(`${text}\n`, 'utf8'))
      })
      this.socket.on('close', () => this.finish({ code: 0, signal: null, timestamp: Date.now() }))
      this.socket.on('error', () => {
        if (!this.startupComplete) this.failStart(new ChannelSpawnError(this.options.command, 'Codex WebSocket reported an error'))
      })
      this.startupComplete = true
      this.resolveStartup()
    } catch (error) {
      this.failStart(error)
      await this.server?.killGraceful(250).catch(() => undefined)
    }
  }

  private failStart(error: unknown): void {
    if (this.startupComplete) return
    this.startupComplete = true
    this.rejectStartup(error)
    this.finish({ code: null, signal: null, timestamp: Date.now() })
  }

  private finish(info: ProcessExitInfo): void {
    if (this.settled) return
    this.settled = true
    this.exitInfo = info
    this.resolveExit(info)
  }
}

async function connectWebSocket(
  endpoint: string,
  timeoutMs: number,
  isServerAlive: () => boolean,
): Promise<WebSocket> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    if (!isServerAlive()) {
      throw new ChannelSpawnError('codex', 'app-server exited before WebSocket startup')
    }
    try {
      return await connectWebSocketOnce(endpoint, Math.min(1_000, deadline - Date.now()))
    } catch (error) {
      lastError = error
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100)
        timer.unref?.()
      })
    }
  }
  throw new ChannelSpawnError('codex', `WebSocket startup timed out: ${String(lastError ?? endpoint)}`)
}

async function connectWebSocketOnce(endpoint: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(endpoint)
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.close()
      reject(error)
    }
    const timer = setTimeout(() => {
      fail(new ChannelSpawnError('codex', `WebSocket attempt timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()
    socket.once('open', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (error) => {
      fail(new ChannelSpawnError('codex', `WebSocket connection failed: ${String(error)}`))
    })
    socket.once('close', () => {
      fail(new ChannelSpawnError('codex', 'WebSocket closed during startup'))
    })
  })
}

async function findFreePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : undefined
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  if (port === undefined) throw new Error('Could not allocate a local Codex WebSocket port')
  return port
}
