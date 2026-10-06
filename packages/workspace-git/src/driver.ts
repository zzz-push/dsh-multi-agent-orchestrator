import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type {
  WorkspaceDriver,
  CreateAttemptWorkspace,
  AttemptWorkspace,
  CaptureWorkspaceResult,
  WorkspaceResult,
  MergeWorkspaceResult,
  MergeResult,
} from '@dsh/core'
import { GitCli } from './git-cli.js'
import { validateRepositoryImpl } from './preflight.js'
import {
  createWorktreeImpl,
  defaultWorktreeRoot,
  removeWorktreeImpl,
  inspectWorktreeImpl,
  registeredGitDir,
} from './worktree-ops.js'
import { WorkflowCheckVerificationDriver } from './command-verification.js'
import { createCommitImpl } from './commit-ops.js'
import { parseWorktreeList } from './parsers.js'
import {
  WorktreeNotFoundError,
  CommitCreationError,
} from './errors.js'
import type {
  CommitResult,
  CreateCommitParams,
  CreateWorktreeParams,
  RepositoryValidation,
  Worktree,
  WorktreeInspection,
} from './types.js'

export interface GitWorkspaceDriverOptions {
  /** Git binary path, defaults to 'git'. */
  gitPath?: string
  /** Command timeout in milliseconds, defaults to 30000. */
  commandTimeoutMs?: number
  /**
   * Where attempt worktrees are created. Absolute: `<root>/<repoKey>/…`,
   * outside the repository. Relative: under git-common-dir (the original
   * layout, which Claude Code refuses to write into — see
   * `defaultWorktreeRoot`). Default: `defaultWorktreeRoot()`.
   */
  worktreeRoot?: string
}

interface WorkspaceContext {
  workspaceId: string
  worktreePath: string
  repoPath: string
  commonDir: string
  /** `<commonDir>/worktrees/<id>`, recorded before anything else ran in the worktree. */
  gitDir?: string
  inputCommit: string
  runId: string
  stepId: string
  attempt: number
}

/**
 * Ref that pins one attempt's candidate commit. `runId`/`stepId` have passed
 * `isSafePathId` (no slashes), and a ref component additionally may not
 * start with `.` or end with `.lock`; both are normalised here rather than
 * rejected so a legal workspace id never fails at the pinning step.
 */
export function candidateRef(runId: string, stepId: string, attempt: number): string {
  const component = (value: string): string => value.replace(/^\./, '_').replace(/\.lock$/, '_lock')
  return `refs/dsh-orchestrator/runs/${component(runId)}/candidates/${component(stepId)}/${attempt}`
}

function isSafePathId(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  )
}

function isSafeIntegrationRef(value: string): boolean {
  return typeof value === 'string' &&
    /^refs\/dsh-orchestrator\/[A-Za-z0-9._/-]+$/.test(value) &&
    !value.includes('/../') &&
    !value.endsWith('/..')
}

function isObjectId(value: string): boolean {
  return typeof value === 'string' && /^[0-9a-f]{40,64}$/.test(value)
}

/**
 * Git worktree implementation of the core WorkspaceDriver port.
 *
 * The class also exposes the lower-level validate/create/inspect/commit
 * methods described by the workspace driver handoff. All Git calls remain
 * argv-based through GitCli; no Cordis or Harness types are imported.
 */
export class GitWorkspaceDriver implements WorkspaceDriver {
  private readonly cli: GitCli
  private readonly worktreeRoot: string
  private readonly workspaces = new Map<string, WorkspaceContext>()
  private readonly commits = new Map<string, WorkspaceContext>()

  constructor(options: GitWorkspaceDriverOptions = {}) {
    this.cli = new GitCli({
      gitPath: options.gitPath ?? 'git',
      timeoutMs: options.commandTimeoutMs ?? 30_000,
    })
    this.worktreeRoot = options.worktreeRoot ?? defaultWorktreeRoot()
  }

