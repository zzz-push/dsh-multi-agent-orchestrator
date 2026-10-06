import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { Channel, JournalLogger } from '@dsh/agent-manager'
import { GitCli } from '@dsh/workspace-git'

import { deriveNotes, deriveScorecard, deriveVerdict, renderComparisonMarkdown, type ArmRecord, type ComparisonRecord } from './comparison.js'
import { resolveRoleSource, type RoleSourceSpec } from './role-source.js'
import { runArm } from './run-arm.js'
import { randomSeed, seededShuffle } from './seeded-shuffle.js'
import type { TaskManifest } from './task-manifest.js'

export interface CompareArmSpec {
  label: string
  source: RoleSourceSpec
}

export interface CompareRolesOptions {
  manifest: TaskManifest
  arms: readonly CompareArmSpec[]
  /** The real repository: role refs are read from it and candidate refs are fetched back into it. */
  repoRoot: string
  /** Where the record, journals and run documents are written. Default: `<repoRoot>/.dsh/runtime/comparisons/<id>`. */
  outDir?: string
  channels: readonly Channel[]
  gitPath?: string
  logger?: JournalLogger
  /** Keep the temp clone after the run (for debugging). Default: delete it. */
  keepClone?: boolean
  /** Deterministic ids for tests. */
  id?: string
  now?: () => number
  /**
   * Order the arms run in. `random` (default) shuffles them with `orderSeed`
   * (comparison guidance: a fixed order puts provider load, quota and time of day on the
   * same arm every time); `as-given` runs them as listed. Either way the
   * record lists the arms as given, and says how they were ordered.
   */
  order?: 'random' | 'as-given'
  /** Seed for `order: 'random'`; recorded, so the order can be reproduced. Default: a fresh random one. */
  orderSeed?: number
  /** Called after each arm finishes, before the next starts — in the order they run. */
  onArm?: (arm: ArmRecord) => void
  /**
   * Show the arms live on DSH pages bound to `repoRoot`, in their "评估中"
   * group. Default: on, through the shared per-user registry. `false` keeps
   * the arms private; the directories are overridable for tests. Either way
   * an arm only takes instructions from this process.
   */
  advertise?: false | { registryDir?: string; controlSocketDir?: string }
}

export interface CompareRolesResult {
  record: ComparisonRecord
  recordFile: string
  markdownFile: string
  outDir: string
}

/**
 * Run the same task through every arm and write one comparison record.
 *
 * Every arm runs against its own fresh repository that holds nothing but
 * the objects reachable from the manifest's base commit — not a clone of
 * `repoRoot`, which would carry the full history. That matters more than
 * it sounds: when a manifest re-poses a task the repository has since
 * solved (the whole point of using real past tasks as recipes), a full clone
 * hands the agent the answer key. A full clone can expose unrelated solution commits
 * through `git log --all`, so each arm receives only the objects reachable from the base.
 * One repository per
 * arm also means no arm can see another arm's candidate refs.
 *
 * The private repository is what makes "same starting point" literal — it
 * is untouched by whatever state the working tree is in — and it is also
 * what the worktree driver's clean-tree preflight requires. After each arm
 * finishes, its `refs/dsh-orchestrator/runs/*` refs are fetched back into
 * `repoRoot`, so the candidate commits the record cites stay inspectable
 * after the private repository is deleted.
 */
