import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import {
  AgentManager,
  AgentManagerExecutor,
  FileRoleProvider,
  type Channel,
  type EvaluationContext,
  type JournalLogger,
} from '@dsh/agent-manager'
import { FileRunRepository, Scheduler, createRunAggregate, type AgentExecutor, type RunAggregate } from '@dsh/core'
import { CommandVerificationDriver, GitCli, GitWorkspaceDriver, candidateRef } from '@dsh/workspace-git'

import type { ArmRecord } from './comparison.js'
import { collectJournalMetrics } from './journal-metrics.js'
import { ContextHidingWorkspaceDriver, ContextRestoringExecutor, HarnessContextHider } from './hidden-context.js'
import { CONTROLLER_ENV, PreparedWorkspaceDriver } from './prepared-workspace.js'
import type { ResolvedRoleSource } from './role-source.js'
import { scoreCandidate } from './score-candidate.js'
import type { TaskManifest } from './task-manifest.js'

export interface RunArmOptions {
  label: string
  /** `baseCommit` must already be a full sha the repository can resolve. */
  manifest: TaskManifest
  source: ResolvedRoleSource
  /** A clean repository root (the comparison's temp clone). */
  repoRoot: string
  /** Where this arm's journal and run documents go. */
  outDir: string
  channels: readonly Channel[]
  gitPath?: string
  logger?: JournalLogger
  /**
   * Advertise the arm to DSH pages (the "评估中" group) with this context, or
   * `false` to keep it private. The arm is observe-only either way: only this
   * process drives it. Directories default to the shared per-user ones.
   */
  advertise?: false | { evaluation: EvaluationContext; registryDir?: string; controlSocketDir?: string }
  /** Deterministic ids for tests. */
  runId?: string
  now?: () => number
}

/**
 * Run one arm of a comparison through the governed pipeline:
 *
 *   worktree from `baseCommit` → the manifest's setup commands run in it →
 *   the role gets the instructions as one chat turn → the manifest's checks
 *   run in the worktree → the candidate is captured (and pinned under a
 *   ref) → the Run is persisted.
 *
 * Nothing here is specific to comparisons — it is exactly what
 * `startWorkflow()` would do for a one-step workflow — except that every
 * arm gets its own `AgentManager`, journal and role directory, so two arms
 * can never read each other's role or write into each other's history.
 */