  /**
   * Validate repository state and return canonical paths and HEAD.
   * @throws {RepositoryNotFoundError} when the path is not a Git repository.
   * @throws {DirtyWorkingTreeError} when the repository is not clean.
   * @throws {UnsupportedRepositoryError} for unsupported Git states.
   */
  async validateRepository(repoPath: string): Promise<RepositoryValidation> {
    return validateRepositoryImpl(this.cli, repoPath)
  }

  /**
   * Create a detached worktree directly from a base commit.
   * @throws {WorktreePathMismatchError} for unsafe IDs or roots.
   * @throws {WorktreeCreationError} when Git cannot create the worktree.
   */
  async createWorktree(params: CreateWorktreeParams): Promise<Worktree> {
    return createWorktreeImpl(this.cli, this.worktreeRoot, params)
  }

  /**
   * Remove an orchestrator worktree; repeated calls are safe.
   * @throws {WorktreePathMismatchError} when the path cannot be proven safe.
   */
  async removeWorktree(worktreePath: string): Promise<void> {
    await removeWorktreeImpl(this.cli, worktreePath, {
      worktreeRoot: this.worktreeRoot,
      ...this.knownRepoFor(worktreePath),
    })
  }

  /**
   * Inspect a worktree from Git's canonical registry.
   * @throws {WorktreeNotFoundError} when Git has no matching worktree.
   * @throws {WorktreePathMismatchError} when the path is outside the root.
   */
  async inspectWorktree(worktreePath: string): Promise<WorktreeInspection> {
    return inspectWorktreeImpl(this.cli, worktreePath, {
      worktreeRoot: this.worktreeRoot,
      ...this.knownRepoFor(worktreePath),
    })
  }

  /**
   * The repository this driver created `worktreePath` in, when it did. Under
   * an absolute root the worktree path alone cannot say which repository owns
   * it, so operations on paths this driver never created are refused there.
   */
  private knownRepoFor(worktreePath: string): { repoPath?: string } {
    const resolved = path.resolve(worktreePath)
    for (const context of this.workspaces.values()) {
      if (path.resolve(context.worktreePath) === resolved) return { repoPath: context.repoPath }
    }
    return {}
  }

  /**
   * Create an immutable candidate commit from a worktree snapshot.
   * @throws {CommitCreationError} when the snapshot cannot be committed.
   */
  async createCommit(params: CreateCommitParams): Promise<CommitResult> {
    const context = [...this.workspaces.values()].find(
      (value) => value.worktreePath === params.worktreePath,
    )
    const gitDir = params.gitDir ?? context?.gitDir
    const result = await createCommitImpl(this.cli, gitDir === undefined ? params : { ...params, gitDir })
    if (params.preserveWorktree !== true) {
      // The low-level helper preserves the editable tree for repair. The
      // public direct API follows the handoff contract and finalizes the
      // worktree after the immutable candidate has been created.
      const env = gitDir === undefined ? {} : { env: { GIT_DIR: gitDir, GIT_WORK_TREE: params.worktreePath } }
      await this.cli.exec(['-c', 'core.fsmonitor=false', 'reset', '--hard', result.sha], params.worktreePath, env)
      await this.cli.exec(['-c', 'core.fsmonitor=false', 'clean', '-fd', '--', '.'], params.worktreePath, env)
    }
    if (context !== undefined) {
      if (params.preserveWorktree !== true) context.inputCommit = result.sha
      this.commits.set(result.sha, context)
    }
    return result
  }

  /**
   * Inspect repository metadata for the current core port. Extra aliases are
   * retained for callers using the original handoff vocabulary.
   * @throws {RepositoryNotFoundError} when the path is not a Git repository.
   */
  async inspectRepository(root: string): Promise<{
    root: string
    commonDir: string
    gitCommonDir: string
    headCommit: string
    baseCommit: string
  }> {
    const validation = await this.validateRepository(root)
    return {
      root: validation.repoRoot,
      commonDir: validation.commonDir,
      gitCommonDir: validation.commonDir,
      headCommit: validation.headCommit,
      baseCommit: validation.headCommit,
    }
  }

