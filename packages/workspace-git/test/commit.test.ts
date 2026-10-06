import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GitWorkspaceDriver } from '../src/driver.js'
import { createCommitImpl } from '../src/commit-ops.js'
import { candidateRef } from '../src/driver.js'
import { GitCli } from '../src/git-cli.js'
import { CommitCreationError, WorktreeNotFoundError } from '../src/errors.js'
import {
  cleanupTempRepo,
  createTempGitRepoWithContent,
} from './fixtures/test-repo.js'

describe('candidate commits and merge integration', () => {
  let repoPath: string
  let headCommit: string

  beforeEach(async () => {
    const [repo, commit] = await createTempGitRepoWithContent()
    repoPath = await realpath(repo)
    headCommit = commit
  })

  afterEach(async () => {
    await cleanupTempRepo(repoPath)
  })

  it('creates a candidate with a temporary index and preserves the worktree index', async () => {
    const driver = new GitWorkspaceDriver()
    const snapshot = await driver.inspectRepository(repoPath)
    const workspace = await driver.createAttempt({
      runId: 'commit-run',
      stepId: 'commit-step',
      attempt: 1,
      inputCommit: headCommit,
      repository: snapshot,
    })
    await writeFile(join(workspace.worktreePath!, 'candidate.txt'), 'candidate\n')

    const result = await driver.createCommit({
      worktreePath: workspace.worktreePath!,
      message: 'candidate commit',
      author: { name: 'Test Author', email: 'author@example.com' },
      preserveWorktree: true,
    })
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(result.treeSha).toMatch(/^[0-9a-f]{40}$/)
    expect(result.parentCommit).toBe(headCommit)
    expect(result.changedPaths).toContain('candidate.txt')
    expect(result.diffHash).toMatch(/^[0-9a-f]{64}$/)

    // The normal index is not used by the candidate snapshot.
    const inspection = await driver.inspectWorktree(workspace.worktreePath!)
    expect(inspection.hasUncommittedChanges).toBe(true)

    const finalized = await driver.createCommit({
      worktreePath: workspace.worktreePath!,
      message: 'finalize candidate',
    })
    expect(finalized.sha).toMatch(/^[0-9a-f]{40}$/)
    const cleanInspection = await driver.inspectWorktree(workspace.worktreePath!)
    expect(cleanInspection.hasUncommittedChanges).toBe(false)
    await driver.removeAttempt(workspace.workspaceId)
  })

  it('captures and merges a candidate with an integration-ref CAS', async () => {
    const driver = new GitWorkspaceDriver()
    const snapshot = await driver.inspectRepository(repoPath)
    const workspace = await driver.createAttempt({
      runId: 'merge-run',
      stepId: 'merge-step',
      attempt: 1,
      inputCommit: headCommit,
      repository: snapshot,
    })
    await writeFile(join(workspace.worktreePath!, 'merged.txt'), 'merged\n')

    const captured = await driver.captureResult({
      runId: 'merge-run',
      stepId: 'merge-step',
      attempt: 1,
      workspaceId: workspace.workspaceId,
    })
    expect(captured.resultCommit).toMatch(/^[0-9a-f]{40}$/)
    // The candidate is pinned under a ref, so it survives worktree removal and gc.
    const pinned = await new GitCli({ gitPath: 'git', timeoutMs: 5000 })
      .execLine(['rev-parse', candidateRef('merge-run', 'merge-step', 1)], repoPath)
    expect(pinned).toBe(captured.resultCommit)

    const merged = await driver.mergeResult({
      runId: 'merge-run',
      stepId: 'merge-step',
      resultCommit: captured.resultCommit!,
      integrationRef: 'refs/dsh-orchestrator/runs/merge-run/integration',
      expectedIntegrationCommit: headCommit,
    })
    expect(merged.merged).toBe(true)
    expect(merged.integrationCommit).toMatch(/^[0-9a-f]{40}$/)
    await driver.removeAttempt(workspace.workspaceId)
  })

  it('normalises ref-illegal id edges when pinning candidates', () => {
    expect(candidateRef('run-1', 'step-a', 2)).toBe('refs/dsh-orchestrator/runs/run-1/candidates/step-a/2')
    expect(candidateRef('.hidden', 'build.lock', 1)).toBe('refs/dsh-orchestrator/runs/_hidden/candidates/build_lock/1')
  })

  it('rejects a candidate commit whose parentCommit no longer matches worktree HEAD', async () => {
    const driver = new GitWorkspaceDriver()
    const snapshot = await driver.inspectRepository(repoPath)
    const workspace = await driver.createAttempt({
      runId: 'stale-parent-run',
      stepId: 'stale-parent-step',
      attempt: 1,
      inputCommit: headCommit,
      repository: snapshot,
    })

    await expect(
      createCommitImpl(new GitCli({ gitPath: 'git', timeoutMs: 5000 }), {
        worktreePath: workspace.worktreePath!,
        message: 'stale parent',
        parentCommit: '0000000000000000000000000000000000000000',
      }),
    ).rejects.toThrow(CommitCreationError)

    await driver.removeAttempt(workspace.workspaceId)
  })

  it('fails closed for unknown workspaces and candidate paths', async () => {
    const driver = new GitWorkspaceDriver()
    await expect(
      driver.captureResult({
        runId: 'missing',
        stepId: 'missing',
        attempt: 1,
        workspaceId: 'missing-workspace',
      }),
    ).rejects.toThrow(WorktreeNotFoundError)
    await expect(
      createCommitImpl(new GitCli({ gitPath: 'git', timeoutMs: 1000 }), {
        worktreePath: '/missing-worktree',
        message: 'invalid',
      }),
    ).rejects.toThrow(CommitCreationError)
  })
})
