import { access, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type {
  AgentExecutionHandle,
  AgentExecutionRequest,
  AgentExecutor,
  AttemptWorkspace,
  CaptureWorkspaceResult,
  CreateAttemptWorkspace,
  WorkspaceDriver,
  WorkspaceResult,
} from '@dsh/core'
import { GitCli } from '@dsh/workspace-git'


/**
 * Whether the project's own harness instructions are in the worktree while
 * the role works.
 *
 * - `keep` (default): what everyday use looks like. The comparison measures
 *   role + project instructions together.
 * - `hide`: the instructions are moved out for the agent's turn, so the
 *   comparison measures the role alone — e.g. to check that a role meant to
 *   be generic does not quietly depend on one project's CLAUDE.md.
 */
export type HarnessContextMode = 'keep' | 'hide'

/**
 * Files a harness loads into the model's context on its own, at any depth:
 * Claude Code's `CLAUDE.md` / `CLAUDE.local.md`, codex's `AGENTS.md` /
 * `AGENTS.override.md`.
 */
export const HARNESS_INSTRUCTION_FILES: readonly string[] = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md']
/**
 * Directories whose content Claude Code surfaces to the model unprompted
 * (project skills, subagents, slash commands). `.claude/settings*.json` is
 * deliberately not hidden: it holds permissions and hooks — how tools
 * behave, not what the model knows.
 */
export const HARNESS_CONTEXT_DIRS: readonly string[] = ['.claude/skills', '.claude/agents', '.claude/commands']

/** What {@link HarnessContextHider} did to one worktree. */
export interface HiddenContextReport {
  /** Worktree-relative paths moved out for the agent's turn. */
  hidden: string[]
  /** Hidden paths the agent recreated during its turn; its version was kept. */
  keptAgentVersion?: string[]
}

interface Stash {
  dir: string
  paths: string[]
  restored?: HiddenContextReport
}

/**
 * Moves a worktree's harness context out before the agent starts and back
 * before anything looks at the result.
 *
 * Only tracked files are considered (the base commit's own instructions).
 * They are also marked `skip-worktree` while away, so `git status` in the
 * worktree stays clean — a list of deleted instruction files would be a
 * louder hint than the files themselves. This removes *automatic* loading;
 * an agent that runs `git show HEAD:CLAUDE.md` still reads it, deliberately.
 * User-level files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`) live
 * outside the worktree and are not affected.
 */
export class HarnessContextHider {
  private readonly cli: GitCli
  private readonly stashes = new Map<string, Stash>()

  constructor(options: { gitPath?: string } = {}) {
    this.cli = new GitCli({ gitPath: options.gitPath ?? 'git', timeoutMs: 60_000 })
  }

  async hide(worktree: string): Promise<string[]> {
    const tracked = (await this.cli.exec(['ls-files', '-z'], worktree)).stdout.split('\0').filter((entry) => entry !== '')
    const paths = tracked.filter(isHarnessContext).sort()
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-hidden-context-'))
    this.stashes.set(worktree, { dir, paths })
    if (paths.length === 0) return []
    await this.cli.exec(['update-index', '--skip-worktree', '--', ...paths], worktree)
    for (const relative of paths) {
      const target = path.join(dir, relative)
      await mkdir(path.dirname(target), { recursive: true })
      await rename(path.join(worktree, relative), target)
    }
    return [...paths]
  }

  /** Put everything back. Idempotent; a worktree that was never hidden reports nothing. */
  async restore(worktree: string): Promise<HiddenContextReport | undefined> {
    const stash = this.stashes.get(worktree)
    if (stash === undefined) return undefined
    if (stash.restored !== undefined) return stash.restored
    const kept: string[] = []
    for (const relative of stash.paths) {
      const original = path.join(worktree, relative)
      if (await exists(original)) {
        kept.push(relative)
        continue
      }
      await mkdir(path.dirname(original), { recursive: true })
      await rename(path.join(stash.dir, relative), original)
    }
    if (stash.paths.length > 0) {
      await this.cli.exec(['update-index', '--no-skip-worktree', '--', ...stash.paths], worktree).catch(() => undefined)
    }
    await rm(stash.dir, { recursive: true, force: true })
    stash.restored = { hidden: [...stash.paths], ...(kept.length === 0 ? {} : { keptAgentVersion: kept }) }
    return stash.restored
  }
}

function isHarnessContext(relative: string): boolean {
  if (HARNESS_INSTRUCTION_FILES.includes(path.posix.basename(relative))) return true
  return HARNESS_CONTEXT_DIRS.some((dir) => relative.startsWith(`${dir}/`))
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false)
}

/**
 * Hides the context right after the inner driver (and any setup) prepared
 * the worktree, and makes sure it is back before the candidate is captured
 * or the worktree removed — so the candidate's diff never shows the files
 * as deleted.
 */
export class ContextHidingWorkspaceDriver implements WorkspaceDriver {
  private readonly worktrees = new Map<string, string>()

  constructor(private readonly inner: WorkspaceDriver, private readonly hider: HarnessContextHider) {
    if (inner.inspectRepository !== undefined) this.inspectRepository = (root) => inner.inspectRepository!(root)
    if (inner.mergeResult !== undefined) this.mergeResult = (request) => inner.mergeResult!(request)
    if (inner.captureResult !== undefined) {
      this.captureResult = async (request: CaptureWorkspaceResult): Promise<WorkspaceResult> => {
        await this.restoreFor(request.workspaceId)
        return inner.captureResult!(request)
      }
    }
    if (inner.removeAttempt !== undefined) {
      this.removeAttempt = async (workspaceId: string): Promise<void> => {
        await this.restoreFor(workspaceId).catch(() => undefined)
        await inner.removeAttempt!(workspaceId)
      }
    }
  }

  inspectRepository?: WorkspaceDriver['inspectRepository']
  captureResult?: WorkspaceDriver['captureResult']
  mergeResult?: WorkspaceDriver['mergeResult']
  removeAttempt?: WorkspaceDriver['removeAttempt']

  async createAttempt(request: CreateAttemptWorkspace): Promise<AttemptWorkspace> {
    const workspace = await this.inner.createAttempt(request)
    if (workspace.worktreePath !== undefined) {
      this.worktrees.set(workspace.workspaceId, workspace.worktreePath)
      await this.hider.hide(workspace.worktreePath)
    }
    return workspace
  }

  private async restoreFor(workspaceId: string): Promise<void> {
    const worktree = this.worktrees.get(workspaceId)
    if (worktree !== undefined) await this.hider.restore(worktree)
  }
}

/**
 * Restores the context the moment the agent's turn ends, before the
 * Scheduler runs the visible checks: the checks judge the worktree as it
 * will be captured, instructions included.
 */
export class ContextRestoringExecutor implements AgentExecutor {
  constructor(private readonly inner: AgentExecutor, private readonly hider: HarnessContextHider) {}

  async start(request: AgentExecutionRequest): Promise<AgentExecutionHandle> {
    const handle = await this.inner.start(request)
    const worktree = request.worktreePath
    return {
      wait: async () => {
        try {
          return await handle.wait()
        } finally {
          if (worktree !== undefined) await this.hider.restore(worktree)
        }
      },
      ...(handle.cancel === undefined ? {} : { cancel: () => handle.cancel!() }),
      ...(handle.dispose === undefined ? {} : { dispose: () => handle.dispose!() }),
    }
  }
}
