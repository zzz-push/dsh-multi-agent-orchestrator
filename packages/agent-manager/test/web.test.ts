import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentManager, DiscoveredAgent } from '../src/manager.js'
import { isInsideProject, registerAgentManagerWebSurface } from '../src/web.js'
import { AgentNotFoundError, AgentOwnerUnreachableError } from '../src/errors.js'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

interface Reply {
  status: number
  body: unknown
}

function fakeWebServer(): { routes: Map<string, Handler> } {
  const routes = new Map<string, Handler>()
  return {
    routes,
    register(route: { path: string; handler: Handler }) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  } as { routes: Map<string, Handler> }
}

function fakeContext(webServer: unknown): Context {
  return {
    get: (key: string) => (key === 'webServer' ? webServer : undefined),
    effect: (callback: () => unknown) => callback(),
    on: () => () => undefined,
  } as unknown as Context
}

function agentInfo(overrides: Partial<DiscoveredAgent>): DiscoveredAgent {
  return {
    agentId: 'agent',
    roleId: 'example-advisor',
    harness: 'codex',
    harnessSessionId: 'thread',
    cwd: '/nowhere',
    keepAliveAfterTask: true,
    interactionMode: 'interactive',
    showWindow: true,
    status: 'open',
    external: false,
    ownerPid: process.pid,
    ...overrides,
  }
}

/** What the desktop app's forwarder sends: loopback host, no Origin, JSON bodies. */
function pageHeaders(method: string): Record<string, string> {
  return method === 'POST'
    ? { host: '127.0.0.1:19387', 'content-type': 'application/json' }
    : { host: '127.0.0.1:19387' }
}

async function call(
  handler: Handler,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = pageHeaders(method),
): Promise<Reply> {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]) as unknown as IncomingMessage
  Object.assign(req, { method, url, headers })
  let status = 0
  let payload = ''
  const res = {
    writeHead: (code: number) => { status = code },
    end: (chunk: string) => { payload = chunk },
  } as unknown as ServerResponse
  await handler(req, res)
  return { status, body: JSON.parse(payload) }
}

