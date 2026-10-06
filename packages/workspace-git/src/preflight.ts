import { access, constants, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { GitCli } from './git-cli.js'
import {
  DirtyWorkingTreeError,
  UnsupportedRepositoryError,
  RepositoryNotFoundError,
  GitCommandError,
} from './errors.js'
import { parseStatusPorcelain, parseWorktreeList } from './parsers.js'
import type { RepositoryValidation } from './types.js'

const ONGOING_OPERATION_FILES = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG',
] as const

/** Return true when a Git command failed because a config key is absent. */
function isMissingConfig(error: unknown): boolean {
  return (
    error instanceof GitCommandError &&
    (error.details as { exitCode?: number } | undefined)?.exitCode === 1
  )
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function rejectOngoingOperation(
  cli: GitCli,
  repoPath: string,
  commonDir: string,
): Promise<void> {
  // A linked worktree has operation files in its private git dir while a
  // normal repository uses the common dir. Ask Git for both locations instead
  // of assuming `<common-dir>/.git`, which is incorrect for normal repos.
  const gitDirRaw = await cli.execLine(
    ['rev-parse', '--path-format=absolute', '--git-dir'],
    repoPath,
  )
  const gitDir = await realpath(path.resolve(repoPath, gitDirRaw))
  const candidateDirs = [...new Set([gitDir, commonDir])]

  for (const directory of candidateDirs) {
    for (const operation of ONGOING_OPERATION_FILES) {
      if (await pathExists(path.join(directory, operation))) {
        throw new UnsupportedRepositoryError(
          `Repository has ongoing ${operation
            .replace(/_HEAD$/, '')
            .replace('_', ' ')
            .toLowerCase()} operation`,
          { details: { operation, gitDir: directory } },
        )
      }
    }
    if (
      (await pathExists(path.join(directory, 'rebase-merge'))) ||
      (await pathExists(path.join(directory, 'rebase-apply')))
    ) {
      throw new UnsupportedRepositoryError('Repository has ongoing rebase operation', {
        details: { operation: 'REBASE', gitDir: directory },
      })
    }
  }
}

async function rejectUnsupportedConfiguration(
  cli: GitCli,
  repoPath: string,
): Promise<void> {
  const bare = await cli.execLine(['rev-parse', '--is-bare-repository'], repoPath)
  if (bare === 'true') {
    throw new UnsupportedRepositoryError('Bare repositories are not supported', {
      details: { reason: 'bare' },
    })
  }

  try {
    const sparse = await cli.execLine(
      ['config', '--bool', '--get', 'core.sparseCheckout'],
      repoPath,
    )
    if (sparse === 'true') {
      throw new UnsupportedRepositoryError(
        'Repository uses sparse-checkout; not supported in MVP',
        { details: { reason: 'sparse-checkout' } },
      )
    }
  } catch (error) {
    if (!isMissingConfig(error)) throw error
  }

  // `submodule.active` is retained for compatibility with repositories that
  // declare submodules before the .gitmodules file is populated.
  try {
    const active = await cli.execLine(
      ['config', '--get', 'submodule.active'],
      repoPath,
    )
    if (active.length > 0) {
      throw new UnsupportedRepositoryError(
        'Repository has active submodules; not supported in MVP',
        { details: { reason: 'submodule', value: active } },
      )
    }
  } catch (error) {
    if (!isMissingConfig(error)) throw error
  }

  try {
    const configuredSubmodules = await cli.execLine(
      ['config', '--get-regexp', '^submodule\\..*\\.path$'],
      repoPath,
    )
    if (configuredSubmodules.length > 0) {
      throw new UnsupportedRepositoryError(
        'Repository has configured submodules; not supported in MVP',
        { details: { reason: 'submodule', config: configuredSubmodules } },
      )
    }
  } catch (error) {
    if (!isMissingConfig(error)) throw error
  }

  // A gitlink (mode 160000) is authoritative even when config is absent.
  const stagedFiles = await cli.exec(
    ['ls-files', '--stage', '-z'],
    repoPath,
  )
  const hasGitlink = stagedFiles.stdout
    .split('\0')
    .some((entry) => entry.startsWith('160000 '))
  if (hasGitlink) {
    throw new UnsupportedRepositoryError(
      'Repository contains submodules; not supported in MVP',
      { details: { reason: 'submodule' } },
    )
  }
}

/**
 * Validate repository state before creating a worktree.
 *
 * The status and worktree list use porcelain/NUL output so arbitrary file
 * names never become shell syntax or ambiguous text records.
 * @throws {RepositoryNotFoundError} when the path is not a Git repository.
 * @throws {DirtyWorkingTreeError} when tracked or untracked files are present.
 * @throws {UnsupportedRepositoryError} for unsupported Git repository states.
 */
export async function validateRepositoryImpl(
  cli: GitCli,
  repoPath: string,
): Promise<RepositoryValidation> {
  repoPath = path.resolve(repoPath)
  try {
    // Probe repository type before asking for a working-tree root so bare
    // repositories get the documented UNSUPPORTED_REPOSITORY classification.
    const bareProbe = await cli.execLine(
      ['rev-parse', '--is-bare-repository'],
      repoPath,
    )
    if (bareProbe === 'true') {
      throw new UnsupportedRepositoryError('Bare repositories are not supported', {
        details: { reason: 'bare' },
      })
    }
    const repoRootRaw = await cli.execLine(
      ['rev-parse', '--show-toplevel'],
      repoPath,
    )
    const commonDirRaw = await cli.execLine(
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      repoPath,
    )
    const repoRoot = await realpath(path.resolve(repoPath, repoRootRaw))
    const commonDir = await realpath(path.resolve(repoRoot, commonDirRaw))
    const headCommit = await cli.execLine(['rev-parse', 'HEAD'], repoPath)

    const statusOutput = await cli.exec(
      ['status', '--porcelain=v2', '-z', '--untracked-files=all'],
      repoPath,
    )
    if (statusOutput.stdout.length > 0) {
      const parsed = parseStatusPorcelain(statusOutput.stdout)
      const tracked = new Set([...parsed.staged, ...parsed.unstaged]).size
      throw new DirtyWorkingTreeError(
        'Repository has uncommitted changes; MVP requires a clean working tree',
        {
          details: {
            tracked,
            staged: parsed.staged.length,
            unstaged: parsed.unstaged.length,
            untracked: parsed.untracked.length,
            files: parsed,
          },
        },
      )
    }

    await rejectOngoingOperation(cli, repoPath, commonDir)
    await rejectUnsupportedConfiguration(cli, repoPath)

    const worktreeOutput = await cli.exec(
      ['worktree', 'list', '--porcelain', '-z'],
      repoPath,
    )
    const worktrees = parseWorktreeList(worktreeOutput.stdout)

    return {
      valid: true,
      repoRoot,
      commonDir,
      headCommit,
      root: repoRoot,
      gitCommonDir: commonDir,
      baseCommit: headCommit,
      worktrees,
    }
  } catch (error) {
    if (
      error instanceof DirtyWorkingTreeError ||
      error instanceof UnsupportedRepositoryError ||
      error instanceof RepositoryNotFoundError
    ) {
      throw error
    }
    throw new RepositoryNotFoundError('Cannot validate repository', {
      cause: error,
      details: { repoPath },
    })
  }
}

export type { RepositoryValidation } from './types.js'