  /**
   * Create an isolated attempt workspace and remember its ID so scheduler
   * cleanup can pass the opaque workspaceId instead of a filesystem path.
   * @throws {WorktreePathMismatchError} when the generated path is unsafe.
   * @throws {WorktreeCreationError} when Git cannot create the worktree.
   */
  async createAttempt(
    request: CreateAttemptWorkspace,
  ): Promise<AttemptWorkspace> {
    const validation = await this.validateRepository(request.repository.root)
    const worktree = await this.createWorktree({
      repoPath: validation.repoRoot,
      runId: request.runId,
      stepId: request.stepId,
      attempt: request.attempt,
      baseCommit: request.inputCommit,
    })
    const workspaceId = `${request.runId}-${request.stepId}-${request.attempt}`
    // Before setup or the agent can rewrite the worktree's `.git` file.
    const gitDir = await registeredGitDir(validation.commonDir, worktree.path).catch(async (error: unknown) => {
      await this.removeWorktree(worktree.path).catch(() => undefined)
      throw error
    })
    if (request.setup !== undefined && request.setup.length > 0) {
      // The workflow's own preparation (dependency install and the like),
      // controller-side and before any agent: a fresh worktree has no
      // node_modules, and an agent's sandbox often cannot create them.
      const prepared = await new WorkflowCheckVerificationDriver().run({
        runId: request.runId,
        stepId: request.stepId,
        attempt: request.attempt,
        workspaceId,
        worktreePath: worktree.path,
        commands: request.setup,
      })
      if (!prepared.passed) {
        await this.removeWorktree(worktree.path).catch(() => undefined)
        const failed = prepared.evidence?.checks?.at(-1)
        throw new Error(`workspace setup failed: ${prepared.failureMessage ?? 'unknown error'}${failed?.outputSummary === undefined ? '' : `\n${failed.outputSummary}`}`)
      }
    }
    this.workspaces.set(workspaceId, {
      workspaceId,
      worktreePath: worktree.path,
      repoPath: validation.repoRoot,
      commonDir: validation.commonDir,
      gitDir,
      inputCommit: request.inputCommit,
      runId: request.runId,
      stepId: request.stepId,
      attempt: request.attempt,
    })
    return {
      workspaceId,
      worktreePath: worktree.path,
      inputCommit: request.inputCommit,
    }
  }

  /**
   * Capture an attempt into a candidate commit. The core port does not carry a
   * message, so the deterministic DSH message includes run/step/attempt IDs.
   * @throws {WorktreeNotFoundError} for an unknown or mismatched workspace.
   * @throws {CommitCreationError} when the snapshot cannot be committed.
   */
  async captureResult(
    request: CaptureWorkspaceResult,
  ): Promise<WorkspaceResult> {
    const context = this.workspaces.get(request.workspaceId)
    if (context === undefined) {
      throw new WorktreeNotFoundError('Unknown workspace', {
        details: { workspaceId: request.workspaceId },
      })
    }
    if (
      request.runId !== context.runId ||
      request.stepId !== context.stepId ||
      request.attempt !== context.attempt
    ) {
      throw new WorktreeNotFoundError('Workspace identity does not match capture request', {
        details: {
          workspaceId: request.workspaceId,
          expected: {
            runId: context.runId,
            stepId: context.stepId,
            attempt: context.attempt,
          },
          actual: request,
        },
      })
    }
    const result = await createCommitImpl(this.cli, {
      worktreePath: context.worktreePath,
      ...(context.gitDir === undefined ? {} : { gitDir: context.gitDir }),
      parentCommit: context.inputCommit,
      runId: request.runId,
      stepId: request.stepId,
      attempt: request.attempt,
      message: [
        `DSH candidate commit: ${request.runId}/${request.stepId}/${request.attempt}`,
        `DSH-Run: ${request.runId}`,
        `DSH-Step: ${request.stepId}`,
        `DSH-Attempt: ${request.attempt}`,
      ].join('\n'),
    })
    this.commits.set(result.sha, context)
    // Pin the candidate under a ref so `git gc` cannot reap it once the
    // worktree is removed (design rationale: the
    // controller "写入 refs/dsh-orchestrator/... 防止对象被回收"). Without
    // this the commit was dangling from the moment `removeAttempt` ran, and
    // any record that cited its sha — a run's `resultCommit`, a role
    // comparison — would point at nothing after the prune window.
    await this.cli.exec(
      ['update-ref', candidateRef(request.runId, request.stepId, request.attempt), result.sha],
      context.repoPath,
    )
    return {
      resultCommit: result.sha,
      changedPaths: result.changedPaths,
      diffHash: result.diffHash,
      evidence: {
        passed: true,
        changedPaths: result.changedPaths,
        diffHash: result.diffHash,
      },
    }
  }

