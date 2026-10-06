import { describe, it, expect } from 'vitest'
import { realpath, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import { GitCli } from '../src/git-cli.js'
import { createWorktreeImpl, inspectWorktreeImpl } from '../src/worktree-ops.js'

const exec = promisify(execCb)

describe('path resolution integration', () => {
  it('should handle macOS symlink paths correctly', async () => {
    // Create temp repo
    const dir = await mkdtemp(join(tmpdir(), 'dsh-path-test-'))
    const testRepo = await realpath(dir)

    try {
      await exec('git init', { cwd: testRepo })
      await exec('git config user.name "Test"', { cwd: testRepo })
      await exec('git config user.email "test@example.com"', { cwd: testRepo })
      await exec('git commit --allow-empty -m "init"', { cwd: testRepo })

      const { stdout } = await exec('git rev-parse HEAD', { cwd: testRepo })
      const headCommit = stdout.trim()

      const cli = new GitCli({ gitPath: 'git', timeoutMs: 5000 })

      // Create worktree
      const worktree = await createWorktreeImpl(cli, 'dsh-orchestrator/worktrees', {
        repoPath: testRepo,
        runId: 'test-run',
        stepId: 'test-step',
        attempt: 1,
        baseCommit: headCommit,
      })

      console.log('Worktree path returned:', worktree.path)

      // List worktrees to see what Git reports
      const { stdout: list } = await cli.exec(['worktree', 'list', '--porcelain', '-z'], testRepo)
      console.log('Git worktree list:', list)

      // Now try to inspect it
      const inspection = await inspectWorktreeImpl(cli, worktree.path)

      expect(inspection.exists).toBe(true)
      expect(inspection.headCommit).toBe(headCommit)
    } finally {
      // Cleanup
      try {
        await exec('git worktree prune', { cwd: testRepo })
      } catch {}
      await rm(testRepo, { recursive: true, force: true })
    }
  })
})
