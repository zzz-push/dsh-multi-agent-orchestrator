import { realpath } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AgentManagerError, AgentObserveOnlyError } from './errors.js'
import type { JournalLogger } from './journal/writer.js'
import type { AgentManager } from './manager.js'

const WEB_SERVER_KEYS = ['webServer', 'httpServer'] as const
const ROUTE_PREFIX = '/plugins/dsh-agent-manager'
const MAX_BODY_BYTES = 64 * 1024

interface WebRoute {
  kind: 'exact'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
}

interface WebServerLike {
  register(route: WebRoute): () => void
}

/** Register the same-origin API consumed by the Harness Agent window client. */
export function registerAgentManagerWebSurface(
  ctx: Context,
  manager: AgentManager,
  logger?: JournalLogger,
  options: { trustedHosts?: readonly string[] } = {},
): void {
  const trustedHosts = options.trustedHosts ?? []
  let registered = false

  const register = (): void => {
    if (registered) return
    const webServer = WEB_SERVER_KEYS
      .map((key) => ctx.get(key) as WebServerLike | undefined)
      .find((candidate) => candidate !== undefined)
    if (webServer === undefined) return
    registered = true

    const route = (path: string, handler: WebRoute['handler']): void => {
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}${path}`,
        handler: async (req, res) => {
          try {
            assertPageRequest(req, trustedHosts)
            await handler(req, res)
          } catch (error) {
            logger?.error(`Agent window route ${path} failed: ${String(error)}`)
            sendError(res, error)
          }
        },
      }), `agent-manager web route ${path}`)
    }

    route('/state', async (req, res) => {
      requireMethod(req, 'GET')
      // `cwd` is the Workspace directory of the DSH page asking. When present the
      // reply is scoped to agents started inside it, so a page bound to project A
      // never lists project B's children; without it the full manager view is
      // returned for callers that have no project notion.
      const projectCwd = optionalQuery(requestUrl(req), 'cwd')
      const project = projectCwd === undefined ? undefined : await canonicalDirectory(projectCwd)
      // discover() = this host's children + agents other AgentManager processes
      // on the machine advertise (scripts, demos, dispatch runs).
      const agents = await filterAgentsByProject(await manager.discover(), project)
      const roles = await manager.listRoles()
      sendJson(res, 200, {
        project: project ?? null,
        agents: agents.map((agent) => ({
          agentId: agent.agentId,
          roleId: agent.roleId,
          harness: agent.harness,
          harnessSessionId: agent.harnessSessionId,
          cwd: agent.cwd,
          keepAliveAfterTask: agent.keepAliveAfterTask,
          interactionMode: agent.interactionMode,
          showWindow: agent.showWindow,
          windowHandle: agent.windowHandle ?? null,
          status: agent.status,
          external: agent.external,
          ownerPid: agent.ownerPid,
          ...(agent.lastTurnStartedAt === undefined ? {} : { lastTurnStartedAt: agent.lastTurnStartedAt }),
          ...(agent.lastTurnId === undefined ? {} : { lastTurnId: agent.lastTurnId }),
          ...(agent.evaluation === undefined ? {} : { evaluation: agent.evaluation }),
        })),
        roles: roles.map((role) => ({
          roleId: role.roleId,
          name: role.name,
          harness: role.harness,
          keepAliveAfterTask: role.keepAliveAfterTask,
        })),
      })
    })

    route('/conversation', async (req, res) => {
      requireMethod(req, 'GET')
      const url = requestUrl(req)
      const agentId = requiredQuery(url, 'agentId')
      const after = url.searchParams.get('after') ?? undefined
      const page = await manager.readConversation({
        agentId,
        after,
        // Activity heartbeats and provider retries are not shown as messages;
        // the window reads them to say "thinking" / "provider retrying".
        kinds: ['message', 'tool_call', 'tool_result', 'error', 'agent.activity', 'agent.provider_retry'],
        limit: 100,
      })
      sendJson(res, 200, {
        items: page.items.map((item) => ({
          seq: item.seq,
          timestamp: item.timestamp,
          kind: item.kind,
          role: item.role,
          payload: item.payload,
        })),
        cursor: page.items.length === 0
          ? after ?? null
          : String(page.items[page.items.length - 1]!.seq),
        nextCursor: page.nextCursor ?? null,
      })
    })

    route('/chat', async (req, res) => {
      requireMethod(req, 'POST')
      const body = await readJson(req)
      const agentId = requiredString(body.agentId, 'agentId')
      const text = requiredString(body.text, 'text').trim()
      if (text === '') throw new WebInputError('text must not be empty')
      if (text.length > 20_000) throw new WebInputError('text exceeds 20,000 characters')
      // An agentId this process does not own is forwarded by
      // AgentManager itself over its owner's control socket. The one exception
      // is an evaluation arm, which is observe-only.
      await refuseEvaluationArm(manager, agentId)
      const reply = await manager.sendChat(agentId, text)
      sendJson(res, 200, {
        text: reply.text,
        durationMs: reply.durationMs,
        model: reply.model ?? null,
        stopReason: reply.stopReason ?? null,
      })
    })

    route('/close', async (req, res) => {
      requireMethod(req, 'POST')
      const body = await readJson(req)
      const agentId = requiredString(body.agentId, 'agentId')
      await refuseEvaluationArm(manager, agentId)
      await manager.close(agentId)
      sendJson(res, 200, { closed: true })
    })
  }

  register()
  ctx.on('internal/service', (name) => {
    if ((WEB_SERVER_KEYS as readonly string[]).includes(String(name))) register()
  })
}

class WebInputError extends Error {}

/** A request that did not come from the DSH page (HTTP 403). */
class WebForbiddenError extends Error {}

/**
 * Only the DSH page may use these routes: they send instructions to coding
 * agents, terminate them, and read their conversations. DSH's web server hands
 * a plugin route the raw request and checks nothing, so every route checks
 * for itself that the request is not coming from some other web site the user
 * has open in a browser:
 *
 * - `Host` must be `localhost`, an IP address, or one of `trustedHosts` (the
 *   names a DSH served with `--trusted-host` answers to). A DNS-rebinding
 *   page reaches 127.0.0.1 under its own domain name, so its requests name
 *   that domain.
 * - A browser request another site started is refused: `Sec-Fetch-Site` says
 *   so, or `Origin` names a different host than the one asked.
 * - A body must be declared `application/json`. A browser sends that type to
 *   another site only after a CORS preflight these routes never grant, so a
 *   form or `text/plain` post from another site is refused here.
 *
 * Both DSH pages pass: the web profile's same-origin requests carry its own
 * origin, and the desktop app forwards the page's requests from the main
 * process to 127.0.0.1 with `Origin` and `Sec-Fetch-Site` removed (after
 * refusing any whose origin is not its own page). Local tools such as curl
 * send neither header and pass; they run as the user already. This is the
 * same fence DSH puts in front of its own `/api` (dsh-client-connection),
 * slightly stricter: a `same-site` request is refused too.
 */
function assertPageRequest(req: IncomingMessage, trustedHosts: readonly string[]): void {
  const host = singleHeader(req, 'host')
  const hostname = host === undefined ? undefined : hostnameOf(host)
  if (host === undefined || hostname === undefined || !(isLocalHostname(hostname) || isTrustedHost(host, trustedHosts))) {
    throw new WebForbiddenError(`refused: host ${host ?? '(none)'} is not this machine`)
  }
  const site = singleHeader(req, 'sec-fetch-site')
  if (site === 'cross-site' || site === 'same-site') {
    throw new WebForbiddenError('refused: request started by another site')
  }
  const origin = singleHeader(req, 'origin')
  if (origin !== undefined && originHost(origin) !== new URL(`http://${host}`).host) {
    throw new WebForbiddenError(`refused: request from ${origin}`)
  }
  if (req.method === 'POST' && contentType(req) !== 'application/json') {
    throw new WebForbiddenError('refused: body must be sent as application/json')
  }
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  const first = Array.isArray(value) ? value[0] : value
  return first === undefined || first.trim() === '' ? undefined : first.trim()
}

