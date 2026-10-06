import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import { GitCli } from '../src/git-cli.js'
import { validateRepositoryImpl } from '../src/preflight.js'
import {
  DirtyWorkingTreeError,
  UnsupportedRepositoryError,
  RepositoryNotFoundError,
} from '../src/errors.js'
import {
  createTempGitRepo,
  createTempGitRepoWithContent,
  cleanupTempRepo,
  makeRepoDirty,
  createMergeConflict,
} from './fixtures/test-repo.js'

const exec = promisify(execCb)

describe('validateRepositoryImpl', () => {
  let cli: GitCli
  let testRepo: string

  beforeEach(async () => {
    cli = new GitCli({ gitPath: 'git', timeoutMs: 5000 })
    const repo = await createTempGitRepo()
    // Resolve to real path to handle macOS /var -> /private/var symlink
    testRepo = await realpath(repo)
  })

  afterEach(async () => {
    await cleanupTempRepo(testRepo)
  })

  describe('valid repository', () => {
    it('passes validation for clean working tree', async () => {
      const result = await validateRepositoryImpl(cli, testRepo)

      expect(result.valid).toBe(true)
      expect(result.repoRoot).toBe(testRepo)
      expect(result.commonDir).toContain('.git')
      expect(result.headCommit).toMatch(/^[0-9a-f]{40}$/)
    })

    it('allows detached HEAD state', async () => {
      // Detach HEAD
      await exec('git checkout --detach HEAD', { cwd: testRepo })

      const result = await validateRepositoryImpl(cli, testRepo)

      expect(result.valid).toBe(true)
    })

    it('returns correct repository paths', async () => {
      const result = await validateRepositoryImpl(cli, testRepo)

      expect(result.repoRoot).toBe(testRepo)
      expect(result.commonDir).toMatch(/\.git$/)
    })
  })

  describe('dirty working tree', () => {
    it('rejects repository with untracked files', async () => {
      await makeRepoDirty(testRepo)

      await expect(validateRepositoryImpl(cli, testRepo)).rejects.toThrow(
        DirtyWorkingTreeError,
      )
    })

    it('rejects repository with staged changes', async () => {
      await writeFile(join(testRepo, 'new.txt'), 'content\n')
      await exec('git add new.txt', { cwd: testRepo })

      await expect(validateRepositoryImpl(cli, testRepo)).rejects.toThrow(
        DirtyWorkingTreeError,
      )
    })

    it('rejects repository with unstaged changes', async () => {
      await cleanupTempRepo(testRepo)
      const [repo] = await createTempGitRepoWithContent()
      testRepo = await realpath(repo)

      await writeFile(join(testRepo, 'test.txt'), 'modified content\n')

      await expect(validateRepositoryImpl(cli, testRepo)).rejects.toThrow(
        DirtyWorkingTreeError,
      )
    })

    it('includes file details in dirty tree error', async () => {
      await writeFile(join(testRepo, 'untracked.txt'), 'content\n')

      try {
        await validateRepositoryImpl(cli, testRepo)
        expect.fail('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(DirtyWorkingTreeError)
        const error = err as DirtyWorkingTreeError
        expect(error.details).toMatchObject({
          untracked: 1,
        })
      }
    })
  })

  describe('ongoing Git operations', () => {
    it('rejects repository with ongoing merge', async () => {
      await createMergeConflict(testRepo)

      await expect(validateRepositoryImpl(cli, testRepo)).rejects.toThrow(
        DirtyWorkingTreeError, // Merge conflict leaves dirty working tree
      )
    })

    it('rejects repository during rebase', async () => {
      await cleanupTempRepo(testRepo)
      const [repo] = await createTempGitRepoWithContent()
      testRepo = await realpath(repo)

      // Create a branch and rebase conflict
      await exec('git checkout -b feature', { cwd: testRepo })
      await writeFile(join(testRepo, 'test.txt'), 'feature content\n')
      await exec('git add test.txt', { cwd: testRepo })
      await exec('git commit -m "feature commit"', { cwd: testRepo })

      await exec('git checkout -', { cwd: testRepo })
      await writeFile(join(testRepo, 'test.txt'), 'main content\n')
      await exec('git add test.txt', { cwd: testRepo })
      await exec('git commit -m "main commit"', { cwd: testRepo })

      // Start rebase (will fail)
      try {
        await exec('git rebase feature', { cwd: testRepo })
      } catch {
        // Expected to fail
      }

      await expect(validateRepositoryImpl(cli, testRepo)).rejects.toThrow(
        DirtyWorkingTreeError, // Rebase conflict leaves dirty working tree
      )
    })
  })

  describe('unsupported configurations', () => {
    it('rejects bare repository', async () => {
      const bareRepo = await mkdtemp(join(tmpdir(), 'dsh-bare-repo-'))
      try {
        await exec('git init --bare', { cwd: bareRepo })
        await expect(validateRepositoryImpl(cli, bareRepo)).rejects.toThrow(
          UnsupportedRepositoryError,
        )
      } finally {
        await rm(bareRepo, { recursive: true, force: true })
      }
    })

    it('rejects repositories declaring active submodules', async () => {
      await exec('git config submodule.active .', { cwd: testRepo })

      await expect(validateRepositoryImpl(cli, testRepo)).rejects.toThrow(
        UnsupportedRepositoryError,
      )
    })

    it('rejects repository with sparse-checkout enabled', async () => {
      await exec('git config core.sparseCheckout true', { cwd: testRepo })

      await expect(validateRepositoryImpl(cli, testRepo)).rejects.toThrow(
        UnsupportedRepositoryError,
      )
    })

    it('allows repository without submodule config', async () => {
      const result = await validateRepositoryImpl(cli, testRepo)

      expect(result.valid).toBe(true)
    })

    it('rejects repositories with a submodule path configured', async () => {
      await exec('git config submodule.foo.path foo', { cwd: testRepo })

      await expect(validateRepositoryImpl(cli, testRepo)).rejects.toThrow(
        UnsupportedRepositoryError,
      )
    })
  })

  describe('invalid repository', () => {
    it('throws RepositoryNotFoundError for non-Git directory', async () => {
      const nonGitDir = join(testRepo, 'subdir')

      await expect(validateRepositoryImpl(cli, nonGitDir)).rejects.toThrow(
        RepositoryNotFoundError,
      )
    })

    it('throws RepositoryNotFoundError for nonexistent path', async () => {
      await expect(
        validateRepositoryImpl(cli, '/nonexistent/path'),
      ).rejects.toThrow(RepositoryNotFoundError)
    })
  })
})
