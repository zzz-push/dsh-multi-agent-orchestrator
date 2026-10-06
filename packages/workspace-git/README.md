# @dsh/workspace-git

Git worktree-based workspace driver for DSH Multi-Agent Orchestrator.

## Overview

`@dsh/workspace-git` provides isolated workspace management using Git worktrees. Each step attempt gets its own detached worktree, enabling parallel agent execution without interference.

**Key features:**
- Isolated worktrees per step attempt at `<os.tmpdir()>/dsh-orchestrator/worktrees/<repoKey>/<runId>/<stepId>/<attempt>/` (outside the repository and outside `.git/`)
- Preflight validation ensures repository is in a supported state
- All Git commands use parameter arrays (shell injection prevention)
- Path safety checks prevent accidental deletion of non-orchestrator worktrees
- Zero Cordis/Harness dependencies (pure Kernel layer)

## Installation

This package is part of the DSH monorepo:

```bash
pnpm install
pnpm --filter @dsh/workspace-git build
```

## Quick Start

```typescript
import { GitWorkspaceDriver } from '@dsh/workspace-git'

const driver = new GitWorkspaceDriver({
  gitPath: 'git',              // Optional: Git binary path
  commandTimeoutMs: 30_000,    // Optional: Command timeout
})

// 1. Inspect repository
const snapshot = await driver.inspectRepository('/path/to/repo')
console.log(snapshot.headCommit)

// 2. Create isolated worktree for attempt
const workspace = await driver.createAttempt({
  runId: 'run-001',
  stepId: 'step-001',
  attempt: 1,
  inputCommit: snapshot.headCommit,
  repository: snapshot,
})
console.log(workspace.worktreePath)
// => <os.tmpdir()>/dsh-orchestrator/worktrees/<repoKey>/run-001/step-001/1

// 3. Agent works in worktree (make changes, etc.)

// 4. Freeze the worktree into a candidate commit using a private index
const candidate = await driver.createCommit({
  worktreePath: workspace.worktreePath!,
  message: 'Implement the requested change',
  author: { name: 'DSH Orchestrator', email: 'dsh-orchestrator@localhost' },
})
console.log(candidate.sha, candidate.diffHash)

// 5. Clean up worktree (the workspace ID is also accepted)
await driver.removeAttempt(workspace.worktreePath!)
```

## Preflight Rules

The driver enforces strict preflight checks to ensure repository safety:

### ✅ Supported

- Clean working tree (no uncommitted changes)
- Normal Git repositories (non-bare)
- Detached HEAD state
- Repositories on branches
- Standard Git configurations

### ❌ Rejected (MVP)

- **Dirty working tree**: Any staged, unstaged, or untracked files
- **Ongoing operations**: Active merge, rebase, cherry-pick, or bisect
- **Submodules**: Repositories with `submodule.active` configuration
- **Sparse checkout**: Repositories with `core.sparseCheckout=true`
- **Bare repositories**: No working tree available

If preflight validation fails, the driver throws:
- `DirtyWorkingTreeError` - Repository has uncommitted changes
- `UnsupportedRepositoryError` - Repository configuration not supported
- `RepositoryNotFoundError` - Path is not a valid Git repository

## Security Model

### Path Safety

Worktree removal is restricted to a canonical path below the repository's own
subtree of the worktree root (`<root>/<repoKey>/` for the default absolute root,
`<git-common-dir>/<root>/` for a relative one). The path must resolve to a
worktree currently registered by Git; arbitrary paths that merely contain the
directory name are rejected. Under an absolute root a path alone does not say
which repository owns it, so the driver removes only worktrees it created (or
was told the repository of):

```typescript
// ✅ Safe - a worktree this driver created
await driver.removeAttempt(workspace.workspaceId)

// ❌ Rejected - outside orchestrator directory
await driver.removeAttempt('/tmp/some-worktree')
// throws WorktreePathMismatchError
```

### Tampered Worktrees

An agent can write anything in its worktree, including the `.git` file that
points git at the repository. Controller-side git commands on an attempt
worktree (capturing the candidate commit) therefore use the administrative
directory the repository registered for it when it was created
(`<git-common-dir>/worktrees/<id>`, see `registeredGitDir`), never the
worktree's own `.git` file, and run with `core.fsmonitor=false`. A rewritten
`.git` cannot make the controller load a repository config of the agent's
choosing.

### Command Injection Prevention

All Git commands use parameter arrays with `shell: false`:

```typescript
// ✅ Safe - parameter array
await cli.exec(['worktree', 'add', '--detach', path, commit])

// ❌ Never done - shell string concatenation
await cli.exec(`git worktree add --detach ${path} ${commit}`) // NEVER
```

### Worktree Isolation

Each attempt gets a completely isolated worktree:
- Detached HEAD state (no branch modifications)
- Independent working directory
- No shared index or staging area
- Parallel attempts never interfere

## API Reference

### GitWorkspaceDriver

