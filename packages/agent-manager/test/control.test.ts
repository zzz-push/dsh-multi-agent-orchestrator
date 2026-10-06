import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlUnreachableError, requestControl } from '../src/control/client.js'
import { ControlServer, defaultControlSocketDir, type ControlServerHandlers } from '../src/control/server.js'
import { RemoteAgentError, AgentNotFoundError } from '../src/errors.js'
import type { ChatReply } from '../src/channel/types.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function socketPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-control-'))
  dirs.push(dir)
  return path.join(dir, 'generation-a.sock')
}

function noopHandlers(overrides: Partial<ControlServerHandlers> = {}): ControlServerHandlers {
  return {
    sendChat: async () => ({ text: 'unused', durationMs: 0, toolCalls: [] }),
    sendCommand: async () => undefined,
    close: async () => undefined,
    ...overrides,
  }
}

describe('ControlServer + requestControl', () => {
  it('round-trips sendChat, sendCommand, and close through a real socket', async () => {
    const socket = await socketPath()
    const sendCommandCalls: unknown[] = []
    const closeCalls: string[] = []
    const server = new ControlServer({
      socketPath: socket,
      handlers: noopHandlers({
        sendChat: async (agentId, text) => ({ text: `reply:${agentId}:${text}`, durationMs: 5, toolCalls: [] }) satisfies ChatReply,
        sendCommand: async (agentId, command) => { sendCommandCalls.push({ agentId, command }) },
        close: async (agentId) => { closeCalls.push(agentId) },
      }),
    })
    await server.start()
    try {
      const chatResult = await requestControl(socket, { method: 'sendChat', agentId: 'agent-1', text: 'hi', timeoutMs: 1000 }, { timeoutMs: 1000 })
      expect(chatResult).toEqual({ text: 'reply:agent-1:hi', durationMs: 5, toolCalls: [] })

      const commandResult = await requestControl(socket, { method: 'sendCommand', agentId: 'agent-1', command: { kind: 'task', payload: { x: 1 }, text: 'do it' } }, { timeoutMs: 1000 })
      expect(commandResult).toBeNull()
      expect(sendCommandCalls).toEqual([{ agentId: 'agent-1', command: { kind: 'task', payload: { x: 1 }, text: 'do it' } }])

      const closeResult = await requestControl(socket, { method: 'close', agentId: 'agent-1' }, { timeoutMs: 1000 })
      expect(closeResult).toBeNull()
      expect(closeCalls).toEqual(['agent-1'])
    } finally {
      await server.stop()
    }
  })

  it('reconstructs a thrown AgentManagerError as RemoteAgentError with the same code', async () => {
    const socket = await socketPath()
    const server = new ControlServer({
      socketPath: socket,
      handlers: noopHandlers({
        sendChat: async () => { throw new AgentNotFoundError('agent-1') },
      }),
    })
    await server.start()
    try {
      const call = requestControl(socket, { method: 'sendChat', agentId: 'agent-1', text: 'hi' }, { timeoutMs: 1000 })
      await expect(call).rejects.toBeInstanceOf(RemoteAgentError)
      await expect(call).rejects.toMatchObject({ code: 'agent-not-found' })
    } finally {
      await server.stop()
    }
  })

  it('wraps a non-AgentManagerError as an internal-error RemoteAgentError', async () => {
    const socket = await socketPath()
    const server = new ControlServer({
      socketPath: socket,
      handlers: noopHandlers({
        sendCommand: async () => { throw new Error('boom') },
      }),
    })
    await server.start()
    try {
      await expect(requestControl(socket, { method: 'sendCommand', agentId: 'a', command: { kind: 'x', payload: null, text: 'x' } }, { timeoutMs: 1000 }))
        .rejects.toMatchObject({ code: 'internal-error', message: expect.stringContaining('boom') })
    } finally {
      await server.stop()
    }
  })

  it('rejects with ControlUnreachableError when nothing is listening', async () => {
    const socket = await socketPath()
    await expect(requestControl(socket, { method: 'close', agentId: 'a' }, { timeoutMs: 500 }))
      .rejects.toBeInstanceOf(ControlUnreachableError)
  })

  it('rejects with ControlUnreachableError on a client-side timeout', async () => {
    const socket = await socketPath()
    const server = new ControlServer({
      socketPath: socket,
      handlers: noopHandlers({
        sendChat: () => new Promise(() => { /* never resolves */ }),
      }),
    })
    await server.start()
    try {
      await expect(requestControl(socket, { method: 'sendChat', agentId: 'a', text: 'hi' }, { timeoutMs: 50 }))
        .rejects.toBeInstanceOf(ControlUnreachableError)
    } finally {
      await server.stop()
    }
  })

  it('lets a turn that takes a while finish: the client half-closing after its request is not a cancellation', async () => {
    // Seen in real use: a chat forwarded from a DSH page was
    // aborted 9 ms after it was sent, because the server treated the client's
    // half-close (it is done writing, still reading) as the client leaving.
    const socket = await socketPath()
    let observedAborted = false
    const server = new ControlServer({
      socketPath: socket,
      handlers: noopHandlers({
        sendChat: (_agentId, text, options) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ text: `slow:${text}`, durationMs: 150, toolCalls: [] }), 150)
          options.signal?.addEventListener('abort', () => {
            observedAborted = true
            clearTimeout(timer)
            reject(new Error('aborted'))
          })
        }),
      }),
    })
    await server.start()
    try {
      await expect(requestControl(socket, { method: 'sendChat', agentId: 'a', text: 'hi' }, { timeoutMs: 5000 }))
        .resolves.toEqual({ text: 'slow:hi', durationMs: 150, toolCalls: [] })
      expect(observedAborted).toBe(false)
    } finally {
      await server.stop()
    }
  })

  it('aborts the server-side handler when the caller signal fires', async () => {
    const socket = await socketPath()
    let observedAborted = false
    const server = new ControlServer({
      socketPath: socket,
      handlers: noopHandlers({
        sendChat: (_agentId, _text, options) => new Promise((resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            observedAborted = true
            reject(new Error('aborted'))
          })
        }),
      }),
    })
    await server.start()
    try {
      const controller = new AbortController()
      const call = requestControl(socket, { method: 'sendChat', agentId: 'a', text: 'hi' }, { timeoutMs: 5000, signal: controller.signal })
      // Give the connection time to actually reach the server and invoke the
      // handler before aborting — an immediate microtask-scheduled abort can
      // fire before `net.createConnection` even connects, destroying the
      // socket before the request was ever sent.
      setTimeout(() => controller.abort(), 20)
      await expect(call).rejects.toBeInstanceOf(ControlUnreachableError)
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(observedAborted).toBe(true)
    } finally {
      await server.stop()
    }
  })

  it('dispatches a request once, whatever else arrives on the connection before the reply', async () => {
    const socket = await socketPath()
    let calls = 0
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const server = new ControlServer({
      socketPath: socket,
      handlers: noopHandlers({
        close: async () => {
          calls += 1
          await held
        },
      }),
    })
    await server.start()
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        const connection = net.createConnection(socket)
        let received = ''
        connection.on('data', (chunk) => { received += chunk.toString('utf8') })
        connection.on('end', () => resolve(received))
        connection.on('error', reject)
        connection.write(`${JSON.stringify({ method: 'close', agentId: 'agent-1' })}\n`)
        // Each later write used to find the first newline again and re-dispatch.
        setTimeout(() => connection.write('x'), 20)
        setTimeout(() => connection.write('y\n'), 40)
        setTimeout(release, 80)
      })
      expect(JSON.parse(reply)).toEqual({ ok: true, result: null })
      expect(calls).toBe(1)
    } finally {
      await server.stop()
    }
  })

  it('refuses a request whose fields are not what the handlers take', async () => {
    const socket = await socketPath()
    let calls = 0
    const server = new ControlServer({ socketPath: socket, handlers: noopHandlers({ sendChat: async () => { calls += 1; return { text: '', durationMs: 0, toolCalls: [] } } }) })
    await server.start()
    try {
      await expect(requestControl(socket, { method: 'sendChat', agentId: 'agent-1', text: 'hi', timeoutMs: -1 }, { timeoutMs: 1000 }))
        .rejects.toMatchObject({ code: 'bad-request' })
      await expect(requestControl(socket, { method: 'sendChat', agentId: '' }, { timeoutMs: 1000 }))
        .rejects.toMatchObject({ code: 'bad-request' })
      expect(calls).toBe(0)
    } finally {
      await server.stop()
    }
  })

  it('start() is idempotent and stop() unlinks the socket file', async () => {
    const socket = await socketPath()
    const server = new ControlServer({ socketPath: socket, handlers: noopHandlers() })
    await server.start()
    await server.start()
    await expect(stat(socket)).resolves.toBeDefined()
    await server.stop()
    await expect(stat(socket)).rejects.toThrow()
    // Idempotent: stopping an already-stopped server is a no-op, not a throw.
    await expect(server.stop()).resolves.toBeUndefined()
  })
})

describe('defaultControlSocketDir', () => {
  it('lives under DSH_HOME when set, else the OS temp directory', () => {
    // Not the home directory: sockaddr_un caps a socket path at ~104 bytes
    // (macOS) / 108 (Linux), and a home directory can be nested arbitrarily
    // deep, unlike the OS temp directory.
    expect(defaultControlSocketDir({ DSH_HOME: '/srv/dsh' }, '/tmp'))
      .toBe(path.join('/srv/dsh', 'runtime', 'agent-manager', 'control'))
    expect(defaultControlSocketDir({ DSH_HOME: '  ' }, '/tmp'))
      .toBe(path.join('/tmp', 'dsh-agent-control'))
    expect(defaultControlSocketDir({}, '/tmp'))
      .toBe(path.join('/tmp', 'dsh-agent-control'))
  })
})
