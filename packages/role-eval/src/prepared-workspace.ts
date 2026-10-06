import type { AttemptWorkspace, CreateAttemptWorkspace, WorkspaceDriver } from '@dsh/core'
import { CommandVerificationDriver, type VerificationCommand } from '@dsh/workspace-git'

/**
 * Environment for every command the controller runs — setup, visible checks,
 * hidden checks. A comparison record claims its scores are reproducible;
 * letting the operator's locale leak in breaks that. Observed during testing: on a
 * `zh_CN.UTF-8` host, git printed a translated error, one of the base
 * commit's own tests (which matches git's English message) failed, and both
 * arms were recorded as failing the gate for a reason neither of them caused.
 * The agents themselves still inherit the host environment — equally for
 * every arm.
 */
export const CONTROLLER_ENV: Readonly<Record<string, string>> = { LC_ALL: 'C', LANGUAGE: 'C' }

/**
 * A `WorkspaceDriver` that runs the manifest's `setup` commands in every
 * fresh attempt worktree before the agent is let in.
 *
 * Why this exists: the agent works inside its harness sandbox, and some
 * preparation cannot be done from there. The concrete case is `pnpm
 * install` under codex's `workspace-write` seatbelt — pnpm cannot reach the
 * user's content-addressable store, silently resolves a different one under
 * the temp root, and fails with `ERR_PNPM_NO_OFFLINE_TARBALL`. Doing it here,
 * controller-side and identically for every arm, keeps the sandbox tight and
 * the "same kitchen" guarantee intact.
 *
 * Setup runs through {@link CommandVerificationDriver} (same `sh -c`, same
 * cwd, same timeouts as the checks). A failing setup command removes the
 * worktree it prepared and throws, so the Scheduler fails the step as a
 * host error and no half-prepared worktree leaks. Anything setup writes
 * that `.gitignore` does not cover ends up in the candidate commit — that
 * is by design (the candidate is "the worktree as the agent left it"), so
 * setup should produce ignored artefacts only, like `node_modules/`.
 */
export class PreparedWorkspaceDriver implements WorkspaceDriver {
  private readonly setup: CommandVerificationDriver

  constructor(private readonly inner: WorkspaceDriver, commands: readonly VerificationCommand[]) {
    this.setup = new CommandVerificationDriver({ commands, env: { ...CONTROLLER_ENV } })
    // Optional port methods are forwarded only when the inner driver has them,
    // so the Scheduler's feature detection (`driver.captureResult === undefined`)
    // sees exactly what it would see on the inner driver.
    if (inner.inspectRepository !== undefined) this.inspectRepository = (root) => inner.inspectRepository!(root)
    if (inner.captureResult !== undefined) this.captureResult = (request) => inner.captureResult!(request)
    if (inner.mergeResult !== undefined) this.mergeResult = (request) => inner.mergeResult!(request)
    if (inner.removeAttempt !== undefined) this.removeAttempt = (workspaceId) => inner.removeAttempt!(workspaceId)
  }

  inspectRepository?: WorkspaceDriver['inspectRepository']
  captureResult?: WorkspaceDriver['captureResult']
  mergeResult?: WorkspaceDriver['mergeResult']
  removeAttempt?: WorkspaceDriver['removeAttempt']

  async createAttempt(request: CreateAttemptWorkspace): Promise<AttemptWorkspace> {
    const workspace = await this.inner.createAttempt(request)
    const result = await this.setup.run({
      runId: request.runId,
      stepId: request.stepId,
      attempt: request.attempt,
      workspaceId: workspace.workspaceId,
      ...(workspace.worktreePath === undefined ? {} : { worktreePath: workspace.worktreePath }),
    })
    if (result.passed) return workspace
    await this.inner.removeAttempt?.(workspace.workspaceId).catch(() => undefined)
    throw new Error(`workspace setup failed: ${result.failureMessage ?? 'unknown error'}`)
  }
}