  /**
   * Apply a candidate onto the run's integration line and advance the
   * integration ref with an expected-old CAS update.
   *
   * The candidate may be based on any earlier integration commit of the run,
   * not only the current one: every step of a batch starts from the same
   * baseline, so all but the first to merge find the integration already
   * moved on. Its changes are cherry-picked —
   * a three-way merge against its own parent — onto the current head in the
   * run's integration worktree. Overlapping edits come back as
   * `{ merged: false, conflict }`; nothing is ever resolved by overwriting.
   */
  async mergeResult(request: MergeWorkspaceResult): Promise<MergeResult> {
    const context = this.commits.get(request.resultCommit) ??
      (request.repositoryRoot === undefined ? undefined : await this.contextFromRepository(request))
    if (context === undefined) {
      return {
        merged: false,
        conflict: `Unknown result commit: ${request.resultCommit}`,
      }
    }

    if (
      request.runId !== context.runId ||
      !isSafePathId(request.runId) ||
      !isSafePathId(request.stepId) ||
      !isSafeIntegrationRef(request.integrationRef) ||
      !isObjectId(request.expectedIntegrationCommit)
    ) {
      return { merged: false, conflict: 'Invalid integration identity or ref' }
    }

    // TODO: created on the run's first merge and never removed —
    // every governed run leaves a full checkout here after it ends.
    const integrationPath = path.join(
      context.commonDir,
      'dsh-orchestrator',
      'integration',
      request.runId,
    )
    try {
      const parentLine = await this.cli.execLine(
        ['rev-list', '--parents', '-n', '1', request.resultCommit],
        context.repoPath,
      )
      const candidateParent = parentLine.split(' ')[1]
      if (candidateParent === undefined || !(await this.isAncestor(candidateParent, request.expectedIntegrationCommit, context.repoPath))) {
        return {
          merged: false,
          conflict: 'Candidate is not based on this run\'s integration line',
        }
      }
      const listed = parseWorktreeList(
        (
          await this.cli.exec(
            ['worktree', 'list', '--porcelain', '-z'],
            context.repoPath,
          )
        ).stdout,
      )
      if (!listed.some((entry) => entry.path === integrationPath)) {
        await this.cli.exec(
          ['worktree', 'add', '--detach', integrationPath, request.expectedIntegrationCommit],
          context.repoPath,
        )
      }

      const integrationHead = await this.cli.execLine(['rev-parse', 'HEAD'], integrationPath)
      if (integrationHead !== request.expectedIntegrationCommit) {
        return {
          merged: false,
          conflict: 'Integration worktree changed since the expected commit',
        }
      }

      // Establish the integration ref on first use without overwriting an
      // existing ref. Subsequent updates use Git's expected-old CAS argument.
      try {
        const refHead = await this.cli.execLine(
          ['rev-parse', '--verify', `${request.integrationRef}^{commit}`],
          context.repoPath,
        )
        if (refHead !== request.expectedIntegrationCommit) {
          return {
            merged: false,
            conflict: 'Integration ref changed since the expected commit',
          }
        }
      } catch {
        await this.cli.exec(
          ['update-ref', request.integrationRef, request.expectedIntegrationCommit],
          context.repoPath,
        )
      }

      try {
        await this.cli.exec(
          ['cherry-pick', '--no-commit', request.resultCommit],
          integrationPath,
        )
      } catch (error) {
        await this.cli.exec(['cherry-pick', '--abort'], integrationPath).catch(() => undefined)
        // `--abort` is a no-op when the pick stopped before recording state;
        // make sure no half-applied change survives into the next merge.
        await this.cli.exec(['reset', '--hard', request.expectedIntegrationCommit], integrationPath).catch(() => undefined)
        const stderr = (error as { details?: { stderr?: string } })?.details?.stderr
        return { merged: false, conflict: stderr || 'Merge conflict' }
      }

      const merged = await createCommitImpl(this.cli, {
        worktreePath: integrationPath,
        parentCommit: request.expectedIntegrationCommit,
        message: `DSH integration commit: ${request.runId}/${request.stepId}`,
      })
      await this.cli.exec(
        ['update-ref', request.integrationRef, merged.sha, request.expectedIntegrationCommit],
        context.repoPath,
      )
      await this.cli.exec(['reset', '--hard', merged.sha], integrationPath)
      return {
        merged: true,
        integrationCommit: merged.sha,
        evidence: {
          expectedIntegrationCommit: request.expectedIntegrationCommit,
          resultCommit: request.resultCommit,
          ...(candidateParent === request.expectedIntegrationCommit ? {} : { candidateBase: candidateParent }),
          integrationCommit: merged.sha,
          diffHash: merged.diffHash,
        },
      }
    } catch (error) {
      if (error instanceof CommitCreationError) {
        return { merged: false, conflict: error.message }
      }
      const stderr = (error as { details?: { stderr?: string } })?.details?.stderr
      return { merged: false, conflict: stderr || (error instanceof Error ? error.message : 'Merge failed') }
    }
  }

