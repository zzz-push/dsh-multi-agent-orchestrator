import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, rmdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GitCli } from './git-cli.js'
import {
  WorktreeCreationError,
  WorktreeNotFoundError,
  WorktreePathMismatchError,
} from './errors.js'
import { parseStatusPorcelain, parseWorktreeList } from './parsers.js'
import type {
  CreateWorktreeParams,
  Worktree,
  WorktreeInspection,
  ParsedWorktree,
} from './types.js'

export interface WorktreeOperationOptions {
  /**
   * Where attempt worktrees live. Either a relative path, resolved under
   * git-common-dir (the original layout), or an absolute directory, under
   * which each repository gets its own `<repoKey>/` subtree — see
   * {@link defaultWorktreeRoot} for why the absolute form is now the
   * driver's default.
   */
  worktreeRoot?: string
  /**
   * Known repository path. Optional in relative mode (it can be derived from
   * the worktree path's layout); **required** in absolute mode, where the
   * worktree path says nothing about which repository owns it and the safe
   * answer to "may I remove this?" without that knowledge is no.
   */
  repoPath?: string
}

/**
 * Default attempt-worktree root: `<os.tmpdir()>/dsh-orchestrator/worktrees`.
 *
 * The original default put worktrees *inside* git-common-dir
 * (`.git/dsh-orchestrator/worktrees/…`). That kept them out of the user's
 * working tree, which is still required — but a real run showed Claude Code
 * refuses to write anywhere under a `.git/` directory (it treats the whole
 * tree as sensitive), so an agent placed there could not edit a single file.
 * The OS temp directory keeps the "not in the working tree" property, is
 * not under `.git/`, and needs no `.gitignore` entry in the target repo.
 * Worktrees are ephemeral by design (`removeAttempt` runs in the Scheduler's
 * `finally`); what must outlive them — the candidate commit — is pinned by
 * ref inside the repository, not on this path.
 */
export function defaultWorktreeRoot(): string {
  return path.join(os.tmpdir(), 'dsh-orchestrator', 'worktrees')
}

/** Per-repository subdirectory under an absolute root, so two repos never share a worktree tree. */
export function repositoryKey(commonDir: string): string {
  return createHash('sha256').update(path.resolve(commonDir)).digest('hex').slice(0, 16)
}

type RootSpec = { kind: 'relative'; root: string } | { kind: 'absolute'; root: string }

/** The directory every worktree of `commonDir` must sit under, for a given root spec. */
async function expectedRootFor(spec: RootSpec, commonDir: string): Promise<string> {
  return spec.kind === 'absolute'
    ? canonicalize(path.join(spec.root, repositoryKey(commonDir)))
    : path.resolve(commonDir, spec.root)
}

/**
 * Resolve symlinks in the longest existing prefix of `target` and re-append
 * the rest. `realpath` alone throws for a path that does not exist yet (a
 * worktree about to be created), and comparing an un-resolved root against a
 * resolved child is exactly how macOS's `/var` → `/private/var` alias breaks
 * a containment check.
 */
async function canonicalize(target: string): Promise<string> {
  const absolute = path.resolve(target)
  const missing: string[] = []
  let cursor = absolute
  for (;;) {
    try {
      const resolved = await realpath(cursor)
      return missing.length === 0 ? resolved : path.join(resolved, ...missing.reverse())
    } catch {
      const parent = path.dirname(cursor)
      if (parent === cursor) return absolute
      missing.push(path.basename(cursor))
      cursor = parent
    }
  }
}

function validateId(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('\0') ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    throw new WorktreePathMismatchError(`Invalid ${label} for worktree path`, {
      details: { label, value },
    })
  }
}

