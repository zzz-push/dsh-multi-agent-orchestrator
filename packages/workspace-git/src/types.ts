/** Internal types for Git workspace driver implementation. */

export interface ParsedStatus {
  staged: string[]
  unstaged: string[]
  untracked: string[]
}

export interface ParsedWorktree {
  path: string
  commit: string
  branch?: string
  bare: boolean
}

/** Result of repository preflight validation. */
export interface RepositoryValidation {
  valid: boolean
  repoRoot: string
  commonDir: string
  headCommit: string
  /** Aliases used by the core RepositorySnapshot port. */
  root?: string
  gitCommonDir?: string
  baseCommit?: string
  worktrees?: ParsedWorktree[]
}

/** Parameters for creating a detached worktree. */
export interface CreateWorktreeParams {
  repoPath: string
  runId: string
  stepId: string
  attempt: number
  baseCommit: string
}

/** Worktree metadata returned after creation. */
export interface Worktree {
  path: string
  runId: string
  stepId: string
  attempt: number
  baseCommit: string
  createdAt: number
}

/** Worktree state reported by inspection. */
export interface WorktreeInspection {
  path: string
  exists: boolean
  hasUncommittedChanges: boolean
  headCommit?: string
  repoPath?: string
  changedPaths?: string[]
}

/** Author identity used for an orchestrator candidate commit. */
export interface CommitIdentity {
  name: string
  email: string
}

/** Parameters for creating an immutable candidate commit. */
export interface CreateCommitParams {
  worktreePath: string
  message: string
  author?: CommitIdentity
  committer?: CommitIdentity
  parentCommit?: string
  runId?: string
  stepId?: string
  attempt?: number
  /** Keep the editable attempt tree for repair instead of cleaning it. */
  preserveWorktree?: boolean
  /**
   * The worktree's administrative directory as the repository records it
   * (`<common-dir>/worktrees/<id>`, see `registeredGitDir`). When given, every
   * git command runs against it instead of discovering the repository through
   * the worktree's own `.git` file — which whoever last wrote the worktree
   * (an agent) controls, and could point at a repository whose config runs
   * commands. Without it the worktree is trusted as-is.
   */
  gitDir?: string
}

/** Candidate commit metadata. */
export interface CommitResult {
  sha: string
  treeSha: string
  parentCommit: string
  changedPaths: string[]
  diffHash: string
}
