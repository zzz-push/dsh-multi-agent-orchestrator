import { describe, expect, it } from 'vitest'
import {
  activeWindowAgents,
  agentLabel,
  agentLabelParts,
  canRestoreDraft,
  clampWindowGeometry,
  currentSessionCwd,
  defaultWindowGeometry,
  evaluationLabel,
  isActiveWindowAgent,
  partitionEvaluationAgents,
  minimizedWindowAgents,
  projectTitle,
  recentWorkspacePath,
  reconcileExpandedIds,
  resizeWindowGeometry,
  resolveProjectCwd,
  type AgentView,
  type RoleView,
  type WindowGeometry,
} from '../src/client/model.js'

function agent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    agentId: 'agent-1',
    roleId: 'worker',
    harness: 'codex',
    harnessSessionId: 'thread-1',
    cwd: '/projects/demo',
    keepAliveAfterTask: true,
    interactionMode: 'interactive',
    showWindow: false,
    windowHandle: null,
    status: 'open',
    external: false,
    ownerPid: 4242,
    ...overrides,
  }
}

describe('evaluation arms ("评估中")', () => {
  const arm = (id: string, label: string): AgentView => agent({
    agentId: id,
    external: true,
    evaluation: { comparisonId: 'cmp-1', taskId: 'example-task-role-hash', arm: label, workspace: '/projects/demo' },
  })

  it('splits evaluation arms from ordinary agents, keeping server order within each group', () => {
    const list = [arm('a1', 'baseline'), agent({ agentId: 'w1' }), arm('a2', 'candidate'), agent({ agentId: 'w2' })]
    const { agents, evaluating } = partitionEvaluationAgents(list)
    expect(agents.map((entry) => entry.agentId)).toEqual(['w1', 'w2'])
    expect(evaluating.map((entry) => entry.agentId)).toEqual(['a1', 'a2'])
    expect(partitionEvaluationAgents([])).toEqual({ agents: [], evaluating: [] })
  })

  it('labels an arm by which side it is and which task it runs', () => {
    expect(evaluationLabel(arm('a1', 'candidate'))).toBe('candidate · example-task-role-hash')
    expect(evaluationLabel(agent())).toBeUndefined()
  })
})

