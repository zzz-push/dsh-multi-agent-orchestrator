import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GitWorkspaceDriver } from '../src/driver.js'
import { WorktreeNotFoundError, WorktreePathMismatchError } from '../src/errors.js'
import { GitCli } from '../src/git-cli.js'
import {
  createWorktreeImpl,
  defaultWorktreeRoot,
  inspectWorktreeImpl,
  removeWorktreeImpl,
  repositoryKey,
} from '../src/worktree-ops.js'
import { cleanupTempRepo, createTempGitRepoWithContent } from './fixtures/test-repo.js'

describe('absolute worktree root (the default since Claude Code refuses to write under .git/)', () => {
  let cli: GitCli
  let repo: string
  let head: string
  let root: string

  beforeEach(async () => {
    cli = new GitCli({ gitPath: 'git', timeoutMs: 5000 })
    const [created, commit] = await createTempGitRepoWithContent()
    repo = await realpath(created)
    head = commit
    root = await mkdtemp(path.join(tmpdir(), 'dsh-abs-root-'))
  })
  afterEach(async () => {
    await cleanupTempRepo(repo)
    await rm(root, { recursive: true, force: true })
  })

  it('creates worktrees under <root>/<repoKey>/<run>/<step>/<attempt>, outside the repository and outside .git', async () => {
    const worktree = await createWorktreeImpl(cli, root, { repoPath: repo, runId: 'r', stepId: 's', attempt: 1, baseCommit: head })
    const commonDir = await cli.execLine(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo)
    const expected = path.join(await realpath(root), repositoryKey(await realpath(commonDir)), 'r', 's', '1')
    expect(worktree.path).toBe(expected)
    expect(worktree.path.includes(`${path.sep}.git${path.sep}`)).toBe(false)
    expect(path.relative(repo, worktree.path).startsWith('..')).toBe(true)
    await expect(stat(path.join(worktree.path, 'test.txt'))).resolves.toBeTruthy()
    // Inspect and remove work with the owning repository named.
    expect((await inspectWorktreeImpl(cli, worktree.path, { worktreeRoot: root, repoPath: repo })).hasUncommittedChanges).toBe(false)
    await removeWorktreeImpl(cli, worktree.path, { worktreeRoot: root, repoPath: repo })
    await expect(stat(worktree.path)).rejects.toMatchObject({ code: 'ENOENT' })
    // The <repoKey>/<run>/<step> husks are pruned too; the root itself stays.
    await expect(stat(path.dirname(expected))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(await realpath(root), repositoryKey(await realpath(commonDir))))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(root)).resolves.toBeTruthy()
  })

  it('keeps two repositories apart under one root, and refuses to touch one repo’s worktree through the other', async () => {
    const [otherCreated, otherHead] = await createTempGitRepoWithContent()
    const other = await realpath(otherCreated)
    try {
      const a = await createWorktreeImpl(cli, root, { repoPath: repo, runId: 'same', stepId: 's', attempt: 1, baseCommit: head })
      const b = await createWorktreeImpl(cli, root, { repoPath: other, runId: 'same', stepId: 's', attempt: 1, baseCommit: otherHead })
      expect(a.path).not.toBe(b.path)
      // Same run/step/attempt ids, different repositories: the repoKey segment differs.
      const canonicalRoot = await realpath(root)
      expect(path.relative(canonicalRoot, a.path).split(path.sep)[0]).not.toBe(path.relative(canonicalRoot, b.path).split(path.sep)[0])
      await expect(removeWorktreeImpl(cli, a.path, { worktreeRoot: root, repoPath: other })).rejects.toThrow(WorktreePathMismatchError)
      await expect(stat(a.path)).resolves.toBeTruthy()
      await removeWorktreeImpl(cli, a.path, { worktreeRoot: root, repoPath: repo })
      await removeWorktreeImpl(cli, b.path, { worktreeRoot: root, repoPath: other })
    } finally {
      await cleanupTempRepo(other)
    }
  })

  it('without repoPath: a missing path under the root is a no-op remove / not-found inspect, an existing one is refused, an outside one is rejected', async () => {
    const worktree = await createWorktreeImpl(cli, root, { repoPath: repo, runId: 'r', stepId: 's', attempt: 1, baseCommit: head })
    await expect(removeWorktreeImpl(cli, worktree.path, { worktreeRoot: root })).rejects.toThrow('without repoPath')
    await expect(stat(worktree.path)).resolves.toBeTruthy()
    const gone = path.join(root, 'nope', 'r', 's', '9')
    await expect(removeWorktreeImpl(cli, gone, { worktreeRoot: root })).resolves.toBeUndefined()
    await expect(inspectWorktreeImpl(cli, gone, { worktreeRoot: root })).rejects.toThrow(WorktreeNotFoundError)
    await expect(removeWorktreeImpl(cli, '/tmp/somewhere-else', { worktreeRoot: root })).rejects.toThrow(WorktreePathMismatchError)
    await removeWorktreeImpl(cli, worktree.path, { worktreeRoot: root, repoPath: repo })
  })

  it('rejects a filesystem root as the worktree root', async () => {
    await expect(createWorktreeImpl(cli, path.parse(root).root, { repoPath: repo, runId: 'r', stepId: 's', attempt: 1, baseCommit: head }))
      .rejects.toThrow('filesystem root')
  })

  it('is what GitWorkspaceDriver uses by default, and the driver remembers the owner so its own public API needs no repoPath', async () => {
    expect(defaultWorktreeRoot()).toBe(path.join(tmpdir(), 'dsh-orchestrator', 'worktrees'))
    const driver = new GitWorkspaceDriver()
    const snapshot = await driver.inspectRepository(repo)
    const workspace = await driver.createAttempt({ runId: 'drv', stepId: 's', attempt: 1, inputCommit: head, repository: snapshot })
    expect(workspace.worktreePath!.startsWith(await realpath(defaultWorktreeRoot()).catch(() => defaultWorktreeRoot()))).toBe(true)
    expect(workspace.worktreePath!.includes(`${path.sep}.git${path.sep}`)).toBe(false)
    expect((await driver.inspectWorktree(workspace.worktreePath!)).hasUncommittedChanges).toBe(false)
    await driver.removeAttempt(workspace.worktreePath!)
    await driver.removeAttempt(workspace.workspaceId)
    await expect(driver.inspectWorktree(workspace.worktreePath!)).rejects.toThrow(WorktreeNotFoundError)
  })
})