export async function runArm(options: RunArmOptions): Promise<ArmRecord> {
  const { label, manifest, source } = options
  await mkdir(options.outDir, { recursive: true })
  const journalFile = path.join(options.outDir, `${label}-events.jsonl`)
  const runsDir = path.join(options.outDir, 'runs')
  const base: Pick<ArmRecord, 'label' | 'roleId' | 'roleVersion' | 'roleHash' | 'projectLayerHash' | 'roleSource' | 'journalFile' | 'runsDir'> & { roleSourceCommit?: string } = {
    label,
    roleId: source.role.roleId,
    roleVersion: source.role.version,
    roleHash: source.roleHash,
    ...(source.projectLayerHash === undefined ? {} : { projectLayerHash: source.projectLayerHash }),
    roleSource: source.label,
    ...(source.commit === undefined ? {} : { roleSourceCommit: source.commit }),
    journalFile,
    runsDir,
  }

  const manager = new AgentManager({
    roleProvider: new FileRoleProvider({ rolesDir: source.rolesDir, logger: options.logger }),
    journalFile,
    cwd: options.repoRoot,
    channels: options.channels,
    logger: options.logger,
    // Advertised by default so a DSH page bound to the project shows the arm
    // live in its "评估中" group; the evaluation context also makes the arm
    // observe-only for every other process.
    ...(options.advertise === undefined || options.advertise === false
      ? { liveAgentRegistryDir: false as const }
      : {
          evaluation: options.advertise.evaluation,
          ...(options.advertise.registryDir === undefined ? {} : { liveAgentRegistryDir: options.advertise.registryDir }),
          ...(options.advertise.controlSocketDir === undefined ? {} : { controlSocketDir: options.advertise.controlSocketDir }),
        }),
  })
  try {
    const repository = new FileRunRepository({ dir: runsDir })
    const gitDriver = new GitWorkspaceDriver(options.gitPath === undefined ? {} : { gitPath: options.gitPath })
    const preparedDriver = manifest.setup === undefined || manifest.setup.length === 0
      ? gitDriver
      : new PreparedWorkspaceDriver(gitDriver, manifest.setup)
    // `hide` takes the project's harness instructions out for the
    // agent's turn only; setup runs before, checks and capture after.
    const hider = manifest.harnessContext === 'hide' ? new HarnessContextHider(options.gitPath === undefined ? {} : { gitPath: options.gitPath }) : undefined
    const workspaceDriver = hider === undefined ? preparedDriver : new ContextHidingWorkspaceDriver(preparedDriver, hider)
    const snapshot = await gitDriver.inspectRepository(options.repoRoot)
    const scheduler = new Scheduler({
      repository,
      workspaceDriver,
      verificationDriver: new CommandVerificationDriver({ commands: manifest.checks, env: { ...CONTROLLER_ENV } }),
      // The manifest's budget is the turn's budget for every arm, overriding
      // whatever each role declares — same clock, or the comparison is unfair.
      // The executor's outer cap sits a minute behind so the turn timeout is
      // the one that fires and the record names it.
      agentExecutor: withContextRestore(new AgentManagerExecutor(manager, manifest.timeoutMs === undefined
        ? {}
        : { turnTimeoutMs: manifest.timeoutMs, maxWaitMs: manifest.timeoutMs + 60_000 }), hider),
      globalMaxParallel: 1,
    })
    const now = options.now ?? Date.now
    const cli = new GitCli({ gitPath: options.gitPath ?? 'git', timeoutMs: 120_000 })
    const run = createRunAggregate({
      id: options.runId ?? `${manifest.id}-${label}-${now()}`,
      workflowId: `role-eval:${manifest.id}`,
      initiator: { kind: 'ui' },
      repository: { root: snapshot.root, gitCommonDir: snapshot.gitCommonDir, baseCommit: manifest.baseCommit },
      steps: [{
        id: manifest.id,
        metadata: {
          role: manifest.role,
          instructions: manifest.instructions,
          ...(manifest.sandbox === undefined ? {} : { sandbox: manifest.sandbox }),
          ...(manifest.harness === undefined ? {} : { harness: manifest.harness }),
        },
      }],
      now: now(),
    })
    await repository.create(run)
    const result = await scheduler.run(run.id)
    const record = await describeRun(base, result, manifest.id, journalFile)
    const worktree = result.steps[manifest.id]?.attempts.at(-1)?.worktreePath
    const hiddenContext = hider === undefined || worktree === undefined ? undefined : await hider.restore(worktree)
    if (hiddenContext !== undefined) record.hiddenContext = hiddenContext
    // The candidate exists whether the step merged or failed: a cut-off turn
    // still has its worktree captured and pinned. Resolve it from the ref so
    // an arm that did the work but never reported can still be scored.
    const attempts = result.steps[manifest.id]?.attempts.length ?? 0
    const commit = attempts === 0
      ? undefined
      : await cli.execLine(['rev-parse', '--verify', `${candidateRef(run.id, manifest.id, attempts)}^{commit}`], options.repoRoot)
        .catch(() => undefined)
    if (commit !== undefined) record.candidateCommit = commit
    if (manifest.hiddenChecks !== undefined && manifest.hiddenChecks.length > 0) {
      record.hidden = commit === undefined
        ? { commit: '', passed: 0, total: manifest.hiddenChecks.length, checks: [], error: 'no candidate commit was captured for this attempt' }
        : await scoreCandidate({
          repoPath: options.repoRoot,
          commit,
          checks: manifest.hiddenChecks,
          ...(manifest.setup === undefined ? {} : { setup: manifest.setup }),
          ...(manifest.hiddenFilesDir === undefined ? {} : { hiddenFilesDir: manifest.hiddenFilesDir }),
          ...(options.gitPath === undefined ? {} : { gitPath: options.gitPath }),
        })
    }
    return record
  } catch (error) {
    return {
      ...base,
      runId: '',
      runStatus: 'not_started',
      step: { status: 'not_started', attempts: 0 },
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await manager.dispose()
  }
}

async function describeRun(
  base: Pick<ArmRecord, 'label' | 'roleId' | 'roleVersion' | 'roleHash' | 'projectLayerHash' | 'roleSource' | 'journalFile' | 'runsDir'> & { roleSourceCommit?: string },
  run: RunAggregate,
  stepId: string,
  journalFile: string,
): Promise<ArmRecord> {
  const step = run.steps[stepId]
  const attempt = step?.attempts[step.attempts.length - 1]
  const completion = attempt?.completions[attempt.completions.length - 1]?.value
  const agentId = typeof completion?.agentId === 'string' ? completion.agentId : undefined
  const record: ArmRecord = {
    ...base,
    runId: run.id,
    runStatus: run.status,
    step: {
      status: step?.status ?? 'missing',
      attempts: step?.attempts.length ?? 0,
      ...(step?.failure === undefined ? {} : { failure: { code: String(step.failure.code), message: step.failure.message } }),
    },
  }
  if (attempt !== undefined) {
    const verification = completion?.verification as { passed: boolean; failedRules: number; totalRules: number } | undefined
    record.attempt = {
      ...(agentId === undefined ? {} : { agentId }),
      ...(completion?.outcome === undefined ? {} : { outcome: completion.outcome }),
      ...(typeof completion?.error === 'string' ? { error: completion.error } : {}),
      ...(typeof completion?.summary === 'string' ? { summary: completion.summary } : {}),
      ...(typeof completion?.model === 'string' ? { model: completion.model } : {}),
      ...(typeof completion?.toolCalls === 'number' ? { toolCalls: completion.toolCalls } : {}),
      ...(verification === undefined ? {} : { verification }),
      ...(attempt.evidence === undefined ? {} : { evidence: attempt.evidence }),
      ...(attempt.resultCommit === undefined ? {} : { resultCommit: attempt.resultCommit }),
      ...(attempt.startedAt === undefined ? {} : { startedAt: attempt.startedAt }),
      ...(attempt.finishedAt === undefined ? {} : { finishedAt: attempt.finishedAt }),
      ...(attempt.startedAt === undefined || attempt.finishedAt === undefined ? {} : { durationMs: attempt.finishedAt - attempt.startedAt }),
    }
  }
  if (agentId !== undefined) {
    record.journal = await collectJournalMetrics(journalFile, agentId)
  }
  return record
}

function withContextRestore(executor: AgentExecutor, hider: HarnessContextHider | undefined): AgentExecutor {
  return hider === undefined ? executor : new ContextRestoringExecutor(executor, hider)
}