function parseRoot(worktreeRoot: string): RootSpec {
  if (typeof worktreeRoot !== 'string' || worktreeRoot.length === 0 || worktreeRoot.includes('\0')) {
    throw new WorktreePathMismatchError(
      'Worktree root must be a non-empty path',
      { details: { worktreeRoot } },
    )
  }
  if (path.isAbsolute(worktreeRoot)) {
    const root = path.normalize(worktreeRoot)
    if (root === path.parse(root).root) {
      throw new WorktreePathMismatchError(
        'Worktree root must not be a filesystem root',
        { details: { worktreeRoot } },
      )
    }
    return { kind: 'absolute', root }
  }
  const normalized = path.normalize(worktreeRoot)
  if (normalized === '.' || normalized.startsWith(`..${path.sep}`) || normalized === '..') {
    throw new WorktreePathMismatchError(
      'Worktree root must remain under git-common-dir',
      { details: { worktreeRoot } },
    )
  }
  return { kind: 'relative', root: normalized }
}

/** Relative-mode root string, for the layout-derivation path that only makes sense there. */
function normalizeRoot(worktreeRoot: string): string {
  const spec = parseRoot(worktreeRoot)
  if (spec.kind === 'absolute') {
    throw new WorktreePathMismatchError(
      'An absolute worktree root cannot be derived from a worktree path; pass repoPath',
      { details: { worktreeRoot } },
    )
  }
  return spec.root
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/**
 * The administrative directory (`<common-dir>/worktrees/<id>`) the repository
 * keeps for the worktree at `worktreePath`, found through the repository's own
 * records (each entry's `gitdir` file names its worktree's `.git`) — never
 * through the worktree's `.git` file. An agent can rewrite that file to point
 * at a repository it built, whose config (`core.fsmonitor` and the like) git
 * would then run for whoever operates on the worktree next: the controller,
 * outside the agent's sandbox.
 * @throws {WorktreeNotFoundError} when the repository has no such worktree.
 */
export async function registeredGitDir(commonDir: string, worktreePath: string): Promise<string> {
  const common = await realpath(commonDir)
  const target = await realpath(worktreePath)
  const adminRoot = path.join(common, 'worktrees')
  const entries = await readdir(adminRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const adminDir = path.join(adminRoot, entry.name)
    const recorded = await readFile(path.join(adminDir, 'gitdir'), 'utf8').catch(() => undefined)
    if (recorded === undefined) continue
    // Absolute by default; relative to the admin dir under worktree.useRelativePaths.
    const dotGit = path.resolve(adminDir, recorded.trim())
    if (await realpath(path.dirname(dotGit)).catch(() => undefined) === target) return adminDir
  }
  throw new WorktreeNotFoundError('The repository has no administrative entry for this worktree', {
    details: { commonDir: common, worktreePath: target },
  })
}

async function resolveCommonDir(cli: GitCli, repoPath: string): Promise<string> {
  const raw = await cli.execLine(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    repoPath,
  )
  return realpath(path.resolve(repoPath, raw))
}

async function listWorktrees(
  cli: GitCli,
  repoPath: string,
): Promise<ParsedWorktree[]> {
  const result = await cli.exec(
    ['worktree', 'list', '--porcelain', '-z'],
    repoPath,
  )
  return parseWorktreeList(result.stdout)
}

function matchWorktree(
  worktrees: ParsedWorktree[],
  requestedPath: string,
): ParsedWorktree | undefined {
  return worktrees.find((worktree) => worktree.path === requestedPath)
}

/**
 * Create a detached worktree at the deterministic orchestrator path.
 *
 * `runId` and `stepId` are path components, not shell fragments; rejecting
 * separators and dot segments prevents attempts from escaping the common dir.
 * @throws {WorktreePathMismatchError} for unsafe path components.
 * @throws {WorktreeCreationError} when Git cannot create or resolve the tree.
 */
export async function createWorktreeImpl(
  cli: GitCli,
  worktreeRoot: string,
  params: CreateWorktreeParams,
): Promise<Worktree> {
  const repoPath = path.resolve(params.repoPath)
  validateId(params.runId, 'runId')
  validateId(params.stepId, 'stepId')
  if (!Number.isInteger(params.attempt) || params.attempt < 0) {
    throw new WorktreePathMismatchError('Attempt must be a non-negative integer', {
      details: { attempt: params.attempt },
    })
  }
  const spec = parseRoot(worktreeRoot)
  const commonDir = await resolveCommonDir(cli, repoPath)
  const expectedRoot = await expectedRootFor(spec, commonDir)
  const worktreePath = path.resolve(
    expectedRoot,
    params.runId,
    params.stepId,
    String(params.attempt),
  )
  if (!isWithin(expectedRoot, worktreePath)) {
    throw new WorktreePathMismatchError('Worktree path escaped the orchestrator root', {
      details: { worktreePath, expectedRoot },
    })
  }

  try {
    // `--detach` prevents branch movement and every value is one argv item.
    await cli.exec(
      ['worktree', 'add', '--detach', worktreePath, params.baseCommit],
      repoPath,
    )
  } catch (error) {
    throw new WorktreeCreationError('Failed to create worktree', {
      cause: error,
      details: { worktreePath, baseCommit: params.baseCommit },
    })
  }

  try {
    const actualPath = await realpath(worktreePath)
    return {
      path: actualPath,
      runId: params.runId,
      stepId: params.stepId,
      attempt: params.attempt,
      baseCommit: params.baseCommit,
      createdAt: Date.now(),
    }
  } catch (error) {
    throw new WorktreeCreationError('Git created a worktree that cannot be resolved', {
      cause: error,
      details: { worktreePath, baseCommit: params.baseCommit },
    })
  }
}

/**
 * Resolve, for one worktree path, the repository it belongs to and the root
 * it must sit under — the two facts every remove/inspect safety check needs.
 *
 * Relative root: the layout `<commonDir>/<root>/<run>/<step>/<attempt>` lets
 * the repository be derived from the path itself (`deriveRepositoryPath`),
 * and the lexical path is rebased onto the canonical common dir so a symlink
 * alias such as macOS `/var` still gets a canonical decision.
 *
 * Absolute root: nothing about the path identifies the repository, so
 * `options.repoPath` is mandatory; the expected root is that repository's
 * `<root>/<repoKey>/`, which also refuses a worktree that belongs to a
 * different repository under the same root.
 */
async function locateForRoot(
  cli: GitCli,
  worktreePath: string,
  worktreeRoot: string,
  options: WorktreeOperationOptions,
  purpose: 'remove' | 'inspect',
): Promise<{ absent: true } | { absent?: false; repoPath: string; expectedRoot: string; canonicalLexicalPath: string }> {
  const spec = parseRoot(worktreeRoot)
  const lexicalPath = path.resolve(worktreePath)
  if (spec.kind === 'absolute') {
    const canonicalLexicalPath = await canonicalize(lexicalPath)
    if (options.repoPath === undefined) {
      // Without a repository we cannot prove ownership of a path that exists.
      // A path under our root that does not exist is a different matter:
      // there is nothing to remove (idempotent) and nothing to inspect.
      if (!isWithin(await canonicalize(spec.root), canonicalLexicalPath)) {
        throw new WorktreePathMismatchError('Worktree path is outside orchestrator root', {
          details: { path: worktreePath, worktreeRoot },
        })
      }
      try {
        await realpath(lexicalPath)
      } catch {
        if (purpose === 'inspect') {
          throw new WorktreeNotFoundError('Worktree not found', { details: { path: worktreePath } })
        }
        return { absent: true }
      }
      throw new WorktreePathMismatchError(
        `Cannot ${purpose} a worktree under an absolute root without repoPath`,
        { details: { path: worktreePath, worktreeRoot } },
      )
    }
    const repoPath = path.resolve(options.repoPath)
    let commonDir: string
    try {
      commonDir = await resolveCommonDir(cli, repoPath)
    } catch (error) {
      throw unverifiable(purpose, error, { path: worktreePath, repoPath })
    }
    return { repoPath, expectedRoot: await expectedRootFor(spec, commonDir), canonicalLexicalPath }
  }
  const derived = deriveRepositoryPath(worktreePath, worktreeRoot)
  const repoPath = path.resolve(options.repoPath ?? derived.repoPath)
  let commonDir: string
  try {
    commonDir = await resolveCommonDir(cli, repoPath)
  } catch (error) {
    // A path that cannot be tied back to a live Git common dir is not safe to
    // treat as an idempotent deletion target.
    throw unverifiable(purpose, error, { path: worktreePath, commonDir: derived.commonDir })
  }
  const expectedRoot = path.resolve(commonDir, spec.root)
  const derivedRoot = path.resolve(derived.commonDir, spec.root)
  return {
    repoPath,
    expectedRoot,
    canonicalLexicalPath: path.resolve(expectedRoot, path.relative(derivedRoot, lexicalPath)),
  }
}

/** Inspect reports an unverifiable repository as "not found"; remove refuses to guess. */
function unverifiable(purpose: 'remove' | 'inspect', cause: unknown, details: Record<string, unknown>): Error {
  return purpose === 'inspect'
    ? new WorktreeNotFoundError('Worktree not found', { cause, details })
    : new WorktreePathMismatchError('Cannot verify worktree common dir', { cause, details })
}

function deriveRepositoryPath(
  worktreePath: string,
  worktreeRoot: string,
): { commonDir: string; repoPath: string } {
  const normalizedPath = path.resolve(worktreePath)
  const root = normalizeRoot(worktreeRoot)
  const rootParts = root.split(path.sep).filter(Boolean)
  const parts = normalizedPath.split(path.sep).filter(Boolean)
  const start = parts.length - rootParts.length - 3
  if (start < 1 || rootParts.some((part, index) => parts[start + index] !== part)) {
    throw new WorktreePathMismatchError(
      'Worktree path is not inside the configured orchestrator root',
      { details: { path: worktreePath, worktreeRoot } },
    )
  }
  const commonParts = parts.slice(0, start)
  const commonDir = `${path.parse(normalizedPath).root}${commonParts.join(path.sep)}`
  if (!isWithin(path.resolve(commonDir, root), normalizedPath)) {
    throw new WorktreePathMismatchError('Worktree path does not match expected layout', {
      details: { path: worktreePath, worktreeRoot },
    })
  }
  return { commonDir, repoPath: path.dirname(commonDir) }
}

/**
 * Remove an orchestrator worktree. Missing worktrees are intentionally treated
 * as success, but an untrusted path is rejected before any Git command runs.
 * @throws {WorktreePathMismatchError} when the path cannot be proven safe.
 */
export async function removeWorktreeImpl(
  cli: GitCli,
  worktreePath: string,
  options: WorktreeOperationOptions = {},
): Promise<void> {
  const worktreeRoot = options.worktreeRoot ?? 'dsh-orchestrator/worktrees'
  const located = await locateForRoot(cli, worktreePath, worktreeRoot, options, 'remove')
  if (located.absent === true) return
  const { repoPath, expectedRoot } = located
  const lexicalPath = path.resolve(worktreePath)
  if (!isWithin(expectedRoot, located.canonicalLexicalPath)) {
    throw new WorktreePathMismatchError('Worktree path is outside orchestrator root', {
      details: { path: worktreePath, expectedRoot },
    })
  }

  let worktrees: ParsedWorktree[]
  try {
    worktrees = await listWorktrees(cli, repoPath)
  } catch (error) {
    // A deleted repository cannot contain a live worktree; retain idempotence
    // only for an already-absent target and surface other command failures.
    const stderr = (error as { details?: { stderr?: string } })?.details?.stderr ?? ''
    if (/not a git repository|no such file/i.test(stderr)) return
    throw error
  }

  let requestedPath = lexicalPath
  let found = matchWorktree(worktrees, requestedPath)
  if (found === undefined) {
    try {
      requestedPath = await realpath(lexicalPath)
      if (!isWithin(expectedRoot, requestedPath)) {
        throw new WorktreePathMismatchError(
          'Resolved worktree path is outside orchestrator root',
          { details: { path: worktreePath, resolvedPath: requestedPath, expectedRoot } },
        )
      }
      found = matchWorktree(worktrees, requestedPath)
    } catch (error) {
      if (error instanceof WorktreePathMismatchError) throw error
      // The target has already been removed. This is the idempotent case.
      return
    }
  }
  if (found === undefined) return

  try {
    await cli.exec(
      ['worktree', 'remove', '--force', found.path],
      repoPath,
    )
  } catch (error) {
    const stderr = (error as { details?: { stderr?: string } })?.details?.stderr ?? ''
    if (/not a working tree|no such file|does not exist/i.test(stderr)) return
    throw error
  }
  // `git worktree remove` deletes the leaf only; under an absolute root the
  // `<repoKey>/<run>/<step>` husks would otherwise accumulate in the temp dir.
  await pruneEmptyParents(path.dirname(found.path), path.dirname(expectedRoot))
}

/** Remove empty directories from `from` upwards, stopping before `stopAt`. Best effort. */
async function pruneEmptyParents(from: string, stopAt: string): Promise<void> {
  let cursor = path.resolve(from)
  const limit = path.resolve(stopAt)
  while (isWithin(limit, cursor)) {
    try {
      await rmdir(cursor)
    } catch {
      return
    }
    cursor = path.dirname(cursor)
  }
}

/**
 * Inspect a worktree by consulting Git's canonical worktree registry and then
 * checking its current status using porcelain-v2/NUL output.
 * @throws {WorktreeNotFoundError} when Git has no matching worktree.
 * @throws {WorktreePathMismatchError} when the resolved path escapes the root.
 */
export async function inspectWorktreeImpl(
  cli: GitCli,
  worktreePath: string,
  options: WorktreeOperationOptions = {},
): Promise<WorktreeInspection> {
  const worktreeRoot = options.worktreeRoot ?? 'dsh-orchestrator/worktrees'
  const located = await locateForRoot(cli, worktreePath, worktreeRoot, options, 'inspect')
  if (located.absent === true) throw new WorktreeNotFoundError('Worktree not found', { details: { path: worktreePath } })
  const { repoPath, expectedRoot } = located
  let worktrees: ParsedWorktree[]
  try {
    worktrees = await listWorktrees(cli, repoPath)
  } catch (error) {
    throw new WorktreeNotFoundError('Worktree not found', {
      cause: error,
      details: { path: worktreePath },
    })
  }

  const lexicalPath = path.resolve(worktreePath)
  let canonicalPath = lexicalPath
  try {
    canonicalPath = await realpath(lexicalPath)
  } catch {
    // Keep a canonicalized layout path so a stale Git registry entry still
    // produces WorktreeNotFoundError even when the caller used a symlink alias.
    canonicalPath = located.canonicalLexicalPath
  }
  if (!isWithin(expectedRoot, canonicalPath)) {
    throw new WorktreePathMismatchError(
      'Resolved worktree path is outside orchestrator root',
      { details: { path: worktreePath, resolvedPath: canonicalPath, expectedRoot } },
    )
  }
  const found =
    matchWorktree(worktrees, canonicalPath) ?? matchWorktree(worktrees, lexicalPath)
  if (found === undefined) {
    throw new WorktreeNotFoundError('Worktree not found', {
      details: { path: worktreePath, availableWorktrees: worktrees.map((w) => w.path) },
    })
  }
  try {
    await realpath(found.path)
  } catch (error) {
    throw new WorktreeNotFoundError('Worktree path is no longer present', {
      cause: error,
      details: { path: worktreePath, registeredPath: found.path },
    })
  }

  const status = await cli.exec(
    ['status', '--porcelain=v2', '-z', '--untracked-files=all'],
    found.path,
  )
  const parsed = parseStatusPorcelain(status.stdout)
  const changedPaths = [...new Set([...parsed.staged, ...parsed.unstaged, ...parsed.untracked])]
  return {
    path: canonicalPath,
    exists: true,
    hasUncommittedChanges: changedPaths.length > 0,
    headCommit: found.commit,
    repoPath: await cli.execLine(['rev-parse', '--show-toplevel'], found.path),
    changedPaths,
  }
}

export type {
  CreateWorktreeParams,
  Worktree,
  WorktreeInspection,
} from './types.js'