describe('agent window web surface', () => {
  let root: string
  let project: string
  let elsewhere: string
  let manager: AgentManager
  let routes: Map<string, Handler>

  beforeEach(async () => {
    // tmpdir() on macOS is a symlink (/var → /private/var): agents record the
    // resolved-but-not-canonical path while DSH reports the realpath canon.
    root = await mkdtemp(path.join(tmpdir(), 'dsh-web-'))
    project = path.join(root, 'project')
    elsewhere = path.join(root, 'elsewhere')
    await mkdir(path.join(project, 'worktrees', 'step-1'), { recursive: true })
    await mkdir(elsewhere, { recursive: true })
    const agents = [
      agentInfo({ agentId: 'in-root', cwd: project }),
      agentInfo({ agentId: 'in-worktree', cwd: path.join(project, 'worktrees', 'step-1'), external: true, ownerPid: 4242 }),
      agentInfo({ agentId: 'outside', cwd: elsewhere }),
      agentInfo({ agentId: 'sibling-prefix', cwd: `${project}-other` }),
    ]
    manager = {
      discover: vi.fn(async () => agents),
      get: vi.fn((agentId: string) => agents.find((agent) => agent.agentId === agentId && !agent.external)),
      listRoles: vi.fn(async () => []),
      sendChat: vi.fn(async () => ({ text: 'ok', durationMs: 1 })),
      close: vi.fn(async () => undefined),
    } as unknown as AgentManager
    const server = fakeWebServer()
    routes = server.routes
    registerAgentManagerWebSurface(fakeContext(server), manager)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('returns every agent when no project is given', async () => {
    const reply = await call(routes.get('/plugins/dsh-agent-manager/state')!, 'GET', '/plugins/dsh-agent-manager/state')
    expect(reply.status).toBe(200)
    const body = reply.body as { project: string | null; agents: Array<{ agentId: string; cwd: string; external: boolean; ownerPid: number }> }
    expect(body.project).toBeNull()
    expect(body.agents.map((agent) => agent.agentId)).toEqual(['in-root', 'in-worktree', 'outside', 'sibling-prefix'])
    expect(body.agents[0]).toMatchObject({ cwd: project, external: false, ownerPid: process.pid })
    expect(body.agents[1]).toMatchObject({ external: true, ownerPid: 4242 })
  })

  it('drives an external agent the same as a local one — AgentManager forwards it', async () => {
    // web.ts no longer distinguishes external from local: it calls
    // sendChat/close unconditionally and lets AgentManager itself forward to
    // the owner over its control socket. Real forwarding is covered end to
    // end in manager.test.ts and control.test.ts; this only checks that the
    // web layer stopped pre-emptively rejecting external agents.
    const chat = await call(routes.get('/plugins/dsh-agent-manager/chat')!, 'POST', '/plugins/dsh-agent-manager/chat', { agentId: 'in-worktree', text: 'hello' })
    expect(chat.status).toBe(200)
    expect(manager.sendChat).toHaveBeenCalledWith('in-worktree', 'hello')

    const close = await call(routes.get('/plugins/dsh-agent-manager/close')!, 'POST', '/plugins/dsh-agent-manager/close', { agentId: 'in-worktree' })
    expect(close.status).toBe(200)
    expect(manager.close).toHaveBeenCalledWith('in-worktree')

    const own = await call(routes.get('/plugins/dsh-agent-manager/chat')!, 'POST', '/plugins/dsh-agent-manager/chat', { agentId: 'in-root', text: 'hello' })
    expect(own.status).toBe(200)
    expect(manager.sendChat).toHaveBeenCalledWith('in-root', 'hello')
  })

  it('maps an unreachable owner to 502, distinct from a plain not-found', async () => {
    vi.mocked(manager.sendChat).mockRejectedValueOnce(new AgentOwnerUnreachableError('in-worktree', 4242))
    const chat = await call(routes.get('/plugins/dsh-agent-manager/chat')!, 'POST', '/plugins/dsh-agent-manager/chat', { agentId: 'in-worktree', text: 'hello' })
    expect(chat.status).toBe(502)
    expect((chat.body as { error: string }).error).toMatch(/no longer reachable/)

    vi.mocked(manager.close).mockRejectedValueOnce(new AgentNotFoundError('nobody'))
    const close = await call(routes.get('/plugins/dsh-agent-manager/close')!, 'POST', '/plugins/dsh-agent-manager/close', { agentId: 'nobody' })
    expect(close.status).toBe(404)
  })

  it('scopes the state to agents started inside the requested project', async () => {
    const canonical = await realpath(project)
    const handler = routes.get('/plugins/dsh-agent-manager/state')!
    for (const cwd of [project, canonical, `${project}${path.sep}`]) {
      const reply = await call(handler, 'GET', `/plugins/dsh-agent-manager/state?cwd=${encodeURIComponent(cwd)}`)
      expect(reply.status).toBe(200)
      const body = reply.body as { project: string | null; agents: Array<{ agentId: string }> }
      expect(body.project).toBe(canonical)
      expect(body.agents.map((agent) => agent.agentId)).toEqual(['in-root', 'in-worktree'])
    }
  })

  it('lists an evaluation arm on the page of the project it evaluates, and refuses to drive it', async () => {
    // The arm runs in a temporary worktree outside every workspace (`elsewhere`
    // here); it belongs on the page of the project the comparison is about.
    const arm = agentInfo({
      agentId: 'arm',
      cwd: elsewhere,
      external: true,
      ownerPid: 5151,
      evaluation: { comparisonId: 'cmp-1', taskId: 'example-task', arm: 'baseline', workspace: project },
    })
    const everyone = [...await manager.discover(), arm]
    vi.mocked(manager.discover).mockResolvedValue(everyone)

    const state = await call(routes.get('/plugins/dsh-agent-manager/state')!, 'GET', `/plugins/dsh-agent-manager/state?cwd=${encodeURIComponent(project)}`)
    const agents = (state.body as { agents: Array<{ agentId: string; evaluation?: unknown }> }).agents
    expect(agents.map((agent) => agent.agentId)).toEqual(['in-root', 'in-worktree', 'arm'])
    expect(agents[2]!.evaluation).toEqual({ comparisonId: 'cmp-1', taskId: 'example-task', arm: 'baseline', workspace: project })
    const other = await call(routes.get('/plugins/dsh-agent-manager/state')!, 'GET', `/plugins/dsh-agent-manager/state?cwd=${encodeURIComponent(elsewhere)}`)
    expect((other.body as { agents: Array<{ agentId: string }> }).agents.map((agent) => agent.agentId)).toEqual(['outside'])

    const chat = await call(routes.get('/plugins/dsh-agent-manager/chat')!, 'POST', '/plugins/dsh-agent-manager/chat', { agentId: 'arm', text: 'nudge' })
    expect(chat.status).toBe(409)
    expect((chat.body as { error: string }).error).toMatch(/observe-only.*arm "baseline" of comparison cmp-1/)
    const close = await call(routes.get('/plugins/dsh-agent-manager/close')!, 'POST', '/plugins/dsh-agent-manager/close', { agentId: 'arm' })
    expect(close.status).toBe(409)
    expect(manager.sendChat).not.toHaveBeenCalled()
    expect(manager.close).not.toHaveBeenCalled()
  })

  it('scopes a missing project directory by its resolved spelling', async () => {
    const missing = path.join(root, 'gone')
    const reply = await call(routes.get('/plugins/dsh-agent-manager/state')!, 'GET', `/plugins/dsh-agent-manager/state?cwd=${encodeURIComponent(missing)}`)
    expect(reply.status).toBe(200)
    expect((reply.body as { project: string; agents: unknown[] })).toMatchObject({ project: missing, agents: [] })
  })

  it('serves the DSH pages: the desktop forwarder, the web profile, and local tools', async () => {
    const chat = routes.get('/plugins/dsh-agent-manager/chat')!
    const state = routes.get('/plugins/dsh-agent-manager/state')!
    // Desktop app: forwarded by its main process, Origin and Sec-Fetch-Site removed.
    expect((await call(chat, 'POST', '/plugins/dsh-agent-manager/chat', { agentId: 'in-root', text: 'hi' })).status).toBe(200)
    // Web profile: an ordinary same-origin page.
    const webPage = { host: 'localhost:3080', origin: 'http://localhost:3080', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json; charset=utf-8' }
    expect((await call(chat, 'POST', '/plugins/dsh-agent-manager/chat', { agentId: 'in-root', text: 'hi' }, webPage)).status).toBe(200)
    expect((await call(state, 'GET', '/plugins/dsh-agent-manager/state', undefined, { host: '[::1]:3080', 'sec-fetch-site': 'none' })).status).toBe(200)
    // curl and scripts on this machine.
    expect((await call(state, 'GET', '/plugins/dsh-agent-manager/state', undefined, { host: 'localhost' })).status).toBe(200)
    expect(manager.sendChat).toHaveBeenCalledTimes(2)
  })

  it('refuses requests another web site starts, including through DNS rebinding', async () => {
    const chat = routes.get('/plugins/dsh-agent-manager/chat')!
    const close = routes.get('/plugins/dsh-agent-manager/close')!
    const state = routes.get('/plugins/dsh-agent-manager/state')!
    const body = { agentId: 'in-root', text: 'rm -rf the repo' }
    const json = { 'content-type': 'application/json' }
    const refused = [
      // A form or fetch posting text/plain needs no preflight, so it must be stopped here.
      await call(chat, 'POST', '/plugins/dsh-agent-manager/chat', JSON.stringify(body), { host: '127.0.0.1:19387', origin: 'https://evil.example', 'content-type': 'text/plain' }),
      await call(chat, 'POST', '/plugins/dsh-agent-manager/chat', JSON.stringify(body), { host: '127.0.0.1:19387', 'content-type': 'text/plain' }),
      await call(close, 'POST', '/plugins/dsh-agent-manager/close', { agentId: 'in-root' }, { host: '127.0.0.1:19387', ...json, 'sec-fetch-site': 'cross-site' }),
      await call(close, 'POST', '/plugins/dsh-agent-manager/close', { agentId: 'in-root' }, { host: '127.0.0.1:19387', ...json, origin: 'null' }),
      await call(close, 'POST', '/plugins/dsh-agent-manager/close', { agentId: 'in-root' }, { host: '127.0.0.1:19387', ...json, origin: 'http://127.0.0.1:3080' }),
      // DNS rebinding: same origin as far as the browser knows, but the host is the attacker's name.
      await call(state, 'GET', '/plugins/dsh-agent-manager/state', undefined, { host: 'evil.example:19387', 'sec-fetch-site': 'same-origin' }),
      await call(chat, 'POST', '/plugins/dsh-agent-manager/chat', body, { host: 'evil.example:19387', origin: 'http://evil.example:19387', ...json }),
      await call(state, 'GET', '/plugins/dsh-agent-manager/state', undefined, {}),
    ]
    expect(refused.map((reply) => reply.status)).toEqual(Array(refused.length).fill(403))
    expect((refused[0]!.body as { error: string }).error).toMatch(/^refused: /)
    expect(manager.sendChat).not.toHaveBeenCalled()
    expect(manager.close).not.toHaveBeenCalled()
    expect(manager.discover).not.toHaveBeenCalled()
  })

  it('accepts the host names DSH is served under with --trusted-host', async () => {
    const server = fakeWebServer()
    registerAgentManagerWebSurface(fakeContext(server), manager, undefined, { trustedHosts: ['harness.internal', 'box.lan:8080'] })
    const state = server.routes.get('/plugins/dsh-agent-manager/state')!
    const status = async (host: string): Promise<number> => (await call(state, 'GET', '/plugins/dsh-agent-manager/state', undefined, { host })).status
    expect(await status('harness.internal:3080')).toBe(200)
    expect(await status('HARNESS.internal')).toBe(200)
    expect(await status('box.lan:8080')).toBe(200)
    expect(await status('box.lan:9090')).toBe(403)
    expect(await status('evil.internal')).toBe(403)
  })

  it('no longer offers a spawn route: the page never used it, and it started agents in any directory', () => {
    expect(routes.has('/plugins/dsh-agent-manager/spawn')).toBe(false)
    expect([...routes.keys()].sort()).toEqual([
      '/plugins/dsh-agent-manager/chat',
      '/plugins/dsh-agent-manager/close',
      '/plugins/dsh-agent-manager/conversation',
      '/plugins/dsh-agent-manager/state',
    ])
  })

  it('treats only the project root and its descendants as inside', () => {
    expect(isInsideProject('/a/b', '/a/b')).toBe(true)
    expect(isInsideProject(path.join('/a', 'b', 'c'), path.join('/a', 'b'))).toBe(true)
    expect(isInsideProject(path.join('/a', 'b', 'c'), path.join('/a', 'b') + path.sep)).toBe(true)
    expect(isInsideProject('/a/bc', '/a/b')).toBe(false)
    expect(isInsideProject('/a', '/a/b')).toBe(false)
  })
})
