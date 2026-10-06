export { GitWorkspaceDriver, candidateRef } from './driver.js'
export type { GitWorkspaceDriverOptions } from './driver.js'

export {
  RepositoryNotFoundError,
  DirtyWorkingTreeError,
  UnsupportedRepositoryError,
  WorktreeCreationError,
  WorktreeNotFoundError,
  WorktreePathMismatchError,
  GitCommandError,
  CommitCreationError,
} from './errors.js'

export { CommandVerificationDriver, WorkflowCheckVerificationDriver, runProcess, KILL_GRACE_MS } from './command-verification.js'
export type { CommandVerificationDriverOptions, VerificationCommand } from './command-verification.js'

export { GitCli } from './git-cli.js'
export type { GitCliOptions, GitCommandResult, GitExecOptions } from './git-cli.js'

export { validateRepositoryImpl } from './preflight.js'
export type { RepositoryValidation } from './preflight.js'

export {
  createWorktreeImpl,
  defaultWorktreeRoot,
  inspectWorktreeImpl,
  registeredGitDir,
  removeWorktreeImpl,
  repositoryKey,
} from './worktree-ops.js'
export type { WorktreeOperationOptions } from './worktree-ops.js'

export { createCommitImpl } from './commit-ops.js'
export type { CommitResult, CreateCommitParams } from './commit-ops.js'

export { parseStatusPorcelain, parseWorktreeList } from './parsers.js'
export type {
  ParsedStatus,
  ParsedWorktree,
  CreateWorktreeParams,
  Worktree,
  WorktreeInspection,
  CommitIdentity,
} from './types.js'

export const WORKSPACE_GIT_PACKAGE_VERSION = '0.1.0'
