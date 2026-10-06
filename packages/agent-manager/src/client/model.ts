/** JSON-facing lifecycle view returned by the Agent Manager web API. */
export interface AgentView {
  agentId: string
  roleId: string
  harness: string
  harnessSessionId: string
  /** Absolute working directory the child runs in (the project it belongs to). */
  cwd: string
  keepAliveAfterTask: boolean
  interactionMode: 'headless' | 'interactive'
  showWindow: boolean
  windowHandle: string | null
  status: string
  /** True when another process on this machine owns the channel (read-only here). */
  external: boolean
  /** Pid of the owning process. */
  ownerPid: number
  lastTurnStartedAt?: number
  lastTurnId?: string
  /**
   * Present when the agent is one arm of a running role comparison. Such an
   * agent is listed in its own "评估中" group and is observe-only: the
   * server refuses chat and close for it.
   */
  evaluation?: {
    comparisonId: string
    taskId: string
    /** Arm label, e.g. `baseline` / `candidate`. */
    arm: string
    /** The project the comparison is about (the arm's own cwd is a temp worktree). */
    workspace: string
  }
}

/** Ordinary agents and evaluation arms, each in the order the server listed them. */
export interface PartitionedAgents {
  agents: AgentView[]
  evaluating: AgentView[]
}

/** Split a list into ordinary agents and running-comparison arms ("评估中"). */
export function partitionEvaluationAgents(agents: readonly AgentView[]): PartitionedAgents {
  const partitioned: PartitionedAgents = { agents: [], evaluating: [] }
  for (const agent of agents) (agent.evaluation === undefined ? partitioned.agents : partitioned.evaluating).push(agent)
  return partitioned
}

/** Row label for an evaluation arm: which arm, of which task. */
export function evaluationLabel(agent: Pick<AgentView, 'evaluation'>): string | undefined {
  if (agent.evaluation === undefined) return undefined
  return `${agent.evaluation.arm} · ${agent.evaluation.taskId}`
}

/** JSON-facing summary of a role available for spawning. */
export interface RoleView {
  roleId: string
  name: string
  harness: string
  keepAliveAfterTask: boolean
}

/**
 * The slice of DSH's `useSessions` snapshot the dock reads. Declared
 * structurally so the client bundle stays free of `@deepseek-ai/*` type
 * dependencies. DSH 0.1 names the shown session in `current`; DSH 0.2
 * dropped that field — there the shown session is the one the main view
 * retains (`retainedBy.mainView > 0`), which is how DSH's own layout and
 * "open in app" find it.
 */
export interface SessionListLike {
  current?: string | undefined
  byId: Readonly<Record<string, {
    cwd?: string | undefined
    retainedBy?: { mainView?: number | undefined } | undefined
    updatedAt?: number | undefined
  } | undefined>>
}

/**
 * The slice of DSH's `useWorkspaces` snapshot the dock reads. DSH 0.1 keeps
 * `recentWorkspaceId` (the key is always there, possibly undefined); DSH 0.2
 * dropped it and picks the recent Workspace from its Sessions' activity.
 */
export interface WorkspaceListLike {
  items: readonly {
    workspaceId: string
    path: string
    sessionIds?: readonly string[] | undefined
    createdAt?: string | undefined
  }[]
  recentWorkspaceId?: string | undefined
}

/** Working directory of the session the page is currently showing. */
export function currentSessionCwd(state: SessionListLike): string | undefined {
  const id = 'current' in state
    ? state.current
    : Object.entries(state.byId).find(([, session]) => (session?.retainedBy?.mainView ?? 0) > 0)?.[0]
  if (id === undefined) return undefined
  const cwd = state.byId[id]?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined
}

/**
 * Path of the most recently active Workspace, used while no session is open.
 * Under DSH 0.2 this is DSH's own rule (dsh-client-ui-workspace
 * `recentWorkspace`): the Workspace whose newest Session changed last, a
 * Workspace without Sessions counting from its creation; ties keep DSH's
 * Workspace order. That needs the Sessions, hence `sessions`.
 */
export function recentWorkspacePath(state: WorkspaceListLike, sessions: SessionListLike['byId'] = {}): string | undefined {
  let workspace: WorkspaceListLike['items'][number] | undefined
  if ('recentWorkspaceId' in state) {
    if (state.recentWorkspaceId === undefined) return undefined
    workspace = state.items.find((item) => item.workspaceId === state.recentWorkspaceId)
  } else {
    let latestSeen = Number.NEGATIVE_INFINITY
    for (const item of state.items) {
      let latest = Number.NEGATIVE_INFINITY
      for (const sessionId of item.sessionIds ?? []) {
        const updatedAt = sessions[sessionId]?.updatedAt
        if (typeof updatedAt === 'number') latest = Math.max(latest, updatedAt)
      }
      if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(item.createdAt ?? '')
      if (Number.isNaN(latest)) latest = Number.NEGATIVE_INFINITY
      if (workspace === undefined || latest > latestSeen) {
        workspace = item
        latestSeen = latest
      }
    }
  }
  return workspace !== undefined && workspace.path.trim() !== '' ? workspace.path : undefined
}