describe('agent window model', () => {
  it('clamps floating window geometry to the viewport and dimension limits', () => {
    const geometry: WindowGeometry = clampWindowGeometry(
      { left: -80, top: 900, width: 999, height: 999 },
      800,
      600,
    )

    expect(geometry).toEqual({ left: 0, top: 32, width: 640, height: 568 })
    expect(clampWindowGeometry({ left: 0, top: 0, width: 400, height: 500 }, 250, 180)).toEqual({
      left: 0,
      top: 0,
      width: 218,
      height: 148,
    })
  })

  it('tiles initial windows without letting them escape the viewport', () => {
    const windows = [0, 1, 2, 3].map((index) => defaultWindowGeometry(index, 4, 1440, 900))

    expect(windows.every((window) => window.left >= 0 && window.top >= 0)).toBe(true)
    expect(windows.every((window) => window.left + window.width <= 1440 && window.top + window.height <= 900)).toBe(true)
    expect(new Set(windows.map((window) => `${window.left}:${window.top}`)).size).toBe(4)
    expect(defaultWindowGeometry(0, 1, 390, 844).width).toBe(358)
  })

  it('resizes from every edge while keeping the opposite edge anchored', () => {
    const base = { left: 300, top: 200, width: 320, height: 280 }
    expect(resizeWindowGeometry(base, 'se', 40, 30, 1000, 800)).toEqual({
      left: 300, top: 200, width: 360, height: 310,
    })
    expect(resizeWindowGeometry(base, 'nw', -40, -30, 1000, 800)).toEqual({
      left: 260, top: 170, width: 360, height: 310,
    })
    expect(resizeWindowGeometry(base, 'w', 80, 0, 1000, 800)).toEqual({
      left: 380, top: 200, width: 240, height: 280,
    })
    expect(resizeWindowGeometry(base, 'n', 0, 100, 1000, 800)).toEqual({
      left: 300, top: 300, width: 320, height: 180,
    })
  })

  it('allows draft recovery only for the current open epoch', () => {
    expect(canRestoreDraft(4, 4, false)).toBe(true)
    expect(canRestoreDraft(5, 4, false)).toBe(false)
    expect(canRestoreDraft(4, 4, true)).toBe(false)
  })

  it('keeps every opening/open agent active regardless of window flags', () => {
    const agents = [
      agent({ agentId: 'open', status: 'open' }),
      agent({ agentId: 'opening', status: 'opening' }),
      // Scheduler-spawned workers: headless and never ask for a native window.
      agent({ agentId: 'headless', interactionMode: 'headless', showWindow: false }),
      agent({ agentId: 'closed', status: 'closing' }),
      agent({ agentId: 'exited', status: 'exited' }),
      agent({ agentId: 'failed', status: 'failed' }),
      agent({ agentId: 'hidden', interactionMode: 'headless', showWindow: true }),
    ]

    expect(activeWindowAgents(agents).map(({ agentId }) => agentId)).toEqual(['open', 'opening', 'headless', 'hidden'])
    expect(isActiveWindowAgent(agent({ interactionMode: 'headless', showWindow: true, status: 'open' }))).toBe(true)
    expect(isActiveWindowAgent(agent({ interactionMode: 'headless', showWindow: false, status: 'open' }))).toBe(true)
    expect(isActiveWindowAgent(agent({ interactionMode: 'headless', showWindow: false, status: 'closing' }))).toBe(false)
  })

  it('uses harness and role name, falling back to role id', () => {
    const roles: RoleView[] = [{ roleId: 'worker', name: 'Build Worker', harness: 'codex', keepAliveAfterTask: true }]
    expect(agentLabelParts(agent(), roles)).toEqual({ role: 'Build Worker', harness: 'codex' })
    expect(agentLabel(agent(), roles)).toBe('Build Worker · codex')
    expect(agentLabel(agent({ roleId: 'missing' }), roles)).toBe('missing · codex')
    expect(agentLabel(agent({ roleId: 'blank' }), [{ ...roles[0]!, roleId: 'blank', name: '  ' }])).toBe('blank · codex')
  })

  it('reconciles expanded ids and computes minimized active agents', () => {
    const agents = [
      agent({ agentId: 'one' }),
      agent({ agentId: 'two', status: 'closing' }),
      agent({ agentId: 'three', interactionMode: 'headless', showWindow: true }),
    ]
    const expanded = reconcileExpandedIds(new Set(['one', 'two', 'unknown']), agents)
    expect([...expanded]).toEqual(['one'])
    expect(minimizedWindowAgents(agents, expanded).map(({ agentId }) => agentId)).toEqual(['three'])
  })

  it('binds to the open session cwd, then the recent workspace, then nothing', () => {
    const sessions = {
      current: 's-2',
      byId: {
        's-1': { cwd: '/projects/alpha' },
        's-2': { cwd: '/projects/beta' },
        's-3': { cwd: '   ' },
        's-4': {},
      },
    }
    expect(currentSessionCwd(sessions)).toBe('/projects/beta')
    expect(currentSessionCwd({ ...sessions, current: 's-3' })).toBeUndefined()
    expect(currentSessionCwd({ ...sessions, current: 's-4' })).toBeUndefined()
    expect(currentSessionCwd({ ...sessions, current: 'missing' })).toBeUndefined()
    expect(currentSessionCwd({ ...sessions, current: undefined })).toBeUndefined()

    const workspaces = {
      items: [
        { workspaceId: 'w-1', path: '/projects/alpha' },
        { workspaceId: 'w-2', path: '/projects/gamma' },
      ],
      recentWorkspaceId: 'w-2',
    }
    expect(recentWorkspacePath(workspaces)).toBe('/projects/gamma')
    expect(recentWorkspacePath({ ...workspaces, recentWorkspaceId: 'w-9' })).toBeUndefined()
    expect(recentWorkspacePath({ ...workspaces, recentWorkspaceId: undefined })).toBeUndefined()

    expect(resolveProjectCwd('/projects/beta', '/projects/gamma')).toBe('/projects/beta')
    expect(resolveProjectCwd(undefined, '/projects/gamma')).toBe('/projects/gamma')
    expect(resolveProjectCwd(undefined, undefined)).toBeUndefined()
  })

  it('binds the same way under DSH 0.2, which dropped `current` and `recentWorkspaceId`', () => {
    // Shapes as dsh-web-app 0.2.0-rc.2 (the desktop app) hands them out.
    const sessions = {
      byId: {
        's-1': { cwd: '/projects/alpha', retainedBy: {}, updatedAt: Date.parse('2026-03-05T00:00:00Z') },
        's-2': { cwd: '/projects/beta', retainedBy: { mainView: 1 }, updatedAt: Date.parse('2026-03-01T00:00:00Z') },
        's-3': { cwd: '/projects/gamma', retainedBy: { mainView: 0 }, updatedAt: Date.parse('2026-03-09T00:00:00Z') },
      },
    }
    expect(currentSessionCwd(sessions)).toBe('/projects/beta')
    // Nothing in the main view (a settings panel, a fresh shell): no session.
    expect(currentSessionCwd({ byId: { ...sessions.byId, 's-2': { ...sessions.byId['s-2'], retainedBy: {} } } })).toBeUndefined()

    const workspaces = {
      items: [
        { workspaceId: 'w-1', path: '/projects/alpha', sessionIds: ['s-1'], createdAt: '2026-01-01T00:00:00Z' },
        { workspaceId: 'w-3', path: '/projects/gamma', sessionIds: ['s-3'], createdAt: '2026-01-01T00:00:00Z' },
        { workspaceId: 'w-4', path: '/projects/empty', sessionIds: [], createdAt: '2026-02-01T00:00:00Z' },
      ],
    }
    // The Workspace whose newest Session changed last (DSH's own rule).
    expect(recentWorkspacePath(workspaces, sessions.byId)).toBe('/projects/gamma')
    // Without Session activity, creation time decides.
    expect(recentWorkspacePath(workspaces, {})).toBe('/projects/empty')
    expect(recentWorkspacePath({ items: [] }, sessions.byId)).toBeUndefined()
  })

  it('labels a project by its last path segment', () => {
    expect(projectTitle('/Users/me/workSpace/DSH Multi-Agent Orchestrator')).toBe('DSH Multi-Agent Orchestrator')
    expect(projectTitle('/projects/alpha/')).toBe('alpha')
    expect(projectTitle('C:\\work\\beta')).toBe('beta')
    expect(projectTitle('/')).toBe('/')
    expect(projectTitle(undefined)).toBeUndefined()
  })
})
