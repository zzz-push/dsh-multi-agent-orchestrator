import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { GitCli } from './git-cli.js'
import { CommitCreationError } from './errors.js'
import type { CommitResult, CreateCommitParams } from './types.js'

const DEFAULT_IDENTITY = { name: 'DSH Orchestrator', email: 'dsh-orchestrator@localhost' }

function identityEnv(
  prefix: 'GIT_AUTHOR' | 'GIT_COMMITTER',
  identity: { name: string; email: string },
): Record<string, string> {
  return {
    [`${prefix}_NAME`]: identity.name,
    [`${prefix}_EMAIL`]: identity.email,
  }
}

function parseNulPaths(output: string): string[] {
  return output.split('\0').filter((entry) => entry.length > 0)
}

/**
 * Snapshot a worktree into an immutable commit without touching its normal
 * index. The temporary index makes the read-tree/add/write-tree sequence
 * auditable and prevents a later index mutation from changing the candidate.
 */
export async function createCommitImpl(
  cli: GitCli,
  params: CreateCommitParams,
): Promise<CommitResult> {
  const worktreePath = await realpath(params.worktreePath).catch((error) => {
    throw new CommitCreationError('Worktree does not exist', {
      cause: error,
      details: { worktreePath: params.worktreePath },
    })
  })
  // With a registered gitDir, git never looks at the worktree's `.git` file
  // (see CreateCommitParams.gitDir). `core.fsmonitor=false` on every command
  // either way: it is the setting that makes `add` run a configured command.
  const located = params.gitDir === undefined ? {} : { GIT_DIR: params.gitDir, GIT_WORK_TREE: worktreePath }
  const git = (args: string[]): string[] => ['-c', 'core.fsmonitor=false', ...args]
  const commonDirRaw = await cli.execLine(
    git(['rev-parse', '--path-format=absolute', '--git-common-dir']),
    worktreePath,
    { env: located },
  )
  const commonDir = path.resolve(worktreePath, commonDirRaw)
  const actualHead = await cli.execLine(git(['rev-parse', 'HEAD']), worktreePath, { env: located })
  const parentCommit = params.parentCommit ?? actualHead
  if (parentCommit !== actualHead) {
    throw new CommitCreationError(
      'Worktree HEAD does not match the candidate parent commit',
      {
        details: { worktreePath, expectedParent: parentCommit, actualHead },
      },
    )
  }
  const tempParent = path.join(commonDir, 'dsh-orchestrator', 'tmp')
  // The private directory is intentionally below git-common-dir. Git receives
  // its path through an environment variable, never through a shell string.
  await mkdir(tempParent, { recursive: true })
  const tempDir = await mkdtemp(`${tempParent}${path.sep}index-`)
  const indexPath = path.join(tempDir, 'index')

  try {
    const baseEnv = { ...located, GIT_INDEX_FILE: indexPath, GIT_WORK_TREE: worktreePath }
    await cli.exec(git(['read-tree', parentCommit]), worktreePath, { env: baseEnv })
    await cli.exec(git(['add', '-A', '--', '.']), worktreePath, { env: baseEnv })
    const treeSha = await cli.execLine(git(['write-tree']), worktreePath, { env: baseEnv })

    const author = params.author ?? DEFAULT_IDENTITY
    const committer = params.committer ?? author
    const commitEnv = {
      ...baseEnv,
      ...identityEnv('GIT_AUTHOR', author),
      ...identityEnv('GIT_COMMITTER', committer),
    }
    const sha = await cli.execLine(
      git(['commit-tree', treeSha, '-p', parentCommit]),
      worktreePath,
      { env: commitEnv, input: params.message.endsWith('\n') ? params.message : `${params.message}\n` },
    )

    const changedOutput = await cli.exec(
      git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', parentCommit, sha]),
      worktreePath,
      { env: located },
    )
    const changedPaths = parseNulPaths(changedOutput.stdout)
    const diff = await cli.exec(
      git(['diff', '--binary', '--no-ext-diff', '--no-textconv', parentCommit, sha]),
      worktreePath,
      { env: located },
    )
    const diffHash = createHash('sha256').update(diff.stdout).digest('hex')
    return { sha, treeSha, parentCommit, changedPaths, diffHash }
  } catch (error) {
    if (error instanceof CommitCreationError) throw error
    throw new CommitCreationError('Failed to create candidate commit', {
      cause: error,
      details: {
        worktreePath,
        parentCommit,
        message: params.message,
      },
    })
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

export type { CommitResult, CreateCommitParams } from './types.js'
