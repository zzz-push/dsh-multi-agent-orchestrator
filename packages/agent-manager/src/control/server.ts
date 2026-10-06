import net from 'node:net'
import { mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AgentManagerError } from '../errors.js'
import type { AgentCommand, ChatReply } from '../channel/types.js'
import type { JournalLogger } from '../journal/writer.js'
import type { ControlRequest, ControlResponse, ControlWireError } from './protocol.js'

/**
 * Directory holding one control socket per live `AgentManager` process,
 * named by its `ownerGeneration` (never its pid — see
 * `registry/live-agents.ts` for why pid-based paths are unsafe here).
 *
 * Unlike `defaultLiveAgentRegistryDir()`, this does not default under the
 * user's home directory: `sockaddr_un.sun_path` caps a Unix domain socket's
 * full path at ~104 bytes on macOS (108 on Linux), and a home directory can
 * be nested arbitrarily deep (corporate SSO-mapped homes, for one) — the OS
 * temp directory is the one path Node itself keeps short enough to leave
 * room for a directory name and a socket filename. `DSH_HOME` is still
 * honored when explicitly set, since setting it is an operator's own choice
 * to make and they can keep it short.
 */
export function defaultControlSocketDir(
  env: NodeJS.ProcessEnv = process.env,
  tmpdir: string = os.tmpdir(),
): string {
  if (env.DSH_HOME !== undefined && env.DSH_HOME.trim() !== '') {
    return path.join(env.DSH_HOME, 'runtime', 'agent-manager', 'control')
  }
  return path.join(tmpdir, 'dsh-agent-control')
}

/** Local operations the control server dispatches a forwarded request to. */
export interface ControlServerHandlers {
  sendChat(agentId: string, text: string, options: { timeoutMs?: number; signal?: AbortSignal; scenario?: string }): Promise<ChatReply>
  sendCommand(agentId: string, command: AgentCommand): Promise<void>
  close(agentId: string): Promise<void>
}

export interface ControlServerOptions {
  /** Full path of this process's socket, e.g. `<dir>/<ownerGeneration>.sock`. */
  socketPath: string
  handlers: ControlServerHandlers
  logger?: JournalLogger
}

/**
 * Per-process control endpoint: accepts one-shot connections
 * carrying a single `ControlRequest` line and dispatches it to the local
 * `AgentManager` that actually owns the agent's channel.
 *
 * Every in-flight request gets its own `AbortController`; a client that
 * disconnects before a response is ready aborts the underlying local call
 * (best-effort — a harness that cannot cancel a turn just keeps running it
 * to completion with no one left to receive the result, the same outcome a
 * local caller aborting an uncancellable channel already gets today).
 */
export class ControlServer {
  private readonly server: net.Server
  private readonly socketPath: string
  private readonly handlers: ControlServerHandlers
  private readonly logger?: JournalLogger
  private readonly inFlight = new Set<AbortController>()
  private listening = false

  constructor(options: ControlServerOptions) {
    this.socketPath = options.socketPath
    this.handlers = options.handlers
    this.logger = options.logger
    // Not half-open: a connection that closes before the reply was written
    // means the client left, and the request is aborted (see
    // `handleConnection`). Clients therefore keep their write side open
    // until the reply arrives (control/client.ts).
    this.server = net.createServer((socket) => this.handleConnection(socket))
    this.server.on('error', (error) => {
      this.logger?.warn(`Control server error on ${this.socketPath}: ${String(error)}`)
    })
  }

