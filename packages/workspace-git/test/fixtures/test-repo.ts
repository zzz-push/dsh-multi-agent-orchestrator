import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execCb)

/**
 * Create a temporary Git repository for testing.
 *
 * Repository is initialized with:
 * - Git user config (name and email)
 * - Initial empty commit
 * - Clean working tree
 *
 * @returns Absolute path to temporary repository
 */
export async function createTempGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-test-repo-'))

  await exec('git init', { cwd: dir })
  await exec('git config user.name "Test User"', { cwd: dir })
  await exec('git config user.email "test@example.com"', { cwd: dir })

  // Create initial commit (required for worktree operations)
  await exec('git commit --allow-empty -m "initial commit"', { cwd: dir })

  return dir
}

/**
 * Create a temporary Git repository with some file content.
 *
 * @returns Tuple of [repoPath, firstCommitSha]
 */
export async function createTempGitRepoWithContent(): Promise<
  [string, string]
> {
  const dir = await createTempGitRepo()

  // Add a test file
  await writeFile(join(dir, 'test.txt'), 'initial content\n')
  await exec('git add test.txt', { cwd: dir })
  await exec('git commit -m "add test.txt"', { cwd: dir })

  const { stdout } = await exec('git rev-parse HEAD', { cwd: dir })
  const commitSha = stdout.trim()

  return [dir, commitSha]
}

/**
 * Clean up a temporary repository, removing all worktrees first.
 *
 * @param repoPath - Path to repository to clean up
 */
export async function cleanupTempRepo(repoPath: string): Promise<void> {
  // First, remove all worktrees except the main one
  try {
    const { stdout } = await exec('git worktree list --porcelain', {
      cwd: repoPath,
    })
    const worktrees = stdout.split('\n\n').filter(Boolean)

    // Skip the first worktree (main worktree)
    for (const wt of worktrees.slice(1)) {
      const pathLine = wt.split('\n')[0]
      if (!pathLine?.startsWith('worktree ')) continue

      const path = pathLine.slice('worktree '.length)
      try {
        await exec(`git worktree remove --force "${path}"`, { cwd: repoPath })
      } catch {
        // Ignore cleanup failures
      }
    }
  } catch {
    // Ignore if worktree list fails
  }

  // Remove the repository directory
  await rm(repoPath, { recursive: true, force: true })
}

/**
 * Make repository dirty by adding untracked file.
 *
 * @param repoPath - Path to repository
 */
export async function makeRepoDirty(repoPath: string): Promise<void> {
  await writeFile(join(repoPath, 'untracked.txt'), 'dirty content\n')
}

/**
 * Create a merge conflict state in repository.
 *
 * @param repoPath - Path to repository
 */
export async function createMergeConflict(repoPath: string): Promise<void> {
  // Create a conflicting branch
  await exec('git checkout -b conflict-branch', { cwd: repoPath })
  await writeFile(join(repoPath, 'conflict.txt'), 'branch content\n')
  await exec('git add conflict.txt', { cwd: repoPath })
  await exec('git commit -m "branch commit"', { cwd: repoPath })

  // Go back to main and create conflicting change
  await exec('git checkout -', { cwd: repoPath })
  await writeFile(join(repoPath, 'conflict.txt'), 'main content\n')
  await exec('git add conflict.txt', { cwd: repoPath })
  await exec('git commit -m "main commit"', { cwd: repoPath })

  // Try to merge (will fail with conflict)
  try {
    await exec('git merge conflict-branch', { cwd: repoPath })
  } catch {
    // Expected to fail with conflict
  }
}