export async function compareRoles(options: CompareRolesOptions): Promise<CompareRolesResult> {
  if (options.arms.length < 2) throw new Error('compareRoles needs at least two arms')
  const labels = new Set(options.arms.map((arm) => arm.label))
  if (labels.size !== options.arms.length) throw new Error('compareRoles arm labels must be unique')

  const now = options.now ?? Date.now
  const id = options.id ?? `${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${options.manifest.id}-${randomUUID().slice(0, 8)}`
  const repoRoot = path.resolve(options.repoRoot)
  const outDir = path.resolve(options.outDir ?? path.join(repoRoot, '.dsh', 'runtime', 'comparisons', id))
  await mkdir(outDir, { recursive: true })
  const cli = new GitCli({ gitPath: options.gitPath ?? 'git', timeoutMs: 120_000 })

  const baseCommit = await cli.execLine(['rev-parse', '--verify', `${options.manifest.baseCommit}^{commit}`], repoRoot)
  const manifest: TaskManifest = { ...options.manifest, baseCommit }

  const ordering = planArmOrder(options)
  const arms: ArmRecord[] = []
  const cloneRoots: string[] = []
  for (const [index, spec] of ordering.run.entries()) {
    const cloneRoot = await createBaseOnlyRepository(cli, repoRoot, baseCommit)
    cloneRoots.push(cloneRoot)
    try {
      const source = await resolveRoleSource({
        spec: spec.source,
        roleId: manifest.role,
        repoRoot,
        ...(options.gitPath === undefined ? {} : { gitPath: options.gitPath }),
      })
      try {
        const arm = await runArm({
          label: spec.label,
          manifest,
          source,
          repoRoot: cloneRoot,
          outDir,
          channels: options.channels,
          ...(options.gitPath === undefined ? {} : { gitPath: options.gitPath }),
          ...(options.logger === undefined ? {} : { logger: options.logger }),
          advertise: options.advertise === false
            ? false
            : {
                // The page that should show this arm is the real project's, not the clone's.
                evaluation: { comparisonId: id, taskId: manifest.id, arm: spec.label, workspace: repoRoot },
                ...(options.advertise ?? {}),
              },
          now,
        })
        const positioned: ArmRecord = { ...arm, runPosition: index + 1 }
        arms.push(positioned)
        options.onArm?.(positioned)
      } finally {
        await source.cleanup()
      }
      // Bring the evidence home: candidate refs live in the arm's repository until now.
      await cli.exec(['fetch', '--quiet', cloneRoot, '+refs/dsh-orchestrator/runs/*:refs/dsh-orchestrator/runs/*'], repoRoot)
    } finally {
      if (options.keepClone !== true) await rm(path.dirname(cloneRoot), { recursive: true, force: true })
    }
  }

  const partial: Omit<ComparisonRecord, 'notes'> = {
    schemaVersion: 1,
    id,
    createdAt: now(),
    task: {
      id: manifest.id,
      title: manifest.title,
      role: manifest.role,
      baseCommit,
      ...(manifest.setup === undefined || manifest.setup.length === 0 ? {} : { setup: manifest.setup.map((step) => step.name) }),
      ...(manifest.hiddenChecks === undefined || manifest.hiddenChecks.length === 0 ? {} : { hiddenChecks: manifest.hiddenChecks.map((check) => check.name) }),
      checks: manifest.checks.map((check) => check.name),
      ...(manifest.sandbox === undefined ? {} : { sandbox: manifest.sandbox }),
      ...(manifest.harness === undefined ? {} : { harness: manifest.harness }),
      ...(manifest.harnessContext === undefined ? {} : { harnessContext: manifest.harnessContext }),
      ...(manifest.file === undefined ? {} : { manifestFile: manifest.file }),
    },
    repoRoot,
    ...(options.keepClone === true ? { cloneRoots } : {}),
    // Listed as given, whatever order they ran in.
    arms: options.arms.map((spec) => arms.find((arm) => arm.label === spec.label)).filter((arm): arm is ArmRecord => arm !== undefined),
    ordering: { mode: ordering.mode, ...(ordering.seed === undefined ? {} : { seed: ordering.seed }) },
  }
  const scored: Omit<ComparisonRecord, 'notes'> = { ...partial, arms: partial.arms.map((arm) => ({ ...arm, scorecard: deriveScorecard(arm) })) }
  const record: ComparisonRecord = { ...scored, notes: deriveNotes(scored), verdict: deriveVerdict(scored.arms) }
  const recordFile = path.join(outDir, 'comparison.json')
  const markdownFile = path.join(outDir, 'comparison.md')
  await writeFile(recordFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  await writeFile(markdownFile, renderComparisonMarkdown(record), 'utf8')
  return { record, recordFile, markdownFile, outDir }
}

/**
 * The order `compareRoles` will run the arms in, and how it was chosen —
 * exposed so a caller (the CLI's `--dry-run`) can show it before anything runs.
 */
export function planArmOrder(options: Pick<CompareRolesOptions, 'arms' | 'order' | 'orderSeed'>): { mode: 'random' | 'as-given'; seed?: number; run: CompareArmSpec[] } {
  if (options.order === 'as-given') return { mode: 'as-given', run: [...options.arms] }
  const seed = options.orderSeed ?? randomSeed()
  return { mode: 'random', seed, run: seededShuffle(options.arms, seed) }
}

/**
 * A repository holding exactly the objects reachable from `baseCommit`,
 * checked out detached there: `git init` plus a fetch of that one sha
 * (allowed by `uploadpack.allowAnySHA1InWant`, which the local upload-pack
 * inherits through the `-c` on the fetch). `git log --all` inside it shows
 * the base commit's ancestry and nothing else.
 */
async function createBaseOnlyRepository(cli: GitCli, repoRoot: string, baseCommit: string): Promise<string> {
  const cloneRoot = path.join(await mkdtempSafe(), 'repo')
  await mkdir(cloneRoot, { recursive: true })
  await cli.exec(['init', '--quiet', cloneRoot], cloneRoot)
  await cli.exec(['-c', 'uploadpack.allowAnySHA1InWant=true', 'fetch', '--quiet', repoRoot, baseCommit], cloneRoot)
  await cli.exec(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], cloneRoot)
  return cloneRoot
}

async function mkdtempSafe(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises')
  return mkdtemp(path.join(tmpdir(), 'dsh-role-eval-'))
}