/**
 * Directory the dock binds to. The open session wins because it is what the
 * user is looking at; the recent Workspace covers the no-session shell state.
 * `undefined` means "no project" and the dock falls back to the host default.
 */
export function resolveProjectCwd(
  sessionCwd: string | undefined,
  workspacePath: string | undefined,
): string | undefined {
  return sessionCwd ?? workspacePath
}

/** Short label for a project directory: its last path segment. */
export function projectTitle(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  const segments = cwd.split(/[\\/]+/).filter((segment) => segment !== '')
  return segments[segments.length - 1] ?? cwd
}

/** Viewport-relative position and size for one floating Agent window. */
export interface WindowGeometry {
  left: number
  top: number
  width: number
  height: number
}

/** Direction of a resize handle on a floating Agent window. */
export type ResizeDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

const WINDOW_MARGIN = 16
const WINDOW_GAP = 12
const WINDOW_MIN_WIDTH = 220
const WINDOW_MIN_HEIGHT = 120
const WINDOW_MAX_WIDTH = 640
const WINDOW_MAX_HEIGHT = 760
const WINDOW_DEFAULT_MAX_WIDTH = 360
const WINDOW_DEFAULT_MAX_HEIGHT = 520

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

/** Keep a floating window inside the current viewport after a drag or resize. */
export function clampWindowGeometry(
  geometry: WindowGeometry,
  viewportWidth: number,
  viewportHeight: number,
): WindowGeometry {
  const safeViewportWidth = Math.max(1, finiteOr(viewportWidth, 1))
  const safeViewportHeight = Math.max(1, finiteOr(viewportHeight, 1))
  const widthLimit = Math.max(1, safeViewportWidth - WINDOW_MARGIN * 2)
  const heightLimit = Math.max(1, safeViewportHeight - WINDOW_MARGIN * 2)
  const width = Math.min(
    widthLimit,
    Math.max(WINDOW_MIN_WIDTH, Math.min(WINDOW_MAX_WIDTH, finiteOr(geometry.width, WINDOW_MAX_WIDTH))),
  )
  const height = Math.min(
    heightLimit,
    Math.max(WINDOW_MIN_HEIGHT, Math.min(WINDOW_MAX_HEIGHT, finiteOr(geometry.height, WINDOW_MAX_HEIGHT))),
  )
  const leftMaximum = Math.max(0, safeViewportWidth - width)
  const topMaximum = Math.max(0, safeViewportHeight - height)
  return {
    left: clamp(finiteOr(geometry.left, leftMaximum), 0, leftMaximum),
    top: clamp(finiteOr(geometry.top, topMaximum), 0, topMaximum),
    width,
    height,
  }
}

/**
 * Resize a floating window from one of its eight edges/corners while keeping
 * the opposite edge anchored and the result inside the viewport.
 */
export function resizeWindowGeometry(
  geometry: WindowGeometry,
  direction: ResizeDirection,
  deltaX: number,
  deltaY: number,
  viewportWidth: number,
  viewportHeight: number,
): WindowGeometry {
  const base = clampWindowGeometry(geometry, viewportWidth, viewportHeight)
  const horizontal = direction.includes('e') ? 1 : direction.includes('w') ? -1 : 0
  const vertical = direction.includes('s') ? 1 : direction.includes('n') ? -1 : 0
  const nextWidth = base.width + (horizontal === 1 ? deltaX : horizontal === -1 ? -deltaX : 0)
  const nextHeight = base.height + (vertical === 1 ? deltaY : vertical === -1 ? -deltaY : 0)
  const right = base.left + base.width
  const bottom = base.top + base.height
  const resized = {
    left: horizontal === -1 ? right - nextWidth : base.left,
    top: vertical === -1 ? bottom - nextHeight : base.top,
    width: nextWidth,
    height: nextHeight,
  }
  return clampWindowGeometry(resized, viewportWidth, viewportHeight)
}