function hostnameOf(host: string): string | undefined {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

function isLocalHostname(hostname: string): boolean {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  return bare === 'localhost' || bare.endsWith('.localhost') || isIP(bare) !== 0
}

/**
 * Does `host` match a `trustedHosts` entry? As in DSH: an entry with a port
 * matches that exact `host:port`, an entry without one matches any port.
 */
function isTrustedHost(host: string, trustedHosts: readonly string[]): boolean {
  let asked: URL
  try {
    asked = new URL(`http://${host}`)
  } catch {
    return false
  }
  return trustedHosts.some((entry) => {
    try {
      const trusted = new URL(`http://${entry}`)
      return /:\d+$/.test(entry) ? trusted.host === asked.host : trusted.hostname === asked.hostname
    } catch {
      return false
    }
  })
}

/** `host[:port]` of an `Origin` header; undefined for `null` and anything unparsable. */
function originHost(origin: string): string | undefined {
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.host : undefined
  } catch {
    return undefined
  }
}

function contentType(req: IncomingMessage): string | undefined {
  return singleHeader(req, 'content-type')?.split(';')[0]?.trim().toLowerCase()
}

function requireMethod(req: IncomingMessage, method: string): void {
  if (req.method !== method) throw new WebInputError(`expected ${method}`)
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://dsh.local')
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name)?.trim()
  if (value === undefined || value === '') throw new WebInputError(`${name} is required`)
  return value
}

