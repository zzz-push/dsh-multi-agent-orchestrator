import { DshError } from '@dsh/spec'

/** Repository path does not point to a valid Git repository. */
export class RepositoryNotFoundError extends DshError {
  readonly code = 'REPOSITORY_NOT_FOUND'
}

/** Working tree has uncommitted changes; MVP requires clean working tree. */
export class DirtyWorkingTreeError extends DshError {
  readonly code = 'DIRTY_WORKING_TREE'
}

/** Repository configuration is not supported (submodule, sparse-checkout, bare, etc). */
export class UnsupportedRepositoryError extends DshError {
  readonly code = 'UNSUPPORTED_REPOSITORY'
}

/** Failed to create worktree. */
export class WorktreeCreationError extends DshError {
  readonly code = 'WORKTREE_CREATION_FAILED'
}

/** Worktree not found in Git's worktree list. */
export class WorktreeNotFoundError extends DshError {
  readonly code = 'WORKTREE_NOT_FOUND'
}

/** Worktree path does not match expected safety pattern. */
export class WorktreePathMismatchError extends DshError {
  readonly code = 'WORKTREE_PATH_MISMATCH'
}

/** Git command execution failed. */
export class GitCommandError extends DshError {
  readonly code = 'GIT_COMMAND_FAILED'
}

/** Failed to create commit in worktree. */
export class CommitCreationError extends DshError {
  readonly code = 'COMMIT_CREATION_FAILED'
}
