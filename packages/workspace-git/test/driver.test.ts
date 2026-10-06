import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { access, mkdir, writeFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { GitWorkspaceDriver } from '../src/driver.js'
import { defaultWorktreeRoot, repositoryKey } from '../src/worktree-ops.js'
import {
  RepositoryNotFoundError,
  DirtyWorkingTreeError,
  WorktreeNotFoundError,
} from '../src/errors.js'
import {
  createTempGitRepo,
  createTempGitRepoWithContent,
  cleanupTempRepo,
  makeRepoDirty,
} from './fixtures/test-repo.js'

describe('GitWorkspaceDriver', () => {
  let driver: GitWorkspaceDriver
  let testRepo: string
  let headCommit: string

  beforeEach(async () => {
    driver = new GitWorkspaceDriver()
    const [repo, commit] = await createTempGitRepoWithContent()
    // Resolve to real path to handle macOS /var -> /private/var symlink
    testRepo = await realpath(repo)
    headCommit = commit
  })

  afterEach(async () => {
    await cleanupTempRepo(testRepo)
    // These tests exercise the default root on purpose, so their worktrees
    // land in the shared `<tmpdir>/dsh-orchestrator/worktrees/`; remove this
    // repository's subtree with the repository.
    await rm(join(defaultWorktreeRoot(), repositoryKey(join(testRepo, '.git'))), { recursive: true, force: true })
  })

  describe('inspectRepository', () => {
    it('returns repository metadata', async () => {
      const snapshot = await driver.inspectRepository(testRepo)

      expect(snapshot.root).toBe(testRepo)
      expect(snapshot.commonDir).toContain('.git')
      expect(snapshot.headCommit).toMatch(/^[0-9a-f]{40}$/)
    })

    it('throws for invalid repository', async () => {
      await expect(driver.inspectRepository('/nonexistent')).rejects.toThrow(
        RepositoryNotFoundError,
      )
    })
  })

  describe('createAttempt', () => {
    it('creates worktree for attempt', async () => {
      const workspace = await driver.createAttempt({
        runId: 'run-001',
        stepId: 'step-001',
        attempt: 1,
        inputCommit: headCommit,
        repository: {
          root: testRepo,
          commonDir: join(testRepo, '.git'),
          headCommit,
        },
      })

      expect(workspace.workspaceId).toBe('run-001-step-001-1')
      expect(workspace.worktreePath).toContain('dsh-orchestrator/worktrees')
      expect(workspace.worktreePath).toContain('run-001')
      expect(workspace.worktreePath).toContain('step-001')
      expect(workspace.worktreePath).toContain('/1')
      expect(workspace.inputCommit).toBe(headCommit)
    })

    it('runs preflight validation before creating worktree', async () => {
      await makeRepoDirty(testRepo)

      await expect(
        driver.createAttempt({
          runId: 'run-002',
          stepId: 'step-002',
          attempt: 1,
          inputCommit: headCommit,
          repository: {
            root: testRepo,
            commonDir: join(testRepo, '.git'),
            headCommit,
          },
        }),
      ).rejects.toThrow(DirtyWorkingTreeError)
    })

    it('creates multiple worktrees for different attempts', async () => {
      const workspace1 = await driver.createAttempt({
        runId: 'run-003',
        stepId: 'step-003',
        attempt: 1,
        inputCommit: headCommit,
        repository: {
          root: testRepo,
          commonDir: join(testRepo, '.git'),
          headCommit,
        },
      })

      const workspace2 = await driver.createAttempt({
        runId: 'run-003',
        stepId: 'step-003',
        attempt: 2,
        inputCommit: headCommit,
        repository: {
          root: testRepo,
          commonDir: join(testRepo, '.git'),
          headCommit,
        },
      })

      expect(workspace1.worktreePath).not.toBe(workspace2.worktreePath)
    })
  })

  describe('removeAttempt', () => {
    it('removes worktree', async () => {
      const workspace = await driver.createAttempt({
        runId: 'run-004',
        stepId: 'step-004',
        attempt: 1,
        inputCommit: headCommit,
        repository: {
          root: testRepo,
          commonDir: join(testRepo, '.git'),
          headCommit,
        },
      })

      await driver.removeAttempt(workspace.worktreePath!)

      // Verify removal by trying to inspect
      await expect(
        driver.inspectWorktree(workspace.worktreePath!),
      ).rejects.toThrow(WorktreeNotFoundError)
    })

    it('is idempotent', async () => {
      const workspace = await driver.createAttempt({
        runId: 'run-005',
        stepId: 'step-005',
        attempt: 1,
        inputCommit: headCommit,
        repository: {
          root: testRepo,
          commonDir: join(testRepo, '.git'),
          headCommit,
        },
      })

      await driver.removeAttempt(workspace.worktreePath!)
      await driver.removeAttempt(workspace.worktreePath!)

      expect(true).toBe(true) // No error thrown
    })
  })

  describe('end-to-end workflow', () => {
    it('complete lifecycle: validate -> create -> inspect -> remove', async () => {
      // 1. Inspect repository
      const snapshot = await driver.inspectRepository(testRepo)
      expect(snapshot.root).toBe(testRepo)

      // 2. Create worktree
      const workspace = await driver.createAttempt({
        runId: 'run-e2e',
        stepId: 'step-e2e',
        attempt: 1,
        inputCommit: snapshot.headCommit,
        repository: snapshot,
      })
      expect(workspace.worktreePath).toContain('dsh-orchestrator/worktrees')

      // 3. Verify worktree is clean initially
      const initialInspection = await driver.inspectWorktree(workspace.worktreePath!)
      expect(initialInspection.hasUncommittedChanges).toBe(false)

      // 4. Make changes in worktree
      await writeFile(join(workspace.worktreePath!, 'new-file.txt'), 'content\n')

      // 5. Verify worktree has uncommitted changes
      const afterChanges = await driver.inspectWorktree(workspace.worktreePath!)
      expect(afterChanges.hasUncommittedChanges).toBe(true)

      // 6. Clean up
      await driver.removeAttempt(workspace.worktreePath!)

      // 7. Verify removal
      await expect(
        driver.inspectWorktree(workspace.worktreePath!),
      ).rejects.toThrow(WorktreeNotFoundError)
    })

    it('handles multiple parallel worktrees', async () => {
      const snapshot = await driver.inspectRepository(testRepo)

      // Create worktrees for different steps
      const workspace1 = await driver.createAttempt({
        runId: 'run-parallel',
        stepId: 'step-001',
        attempt: 1,
        inputCommit: snapshot.headCommit,
        repository: snapshot,
      })

      const workspace2 = await driver.createAttempt({
        runId: 'run-parallel',
        stepId: 'step-002',
        attempt: 1,
        inputCommit: snapshot.headCommit,
        repository: snapshot,
      })

      // Both worktrees should exist independently
      expect(workspace1.worktreePath).not.toBe(workspace2.worktreePath)

      // Modify both worktrees independently
      await writeFile(join(workspace1.worktreePath!, 'file1.txt'), 'content1\n')
      await writeFile(join(workspace2.worktreePath!, 'file2.txt'), 'content2\n')

      // Both should have uncommitted changes
      const inspect1 = await driver.inspectWorktree(workspace1.worktreePath!)
      const inspect2 = await driver.inspectWorktree(workspace2.worktreePath!)

      expect(inspect1.hasUncommittedChanges).toBe(true)
      expect(inspect2.hasUncommittedChanges).toBe(true)

      // Clean up
      await driver.removeAttempt(workspace1.worktreePath!)
      await driver.removeAttempt(workspace2.worktreePath!)
    })
  })

  describe('captureResult against a tampered worktree', () => {
    it('ignores a rewritten .git file, so its repository config never runs controller-side', async () => {
      const snapshot = await driver.inspectRepository(testRepo)
      const workspace = await driver.createAttempt({
        runId: 'run-tamper',
        stepId: 'step-tamper',
        attempt: 1,
        inputCommit: snapshot.headCommit,
        repository: snapshot,
      })
      const worktree = workspace.worktreePath!
      const marker = join(testRepo, 'fsmonitor-ran')

      // What an agent with write access to its worktree can do: point `.git`
      // at a repository it built, whose config runs a command on `git add`.
      const fake = join(worktree, '.fake-git')
      await mkdir(join(fake, 'objects', 'info'), { recursive: true })
      await mkdir(join(fake, 'refs'), { recursive: true })
      await writeFile(join(fake, 'objects', 'info', 'alternates'), `${join(testRepo, '.git', 'objects')}\n`)
      await writeFile(join(fake, 'HEAD'), `${snapshot.headCommit}\n`)
      await writeFile(join(fake, 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfsmonitor = "touch '${marker}'; false"\n`)
      await writeFile(join(worktree, '.git'), `gitdir: ${fake}\n`)
      await writeFile(join(worktree, 'work.txt'), 'the step\'s real change\n')

      // Settle first: when the fake repository is honoured, the candidate is
      // written there and pinning it in the real one fails afterwards.
      const capture = await driver.captureResult({
        workspaceId: workspace.workspaceId,
        runId: 'run-tamper',
        stepId: 'step-tamper',
        attempt: 1,
      }).then((result) => ({ result }), (error: unknown) => ({ error }))

      await expect(access(marker)).rejects.toThrow()
      expect(capture).toHaveProperty('result')
      expect('result' in capture && capture.result.changedPaths).toContain('work.txt')
    })
  })

  describe('custom configuration', () => {
    it('accepts custom Git path', () => {
      const customDriver = new GitWorkspaceDriver({ gitPath: '/usr/bin/git' })
      expect(customDriver).toBeInstanceOf(GitWorkspaceDriver)
    })

    it('accepts custom timeout', () => {
      const customDriver = new GitWorkspaceDriver({ commandTimeoutMs: 60000 })
      expect(customDriver).toBeInstanceOf(GitWorkspaceDriver)
    })

    it('accepts custom worktree root', () => {
      const customDriver = new GitWorkspaceDriver({
        worktreeRoot: 'custom-root/worktrees',
      })
      expect(customDriver).toBeInstanceOf(GitWorkspaceDriver)
    })
  })
})