Main driver class implementing `WorkspaceDriver` interface from `@dsh/core`.

#### Constructor Options

```typescript
interface GitWorkspaceDriverOptions {
  gitPath?: string              // Default: 'git'
  commandTimeoutMs?: number     // Default: 30000
  worktreeRoot?: string         // Default: <os.tmpdir()>/dsh-orchestrator/worktrees
}
```

`worktreeRoot` may be absolute (each repository gets a `<repoKey>/` subtree
under it) or relative, resolved under git-common-dir (`.git/<root>/…`, the
original layout). Avoid the relative form for agents running on Claude Code: it
refuses to write anywhere under a `.git/` directory, so an agent there cannot
edit a single file.

#### Methods

**`inspectRepository(root: string)`**

Inspect repository metadata and validate it meets requirements.

Returns: `{ root, commonDir, headCommit }`

Throws: `RepositoryNotFoundError`, `DirtyWorkingTreeError`, `UnsupportedRepositoryError`

**`createAttempt(request: CreateAttemptWorkspace)`**

Create an isolated worktree for a step attempt. Runs preflight validation first.

Returns: `{ workspaceId, worktreePath, inputCommit }`

Throws: Preflight errors + `WorktreeCreationError`

**`removeAttempt(workspaceId: string)`**

Remove a worktree (idempotent). Only removes paths within orchestrator directory.

Throws: `WorktreePathMismatchError`

**`captureResult(request: CaptureWorkspaceResult)` (optional)**

Freeze the attempt into a candidate commit with an immutable temporary index.
The result includes `resultCommit`, changed paths, and a SHA-256 diff hash. The
direct API cleans the worktree after the snapshot by default; pass
`preserveWorktree: true` when a repair attempt must keep the editable tree.

**`mergeResult(request: MergeWorkspaceResult)` (optional)**

Cherry-pick a candidate into the detached run integration worktree and update
the integration ref with an expected-old compare-and-swap.

### Error Classes

All errors extend `DshError` from `@dsh/spec`:

- `RepositoryNotFoundError` - Not a valid Git repository
- `DirtyWorkingTreeError` - Working tree has uncommitted changes
- `UnsupportedRepositoryError` - Repository configuration not supported
- `WorktreeCreationError` - Failed to create worktree
- `WorktreeNotFoundError` - Worktree doesn't exist
- `WorktreePathMismatchError` - Path doesn't match safety pattern
- `GitCommandError` - Git command execution failed
- `CommitCreationError` - Failed to create commit

Each error includes `code` (machine-readable) and `details` (context object).

## Limitations & Not Supported

The MVP implementation does not support:

- **Dirty repositories**: Automatic stashing or snapshotting uncommitted changes
- **Submodules**: Multi-worktree writes to nested repositories
- **Sparse checkout**: Partial working tree checkouts
- **LFS**: Large File Storage objects (works if already fetched)
- **Hooks**: Candidate commits use `commit-tree` and intentionally skip hooks;
  put required checks in the explicit workflow verifier
- **Automatic push**: No remote operations (local only)
- **Conflict resolution**: No automatic merge conflict handling

These limitations are part of the driver's design rationale.

## Error Handling

```typescript
import {
  DirtyWorkingTreeError,
  UnsupportedRepositoryError,
  WorktreeCreationError,
} from '@dsh/workspace-git'

try {
  const workspace = await driver.createAttempt(request)
} catch (err) {
  if (err instanceof DirtyWorkingTreeError) {
    console.error('Repository has uncommitted changes:', err.details)
    // Ask user to commit or stash changes
  } else if (err instanceof UnsupportedRepositoryError) {
    console.error('Repository configuration not supported:', err.details)
    // Show supported configuration requirements
  } else if (err instanceof WorktreeCreationError) {
    console.error('Failed to create worktree:', err.details)
    // Check disk space, permissions, Git version
  }
}
```

## Testing

The package includes comprehensive unit and integration tests:

```bash
# Run tests
pnpm --filter @dsh/workspace-git test

# Run with coverage
pnpm --filter @dsh/workspace-git test:coverage

# Watch mode
pnpm --filter @dsh/workspace-git test:watch
```

Coverage thresholds: ≥80% for statements, lines, and functions.

## Architecture

This package is **Kernel layer** - it has zero dependencies on Cordis or the Harness runtime:

```
@dsh/workspace-git (Kernel)
  ├─ @dsh/spec        (types, error base class)
  └─ @dsh/core        (WorkspaceDriver interface - type-only)
```

To use this driver in a Harness plugin, wrap it with a plugin that provides it as a Service:

```typescript
// In a Harness plugin package
export const name = 'workspace-git-plugin'

export function apply(ctx: Context) {
  const driver = new GitWorkspaceDriver()
  ctx.provide('dsh.workspace', driver)

  return () => {
    // Cleanup if needed
  }
}
```

See the repository README for the Kernel/Plugin split rationale.

## License

MIT
