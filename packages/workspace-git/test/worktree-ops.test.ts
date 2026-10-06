import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFile, realpath, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import { GitCli } from '../src/git-cli.js'
import {
  createWorktreeImpl,
  removeWorktreeImpl,
  inspectWorktreeImpl,
} from '../src/worktree-ops.js'
import {
  WorktreeCreationError,
  WorktreeNotFoundError,
  WorktreePathMismatchError,
} from '../src/errors.js'
import {
  createTempGitRepo,
  createTempGitRepoWithContent,
  cleanupTempRepo,
} from './fixtures/test-repo.js'

const exec = promisify(execCb)

describe('worktree-ops', () => {
  let cli: GitCli
  let testRepo: string
  let headCommit: string

  beforeEach(async () => {
    cli = new GitCli({ gitPath: 'git', timeoutMs: 5000 })
    const [repo, commit] = await createTempGitRepoWithContent()
    // Resolve to real path to handle macOS /var -> /private/var symlink
    testRepo = await realpath(repo)
    headCommit = commit
  })

  afterEach(async () => {
    await cleanupTempRepo(testRepo)
  })

  describe('createWorktreeImpl', () => {
    it('creates worktree at correct path', async () => {
      const worktree = await createWorktreeImpl(cli, 'dsh-orchestrator/worktrees', {
        repoPath: testRepo,
        runId: 'run-001',
        stepId: 'step-001',
        attempt: 1,
        baseCommit: headCommit,
      })

      expect(worktree.path).toContain('dsh-orchestrator/worktrees')
      expect(worktree.path).toContain('run-001')
      expect(worktree.path).toContain('step-001')
      expect(worktree.path).toContain('/1')
      expect(worktree.runId).toBe('run-001')
      expect(worktree.stepId).toBe('step-001')
      expect(worktree.attempt).toBe(1)
      expect(worktree.baseCommit).toBe(headCommit)
      expect(worktree.createdAt).toBeGreaterThan(0)
    })

    it('creates detached worktree at base commit', async () => {
      const worktree = await createWorktreeImpl(cli, 'dsh-orchestrator/worktrees', {
        repoPath: testRepo,
        runId: 'run-002',
        stepId: 'step-002',
        attempt: 1,
        baseCommit: headCommit,
      })

      // Verify worktree is at correct commit
      const { stdout } = await exec('git rev-parse HEAD', { cwd: worktree.path })
      const actualCommit = stdout.trim()

      expect(actualCommit).toBe(headCommit)
    })

    it('creates multiple worktrees for different attempts', async () => {
      const worktree1 = await createWorktreeImpl(
        cli,
        'dsh-orchestrator/worktrees',
        {
          repoPath: testRepo,
          runId: 'run-003',
          stepId: 'step-003',
          attempt: 1,
          baseCommit: headCommit,
        },
      )

      const worktree2 = await createWorktreeImpl(
        cli,
        'dsh-orchestrator/worktrees',
        {
          repoPath: testRepo,
          runId: 'run-003',
          stepId: 'step-003',
          attempt: 2,
          baseCommit: headCommit,
        },
      )

      expect(worktree1.path).not.toBe(worktree2.path)
      expect(worktree1.path).toContain('/1')
      expect(worktree2.path).toContain('/2')
    })

    it('throws WorktreeCreationError for invalid commit', async () => {
      await expect(
        createWorktreeImpl(cli, 'dsh-orchestrator/worktrees', {
          repoPath: testRepo,
          runId: 'run-004',
          stepId: 'step-004',
          attempt: 1,
          baseCommit: 'nonexistent-commit-sha',
        }),
      ).rejects.toThrow(WorktreeCreationError)
    })

    it('includes error details in WorktreeCreationError', async () => {
      try {
        await createWorktreeImpl(cli, 'dsh-orchestrator/worktrees', {
          repoPath: testRepo,
          runId: 'run-005',
          stepId: 'step-005',
          attempt: 1,
          baseCommit: 'invalid',
        })
        expect.fail('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(WorktreeCreationError)
        const error = err as WorktreeCreationError
        expect(error.details).toMatchObject({
          baseCommit: 'invalid',
        })
      }
    })
  })

  describe('removeWorktreeImpl', () => {
    it('removes existing worktree', async () => {
      const worktree = await createWorktreeImpl(cli, 'dsh-orchestrator/worktrees', {
        repoPath: testRepo,
        runId: 'run-006',
        stepId: 'step-006',
        attempt: 1,
        baseCommit: headCommit,
      })

      await removeWorktreeImpl(cli, worktree.path)

      // Verify worktree is removed - should throw when trying to inspect it
      await expect(inspectWorktreeImpl(cli, worktree.path)).rejects.toThrow(
        WorktreeNotFoundError,
      )
    })

    it('is idempotent - removing nonexistent worktree succeeds', async () => {
      const worktree = await createWorktreeImpl(cli, 'dsh-orchestrator/worktrees', {
        repoPath: testRepo,
        runId: 'run-007',
        stepId: 'step-007',
        attempt: 1,
        baseCommit: headCommit,
      })

      await removeWorktreeImpl(cli, worktree.path)
      await removeWorktreeImpl(cli, worktree.path) // Second removal should succeed

      expect(true).toBe(true) // No error thrown
    })

    it('throws WorktreePathMismatchError for non-dsh-orchestrator path', async () => {
      await expect(removeWorktreeImpl(cli, '/some/random/path')).rejects.toThrow(
        WorktreePathMismatchError,
      )
    })

    it('includes path details in WorktreePathMismatchError', async () => {
      const maliciousPath = '/tmp/some-worktree'

      try {
        await removeWorktreeImpl(cli, maliciousPath)
        expect.fail('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(WorktreePathMismatchError)
        const error = err as WorktreePathMismatchError
        expect(error.details).toMatchObject({
          path: maliciousPath,
        })
      }
    })
  })

  describe('inspectWorktreeImpl', () => {
    it('returns correct inspection for clean worktree', async () => {
      const worktree = await createWorktreeImpl(cli, 'dsh-orchestrator/worktrees', {
        repoPath: testRepo,
        runId: 'run-008',
        stepId: 'step-008',
        attempt: 1,
        baseCommit: headCommit,
      })

      const inspection = await inspectWorktreeImpl(cli, worktree.path)

      expect(inspection.path).toBe(worktree.path)
      expect(inspection.exists).toBe(true)
      expect(inspection.hasUncommittedChanges).toBe(false)
      expect(inspection.headCommit).toBe(headCommit)
    })

    it('detects uncommitted changes in worktree', async () => {
      const worktree = await createWorktreeImpl(cli, 'dsh-orchestrator/worktrees', {
        repoPath: testRepo,
        runId: 'run-009',
        stepId: 'step-009',
        attempt: 1,
        baseCommit: headCommit,
      })

      // Add a file to the worktree
      await writeFile(join(worktree.path, 'new-file.txt'), 'content\n')

      const inspection = await inspectWorktreeImpl(cli, worktree.path)

      expect(inspection.hasUncommittedChanges).toBe(true)
    })

    it('detects staged changes in worktree', async () => {
      const worktree = await createWorktreeImpl(cli, 'dsh-orchestrator/worktrees', {
        repoPath: testRepo,
        runId: 'run-010',
        stepId: 'step-010',
        attempt: 1,
        baseCommit: headCommit,
      })

      // Add and stage a file
      await writeFile(join(worktree.path, 'staged.txt'), 'content\n')
      await exec('git add staged.txt', { cwd: worktree.path })

      const inspection = await inspectWorktreeImpl(cli, worktree.path)

      expect(inspection.hasUncommittedChanges).toBe(true)
    })

    it('detects modified files in worktree', async () => {
      const worktree = await createWorktreeImpl(cli, 'dsh-orchestrator/worktrees', {
        repoPath: testRepo,
        runId: 'run-011',
        stepId: 'step-011',
        attempt: 1,
        baseCommit: headCommit,
      })

      // Modify existing file
      await writeFile(join(worktree.path, 'test.txt'), 'modified content\n')

      const inspection = await inspectWorktreeImpl(cli, worktree.path)

      expect(inspection.hasUncommittedChanges).toBe(true)
    })

    it('throws WorktreeNotFoundError for nonexistent worktree', async () => {
      const fakePath = join(testRepo, '.git', 'dsh-orchestrator/worktrees/fake/path/1')

      await expect(inspectWorktreeImpl(cli, fakePath)).rejects.toThrow(
        WorktreeNotFoundError,
      )
    })

    it('includes path details in WorktreeNotFoundError', async () => {
      const fakePath = join(testRepo, '.git', 'dsh-orchestrator/worktrees/fake/path/1')

      try {
        await inspectWorktreeImpl(cli, fakePath)
        expect.fail('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(WorktreeNotFoundError)
        const error = err as WorktreeNotFoundError
        expect(error.details).toMatchObject({
          path: fakePath,
        })
      }
    })

    it('throws WorktreeNotFoundError when Git still lists a worktree whose directory was deleted directly', async () => {
      const worktree = await createWorktreeImpl(cli, 'dsh-orchestrator/worktrees', {
        repoPath: testRepo,
        runId: 'run-012',
        stepId: 'step-012',
        attempt: 1,
        baseCommit: headCommit,
      })

      // Delete the directory without going through `git worktree remove`, so
      // Git's own worktree registry still lists this now-missing path.
      await rm(worktree.path, { recursive: true, force: true })

      await expect(inspectWorktreeImpl(cli, worktree.path)).rejects.toThrow(
        WorktreeNotFoundError,
      )
    })

    it('throws WorktreeNotFoundError when the resolved repository path is not a Git repo at all', async () => {
      const nonGitDir = await mkdtemp(join(tmpdir(), 'dsh-non-git-'))
      try {
        const fakeWorktreePath = join(nonGitDir, 'dsh-orchestrator', 'worktrees', 'run-x', 'step-x', '1')

        await expect(
          inspectWorktreeImpl(cli, fakeWorktreePath, { repoPath: nonGitDir }),
        ).rejects.toThrow(WorktreeNotFoundError)
      } finally {
        await rm(nonGitDir, { recursive: true, force: true })
      }
    })
  })
})