  /** Idempotent: starts listening once, later calls resolve immediately. */
  async start(): Promise<void> {
    if (this.listening) return
    await mkdir(path.dirname(this.socketPath), { recursive: true, mode: 0o700 })
    // A generation-scoped path should never already exist, but a prior
    // process that crashed mid-bind could leave one behind; clear it first
    // so `listen()` does not fail with EADDRINUSE on a dead socket.
    await rm(this.socketPath, { force: true })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: unknown): void => reject(error as Error)
      this.server.once('error', onError)
      this.server.listen(this.socketPath, () => {
        this.server.removeListener('error', onError)
        resolve()
      })
    })
    this.listening = true
  }

  /** Idempotent: stops accepting connections, aborts in-flight work, unlinks the socket file. */
  async stop(): Promise<void> {
    if (!this.listening) return
    this.listening = false
    for (const controller of this.inFlight) controller.abort()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    await rm(this.socketPath, { force: true })
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = ''
    let responded = false
    const abortController = new AbortController()
    this.inFlight.add(abortController)
    const done = (): void => {
      this.inFlight.delete(abortController)
    }

    // One request per connection: once its line is in, later bytes are
    // ignored — still buffering them would find the same newline again and
    // dispatch the request a second time.
    let dispatched = false
    const reply = (response: ControlResponse): void => {
      responded = true
      socket.end(`${JSON.stringify(response)}\n`)
    }
    socket.on('data', (chunk: Buffer) => {
      if (dispatched) return
      buffer += chunk.toString('utf8')
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) {
        if (buffer.length > MAX_REQUEST_CHARS) {
          dispatched = true
          buffer = ''
          reply({ ok: false, error: { code: 'bad-request', message: `control request exceeds ${MAX_REQUEST_CHARS} characters` } })
          done()
        }
        return
      }
      dispatched = true
      const line = buffer.slice(0, newlineIndex)
      buffer = ''
      void this.handleRequestLine(line, abortController.signal)
        .then(reply)
        .finally(done)
    })
    socket.on('error', () => {
      abortController.abort()
    })
    socket.on('close', () => {
      if (!responded) abortController.abort()
      done()
    })
  }

  private async handleRequestLine(line: string, signal: AbortSignal): Promise<ControlResponse> {
    let request: ControlRequest
    try {
      request = JSON.parse(line) as ControlRequest
    } catch (error) {
      return { ok: false, error: { code: 'bad-request', message: `malformed control request: ${String(error)}` } }
    }
    const invalid = invalidRequest(request)
    if (invalid !== undefined) {
      return { ok: false, error: { code: 'bad-request', message: `malformed control request: ${invalid}` } }
    }
    try {
      const result = await this.dispatch(request, signal)
      return { ok: true, result: result === undefined ? null : result }
    } catch (error) {
      return { ok: false, error: toWireError(error) }
    }
  }

  private dispatch(request: ControlRequest, signal: AbortSignal): Promise<unknown> {
    switch (request.method) {
      case 'sendChat':
        return this.handlers.sendChat(request.agentId, request.text ?? '', {
          timeoutMs: request.timeoutMs,
          signal,
          ...(typeof request.scenario === 'string' ? { scenario: request.scenario } : {}),
        })
      case 'sendCommand':
        return this.handlers.sendCommand(request.agentId, request.command as AgentCommand)
      case 'close':
        return this.handlers.close(request.agentId)
      default:
        return Promise.reject(new Error(`Unknown control method: ${String((request as { method?: unknown }).method)}`))
    }
  }
}

/**
 * Largest request line accepted. Chat text is typed by a person (the DSH page
 * caps it at 20000 characters); this only stops a connection from growing the
 * buffer without end by never sending a newline.
 */
export const MAX_REQUEST_CHARS = 1_048_576

/** Why a parsed line is not a request the handlers can take, or `undefined` when it is. */
function invalidRequest(request: unknown): string | undefined {
  if (typeof request !== 'object' || request === null) return 'not an object'
  const { agentId, text, timeoutMs, scenario } = request as Record<string, unknown>
  if (typeof agentId !== 'string' || agentId === '') return 'agentId must be a non-empty string'
  if (text !== undefined && typeof text !== 'string') return 'text must be a string'
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    return 'timeoutMs must be a positive number'
  }
  if (scenario !== undefined && typeof scenario !== 'string') return 'scenario must be a string'
  return undefined
}

function toWireError(error: unknown): ControlWireError {
  if (error instanceof AgentManagerError) {
    return { code: error.code, message: error.message, details: error.details }
  }
  return { code: 'internal-error', message: error instanceof Error ? error.message : String(error) }
}
