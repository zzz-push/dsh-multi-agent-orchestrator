import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { VerificationEvidence } from '@dsh/core'
import { CommandVerificationDriver, GitCli, type VerificationCommand } from '@dsh/workspace-git'

import { CONTROLLER_ENV } from './prepared-workspace.js'

/** Result of scoring one candidate commit against the hidden checks. */
export interface CandidateScore {
  /** Commit the checks ran against. */
  commit: string
  passed: number
  total: number
  checks: NonNullable<VerificationEvidence['checks']>
  /** Set when the score could not be produced at all (no commit, worktree failure). */
  error?: string
}

export interface ScoreCandidateOptions {
  /** Repository holding the candidate commit (the arm's own private repository). */
  repoPath: string
  /** Commit to score — the candidate captured from the attempt's worktree. */
  commit: string
  /** Directory whose contents are copied over the checkout before the checks run. */
  hiddenFilesDir?: string
  /** Preparation commands (the manifest's `setup`), needed again in this fresh checkout. */
  setup?: readonly VerificationCommand[]
  /** The hidden checks themselves. */
  checks: readonly VerificationCommand[]
  gitPath?: string
}

/**
 * Run the hidden acceptance checks against a candidate commit.
 *
 * The visible checks in a manifest are a *gate*: the agent can read them,
 * and `pnpm test` runs the agent's own tests, so passing proves "the tests
 * it wrote pass", not "it did what was asked". The hidden checks are the
 * *score*: written by the manifest author against the task's observable
 * contract, never present in the repository the agent works in, and staged
 * in only here.
 *
 * They deliberately run in a throwaway worktree checked out at the
 * candidate commit rather than in the attempt's own worktree:
 *
 * - staging test files into the attempt's worktree would put them in the
 *   candidate commit, i.e. the evaluator would be editing the thing it
 *   evaluates;
 * - the candidate commit exists even when the attempt failed — a turn cut
 *   off by a timeout still has its worktree captured and pinned — so an
 *   arm that did the work but never got to report it can still be scored.
 *   Before this, such an arm had to be checked by hand.
 */
export async function scoreCandidate(options: ScoreCandidateOptions): Promise<CandidateScore> {
  const cli = new GitCli({ gitPath: options.gitPath ?? 'git', timeoutMs: 120_000 })
  const base: CandidateScore = { commit: options.commit, passed: 0, total: options.checks.length, checks: [] }
  if (options.checks.length === 0) return base

  const root = await mkdtemp(path.join(tmpdir(), 'dsh-role-eval-score-'))
  const worktree = path.join(root, 'scoring')
  try {
    await cli.exec(['worktree', 'add', '--detach', '--quiet', worktree, options.commit], options.repoPath)
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    return { ...base, error: `could not check out ${options.commit}: ${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    if (options.setup !== undefined && options.setup.length > 0) {
      const prepared = await run(options.setup, worktree)
      if (!prepared.passed) {
        return { ...base, checks: prepared.checks, error: `setup failed in the scoring worktree: ${prepared.failureMessage ?? 'unknown error'}` }
      }
    }
    if (options.hiddenFilesDir !== undefined) {
      await cp(options.hiddenFilesDir, worktree, { recursive: true })
    }
    const outcome = await run(options.checks, worktree)
    return {
      ...base,
      checks: outcome.checks,
      passed: outcome.checks.filter((check) => check.exitCode === 0).length,
    }
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) }
  } finally {
    await cli.exec(['worktree', 'remove', '--force', worktree], options.repoPath).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
}

async function run(
  commands: readonly VerificationCommand[],
  worktreePath: string,
): Promise<{ passed: boolean; failureMessage?: string; checks: NonNullable<VerificationEvidence['checks']> }> {
  const driver = new CommandVerificationDriver({ commands, env: { ...CONTROLLER_ENV } })
  const result = await driver.run({ runId: 'score', stepId: 'score', attempt: 1, worktreePath })
  return {
    passed: result.passed,
    ...(result.failureMessage === undefined ? {} : { failureMessage: result.failureMessage }),
    checks: result.evidence?.checks ?? [],
  }
}