/** Choose a bounded, initially tiled position for a newly expanded Agent window. */
export function defaultWindowGeometry(
  index: number,
  total: number,
  viewportWidth: number,
  viewportHeight: number,
): WindowGeometry {
  const safeViewportWidth = Math.max(1, finiteOr(viewportWidth, 1))
  const safeViewportHeight = Math.max(1, finiteOr(viewportHeight, 1))
  const availableWidth = Math.max(1, safeViewportWidth - WINDOW_MARGIN * 2)
  const availableHeight = Math.max(1, safeViewportHeight - WINDOW_MARGIN * 2)
  const count = Math.max(1, Math.floor(finiteOr(total, 1)))
  const columns = Math.max(1, Math.min(
    count,
    Math.floor((availableWidth + WINDOW_GAP) / (WINDOW_MIN_WIDTH + WINDOW_GAP)),
  ))
  const rows = Math.max(1, Math.ceil(count / columns))
  const width = Math.min(
    WINDOW_DEFAULT_MAX_WIDTH,
    Math.max(WINDOW_MIN_WIDTH, (availableWidth - WINDOW_GAP * (columns - 1)) / columns),
  )
  const height = Math.min(
    WINDOW_DEFAULT_MAX_HEIGHT,
    Math.max(WINDOW_MIN_HEIGHT, (availableHeight - WINDOW_GAP * (rows - 1)) / rows),
  )
  const safeIndex = Math.max(0, Math.floor(finiteOr(index, 0)))
  const column = safeIndex % columns
  const row = Math.floor(safeIndex / columns)
  return clampWindowGeometry({
    left: safeViewportWidth - WINDOW_MARGIN - width - column * (width + WINDOW_GAP),
    top: safeViewportHeight - WINDOW_MARGIN - height - row * (height + WINDOW_GAP),
    width,
    height,
  }, safeViewportWidth, safeViewportHeight)
}

/**
 * Compare a send request with the latest draft epoch before restoring text.
 * The closed flag is owned by the parent so remounted windows cannot bypass
 * the process lifecycle guard held by an older component instance.
 */
export function canRestoreDraft(currentEpoch: number, requestEpoch: number, closed: boolean): boolean {
  return !closed && currentEpoch === requestEpoch
}

/**
 * Whether an agent should be represented by the web window surface.
 *
 * Only lifecycle status matters here. `showWindow` / `interactionMode` govern
 * whether the *native* TUI window is launched for the process; the web dock is
 * its own observation surface and must also list headless agents spawned by
 * the Scheduler through `AgentManagerExecutor`, which never request a window.
 */
export function isActiveWindowAgent(agent: Pick<AgentView, 'status'>): boolean {
  return agent.status === 'opening' || agent.status === 'open'
}

/**
 * Filter the manager state to agents that can currently be opened in the UI.
 * Keep this predicate strict so closing, exited and failed processes disappear
 * from both the minimized list and expanded window stack.
 */
export function activeWindowAgents(agents: readonly AgentView[]): AgentView[] {
  return agents.filter(isActiveWindowAgent)
}

/** The two halves of an agent's display name: role first, harness as a secondary detail. */
export interface AgentLabelParts {
  /** Role display name, falling back to the role id. */
  role: string
  /** Harness id (`codex`, `claude-code`, …). */
  harness: string
}

/** Resolve the display-name parts shared by a row and its floating window. */
export function agentLabelParts(agent: Pick<AgentView, 'harness' | 'roleId'>, roles: readonly RoleView[] = []): AgentLabelParts {
  const role = roles.find((candidate) => candidate.roleId === agent.roleId)
  const roleName = typeof role?.name === 'string' ? role.name.trim() || agent.roleId : agent.roleId
  return { role: roleName, harness: agent.harness }
}

/** Plain-text form of {@link agentLabelParts} for tooltips and accessible names. */
export function agentLabel(agent: Pick<AgentView, 'harness' | 'roleId'>, roles: readonly RoleView[] = []): string {
  const parts = agentLabelParts(agent, roles)
  return `${parts.role} · ${parts.harness}`
}

/** Alias with an explicit name for consumers that prefer getter-style helpers. */
export const getAgentLabel = agentLabel

/** Remove expanded ids that are no longer active window agents. */
export function reconcileExpandedIds(expandedIds: Iterable<string>, agents: readonly AgentView[]): Set<string> {
  const activeIds = new Set(activeWindowAgents(agents).map((agent) => agent.agentId))
  return new Set([...expandedIds].filter((agentId) => activeIds.has(agentId)))
}

/** Return active agents that are still minimized in the dock popover. */
export function minimizedWindowAgents(agents: readonly AgentView[], expandedIds: Iterable<string>): AgentView[] {
  const expanded = new Set(expandedIds)
  return activeWindowAgents(agents).filter((agent) => !expanded.has(agent.agentId))
}