  /**
   * Rebuild what `captureResult` would have remembered, for a candidate this
   * driver instance did not capture (another process, or before a restart).
   * The candidate must exist in the repository; nothing else is trusted from
   * the request beyond what the merge checks anyway.
   */
  private async contextFromRepository(request: MergeWorkspaceResult): Promise<WorkspaceContext | undefined> {
    const root = request.repositoryRoot
    if (root === undefined || !isObjectId(request.resultCommit)) return undefined
    try {
      await this.cli.exec(['cat-file', '-e', `${request.resultCommit}^{commit}`], root)
      const repoPath = await this.cli.execLine(['rev-parse', '--show-toplevel'], root)
      const commonDirRaw = await this.cli.execLine(['rev-parse', '--path-format=absolute', '--git-common-dir'], root)
      return {
        workspaceId: '',
        worktreePath: '',
        repoPath,
        commonDir: await realpath(path.resolve(repoPath, commonDirRaw)),
        inputCommit: '',
        runId: request.runId,
        stepId: request.stepId,
        attempt: 0,
      }
    } catch {
      return undefined
    }
  }

  private async isAncestor(ancestor: string, descendant: string, repoPath: string): Promise<boolean> {
    if (ancestor === descendant) return true
    try {
      await this.cli.exec(['merge-base', '--is-ancestor', ancestor, descendant], repoPath)
      return true
    } catch {
      return false
    }
  }

  /**
   * Remove by opaque workspace ID (scheduler) or by a direct path (API users).
   * @throws {WorktreePathMismatchError} when the target cannot be proven safe.
   */
  async removeAttempt(workspaceId: string): Promise<void> {
    const context = this.workspaces.get(workspaceId)
    const worktreePath = context?.worktreePath ?? workspaceId
    await removeWorktreeImpl(this.cli, worktreePath, {
      worktreeRoot: this.worktreeRoot,
      // Callers may pass a worktree path instead of an id; either way, the
      // owning repository is whatever this driver recorded when it created it.
      ...(context === undefined ? this.knownRepoFor(worktreePath) : { repoPath: context.repoPath }),
    })
    if (context !== undefined) this.workspaces.delete(workspaceId)
  }
}

export type { CommitResult, CreateCommitParams, CreateWorktreeParams, RepositoryValidation, Worktree, WorktreeInspection }