function optionalQuery(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim()
  return value === undefined || value === '' ? undefined : value
}

/**
 * Canonical (symlink-resolved) form of a directory path, so a Workspace path
 * the Host reports through `realpath` still matches an agent cwd that was only
 * `path.resolve`d at spawn time (macOS `/var` vs `/private/var`, for example).
 * A directory that no longer exists falls back to its resolved spelling.
 */
const canonicalCache = new Map<string, string>()
const CANONICAL_CACHE_LIMIT = 256

async function canonicalDirectory(directory: string): Promise<string> {
  const resolved = path.resolve(directory)
  const cached = canonicalCache.get(resolved)
  if (cached !== undefined) return cached
  let canonical: string
  try {
    canonical = await realpath(resolved)
  } catch {
    canonical = resolved
  }
  if (canonicalCache.size >= CANONICAL_CACHE_LIMIT) canonicalCache.clear()
  canonicalCache.set(resolved, canonical)
  return canonical
}

/** True when `candidate` is `project` itself or a directory underneath it. */
export function isInsideProject(candidate: string, project: string): boolean {
  if (candidate === project) return true
  const root = project.endsWith(path.sep) ? project : `${project}${path.sep}`
  return candidate.startsWith(root)
}

async function filterAgentsByProject<T extends { cwd: string; evaluation?: { workspace: string } }>(
  agents: readonly T[],
  project: string | undefined,
): Promise<T[]> {
  if (project === undefined) return [...agents]
  const kept: T[] = []
  for (const agent of agents) {
    // An evaluation arm runs in a temporary worktree outside every workspace;
    // it belongs to the project the comparison is about.
    const home = agent.evaluation?.workspace ?? agent.cwd
    if (isInsideProject(await canonicalDirectory(home), project)) kept.push(agent)
  }
  return kept
}

/**
 * Refuse to drive an evaluation arm from a page. The arm's owner refuses too
 * (its control socket rejects forwarded requests); checking here gives a clear
 * error without a round trip and covers an owner too old to know the rule.
 */
async function refuseEvaluationArm(manager: AgentManager, agentId: string): Promise<void> {
  const agent = (await manager.discover()).find((candidate) => candidate.agentId === agentId)
  if (agent?.evaluation !== undefined) {
    throw new AgentObserveOnlyError(agentId, `it is arm "${agent.evaluation.arm}" of comparison ${agent.evaluation.comparisonId}`)
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new WebInputError('request body is too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new WebInputError('request body must be valid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WebInputError('request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new WebInputError(`${name} must be a string`)
  return value
}

function sendError(res: ServerResponse, error: unknown): void {
  // Checking `.code` rather than `instanceof` also maps a forwarded failure
  // correctly: behavior forwarding reconstructs the owner's error as
  // `RemoteAgentError`, which carries the original `code` but is never
  // `instanceof` the original class (see control/client.ts).
  const code = error instanceof AgentManagerError ? error.code : undefined
  const status = code === 'agent-not-found'
    ? 404
    : code === 'agent-owner-unreachable' || code === 'agent-forward-failed'
      ? 502
      : code === 'observe-only'
        ? 409
        : error instanceof WebInputError
          ? 400
          : error instanceof WebForbiddenError
            ? 403
            : 500
  sendJson(res, status, {
    error: error instanceof Error ? error.message : String(error),
  })
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}
