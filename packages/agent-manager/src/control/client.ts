import net from 'node:net'
import { RemoteAgentError } from '../errors.js'
import type { ControlRequest, ControlResponse } from './protocol.js'

/**
 * Why a control request got no reply:
 * - `unreachable` — nothing answered at the socket (no file, refused): the
 *   owner is gone, or its pid now belongs to someone else;
 * - `timeout`, `aborted`, `closed`, `malformed` — the owner was reached and
 *   then the exchange failed. The owner may well be alive and busy.
 */
export type ControlFailureReason = 'unreachable' | 'timeout' | 'aborted' | 'closed' | 'malformed'

/**
 * A control request that got no reply. A transport-local error, never thrown
 * to a public `AgentManager` caller: `forwardToOwner` turns `unreachable`
 * into `AgentOwnerUnreachableError` (and prunes the stale registry entry),
 * everything else into `AgentForwardError` — a slow or cancelled exchange
 * says nothing about the owner being gone, so the entry stays.
 */
export class ControlUnreachableError extends Error {
  constructor(message: string, readonly reason: ControlFailureReason) {
    super(message)
    this.name = 'ControlUnreachableError'
  }
}

/**
 * Send one control request and wait for its single-line JSON response.
 *
 * One connection per request: connect, write the request line, wait for
 * exactly one response line, then tear down. The write side stays open
 * until the reply arrives: the server reads a connection that closes before
 * it replied as the caller having left and aborts the request, and a
 * half-close (FIN) closes the whole connection on its side. Half-closing
 * here aborted every forwarded turn that was not instant.
 * `options.signal` aborting destroys the connection immediately — the
 * server observes the client going away and treats it as a cancellation
 * (see `ControlServer.handleConnection`).
 */
export function requestControl(
  socketPath: string,
  request: ControlRequest,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new ControlUnreachableError('aborted before connecting', 'aborted'))
      return
    }

    let settled = false
    let buffer = ''
    let timer: ReturnType<typeof setTimeout> | undefined

    const socket = net.createConnection(socketPath)

    const finish = (run: () => void): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      socket.removeAllListeners()
      socket.destroy()
      run()
    }

    const onAbort = (): void => {
      finish(() => reject(new ControlUnreachableError('control request aborted by caller', 'aborted')))
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    timer = setTimeout(() => {
      finish(() => reject(new ControlUnreachableError(
        `control request to ${socketPath} timed out after ${options.timeoutMs} ms`,
        'timeout',
      )))
    }, options.timeoutMs)

    let connected = false
    socket.on('connect', () => {
      connected = true
      socket.write(`${JSON.stringify(request)}\n`)
    })

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) return
      const line = buffer.slice(0, newlineIndex)
      finish(() => {
        let response: ControlResponse
        try {
          response = JSON.parse(line) as ControlResponse
        } catch (error) {
          reject(new ControlUnreachableError(`malformed control response: ${String(error)}`, 'malformed'))
          return
        }
        if (response.ok) resolve(response.result)
        else reject(new RemoteAgentError(response.error.code, response.error.message, response.error.details))
      })
    })

    socket.on('error', (error) => {
      finish(() => reject(connected
        ? new ControlUnreachableError(`control connection to ${socketPath} failed: ${String(error)}`, 'closed')
        : new ControlUnreachableError(`cannot reach control socket ${socketPath}: ${String(error)}`, 'unreachable')))
    })

    socket.on('close', () => {
      finish(() => reject(new ControlUnreachableError(`control connection to ${socketPath} closed before a response arrived`, connected ? 'closed' : 'unreachable')))
    })
  })
}
