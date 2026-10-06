#!/usr/bin/env tsx
/**
 * DSH role comparison CLI example.
 *
 * Runs one task manifest through two (or more) versions of the same role,
 * each in its own git worktree off the same base commit, with the same
 * controller-side checks, and writes a comparison record whose every number
 * is a count of journal events, a check's exit code, or a git fact.
 *
 * Usage:
 *   pnpm dsh:compare-roles <manifest.yaml> \
 *     --baseline git:<ref>[:<rolesPath>] \
 *     --candidate <rolesDir> | git:<ref> \
 *     [--repo <path>] [--out <dir>] [--label <baselineLabel>,<candidateLabel>] \
 *     [--harness codex|claude-code] [--harness-context keep|hide] [--order random|as-given] [--seed <n>]
 *     [--no-advertise] [--keep-clone] [--dry-run]
 *
 * While it runs, every arm is listed on DSH pages bound to the repository,
 * in the Agent dock's "评估中" group: you can open an arm's window and watch
 * its conversation live, but not type into it or terminate it — a message
 * would change what is being measured. Stop a comparison by stopping this
 * process (Ctrl-C takes the sub-agents down with it). `--no-advertise`
 * keeps the arms private.
 *
 * `--harness` runs every arm on one harness regardless of what the roles
 * declare (overriding the manifest's `harness`, if any). The roles and their
 * content hashes are untouched; the record's task section says which
 * harness ran. The manifest's `sandbox: workspace-write` means the same on
 * both harnesses: edit and run commands inside the worktree only.
 *
 * `--harness-context hide` takes the project's own harness instructions
 * (CLAUDE.md, AGENTS.md, .claude/skills, ...) out of every worktree for the
 * role's turn, overriding the manifest's `harness_context`. Use it
 * to measure a role alone; the default `keep` measures role + project
 * instructions, which is what everyday use looks like.
 *
 * The arms run one after another in a random order by default (a
 * fixed order can put provider load, quota and time of day on the same arm
 * every time); the record keeps the seed, and `--seed <n>` reproduces an
 * order. `--order as-given` runs baseline first, as before — the record
 * then carries a note saying so.
 *
 * Example — was the v2.0.0 upgrade of example-builder worth it?
 *   pnpm dsh:compare-roles .dsh/eval/tasks/example-task.yaml \
 *     --baseline git:0123456^ --candidate .dsh/roles
 *
 * `--dry-run` resolves the manifest, the base commit and both role sources
 * (printing each role's version and content hash, and the order the arms
 * would run in) and exits without
 * spawning anything — use it to check what would be compared before
 * spending a real run.
 *
 * The record lands under <repo>/.dsh/runtime/comparisons/<id>/ as
 * comparison.json + comparison.md, next to each arm's journal and run
 * document. Candidate commits are pinned in the real repository under
 * refs/dsh-orchestrator/runs/<runId>/candidates/... — `git show <sha>` works
 * after the temp clone is gone.
 */
import path from 'node:path'

import { ClaudeCodeChannel, CodexWebSocketChannel, installShutdownHandlers } from '@dsh/agent-manager'
import { GitCli } from '@dsh/workspace-git'
import {
  compareRoles,
  loadTaskManifest,
  parseRoleSourceSpec,
  planArmOrder,
  randomSeed,
  resolveRoleSource,
  type CompareArmSpec,
} from '@dsh/role-eval'

interface ParsedArgs {
  manifestFile: string
  arms: CompareArmSpec[]
  repoRoot: string
  outDir?: string
  keepClone: boolean
  dryRun: boolean
  harness?: string
  harnessContext?: 'keep' | 'hide'
  order: 'random' | 'as-given'
  seed?: number
  advertise: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = []
  let baseline: string | undefined
  let candidate: string | undefined
  let repoRoot = process.cwd()
  let outDir: string | undefined
  let labels: [string, string] = ['baseline', 'candidate']
  let keepClone = false
  let dryRun = false
  let harness: string | undefined
  let harnessContext: 'keep' | 'hide' | undefined
  let order: 'random' | 'as-given' = 'random'
  let seed: number | undefined
  let advertise = true
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    if (arg === '--baseline') { baseline = argv[index += 1]; continue }
    if (arg === '--candidate') { candidate = argv[index += 1]; continue }
    if (arg === '--repo') { repoRoot = path.resolve(argv[index += 1] ?? ''); continue }
    if (arg === '--out') { outDir = path.resolve(argv[index += 1] ?? ''); continue }
    if (arg === '--label') {
      const parts = (argv[index += 1] ?? '').split(',')
      if (parts.length !== 2 || parts.some((part) => part.trim() === '')) throw new Error('--label needs "<baseline>,<candidate>"')
      labels = [parts[0]!.trim(), parts[1]!.trim()]
      continue
    }
    if (arg === '--keep-clone') { keepClone = true; continue }
    if (arg === '--dry-run') { dryRun = true; continue }
    if (arg === '--harness') { harness = argv[index += 1]; continue }
    if (arg === '--harness-context') {
      const value = argv[index += 1]
      if (value !== 'keep' && value !== 'hide') throw new Error('--harness-context needs keep or hide')
      harnessContext = value
      continue
    }
    if (arg === '--order') {
      const value = argv[index += 1]
      if (value !== 'random' && value !== 'as-given') throw new Error('--order needs random or as-given')
      order = value
      continue
    }
    if (arg === '--seed') {
      const value = Number(argv[index += 1])
      if (!Number.isInteger(value) || value <= 0) throw new Error('--seed needs a positive integer')
      seed = value
      continue
    }
    if (arg === '--no-advertise') { advertise = false; continue }
    positional.push(arg)
  }
  const [manifestFile] = positional
  if (!manifestFile || !baseline || !candidate) {
    throw new Error('usage: compare-roles <manifest.yaml> --baseline <git:ref|dir> --candidate <git:ref|dir> [--repo <path>] [--out <dir>] [--label a,b] [--harness codex|claude-code] [--harness-context keep|hide] [--order random|as-given] [--seed <n>] [--no-advertise] [--keep-clone] [--dry-run]')
  }
  return {
    manifestFile: path.resolve(manifestFile),
    arms: [
      { label: labels[0], source: parseRoleSourceSpec(baseline) },
      { label: labels[1], source: parseRoleSourceSpec(candidate) },
    ],
    repoRoot,
    ...(outDir === undefined ? {} : { outDir }),
    keepClone,
    dryRun,
    ...(harness === undefined ? {} : { harness }),
    ...(harnessContext === undefined ? {} : { harnessContext }),
    order,
    ...(seed === undefined ? {} : { seed }),
    advertise,
  }
}

async function main(): Promise<void> {
  // Ctrl-C / SIGTERM must take the harness processes down with us; without a
  // handler Node exits at once and every sub-agent is reparented to init.
  installShutdownHandlers({ onSignal: (signal) => console.error(`[compare-roles] ${signal}: stopping sub-agents…`) })
  const args = parseArgs(process.argv.slice(2))
  const loaded = await loadTaskManifest(args.manifestFile)
  // --harness overrides the manifest for this run only; the record says which harness ran.
  const manifest = {
    ...loaded,
    ...(args.harness === undefined ? {} : { harness: args.harness }),
    ...(args.harnessContext === undefined ? {} : { harnessContext: args.harnessContext }),
  }
  const git = new GitCli({ gitPath: 'git', timeoutMs: 30_000 })
  const baseCommit = await git.execLine(['rev-parse', '--verify', `${manifest.baseCommit}^{commit}`], args.repoRoot)

  console.error(`[compare-roles] task      ${manifest.id} — ${manifest.title}`)
  console.error(`[compare-roles] role      ${manifest.role}`)
  console.error(`[compare-roles] base      ${manifest.baseCommit} → ${baseCommit}`)
  if (manifest.setup !== undefined && manifest.setup.length > 0) console.error(`[compare-roles] setup     ${manifest.setup.map((step) => step.name).join(', ')}`)
  console.error(`[compare-roles] checks    ${manifest.checks.map((check) => check.name).join(', ')}`)
  if (manifest.hiddenChecks !== undefined && manifest.hiddenChecks.length > 0) {
    console.error(`[compare-roles] hidden    ${manifest.hiddenChecks.map((check) => check.name).join(', ')}${manifest.hiddenFilesDir === undefined ? '' : ` (files: ${manifest.hiddenFilesDir})`}`)
  }
  if (manifest.sandbox !== undefined) console.error(`[compare-roles] sandbox   ${manifest.sandbox} (manifest, both arms)`)
  if (manifest.harness !== undefined) console.error(`[compare-roles] harness   ${manifest.harness} (${args.harness === undefined ? 'manifest' : '--harness'}, both arms, overrides the roles)`)
  console.error(`[compare-roles] context   ${manifest.harnessContext ?? 'keep'}${manifest.harnessContext === 'hide' ? ' (CLAUDE.md / AGENTS.md / .claude skills hidden during the turn)' : ' (project instructions stay, as in everyday use)'}`)
  for (const arm of args.arms) {
    const source = await resolveRoleSource({ spec: arm.source, roleId: manifest.role, repoRoot: args.repoRoot })
    try {
      console.error(`[compare-roles] ${arm.label.padEnd(9)} ${source.label}  v${source.role.version}  ${source.roleHash.slice(0, 12)}${source.projectLayerHash === undefined ? '' : ` +layer ${source.projectLayerHash.slice(0, 12)}`}  harness=${manifest.harness ?? source.role.execution.harness}${manifest.harness !== undefined && manifest.harness !== source.role.execution.harness ? ` (role declares ${source.role.execution.harness})` : ''}`)
    } finally {
      await source.cleanup()
    }
  }
  // Fixed here, so the order a dry run prints is the order a real run with the same --seed uses.
  const orderSeed = args.order === 'random' ? args.seed ?? randomSeed() : undefined
  const planned = planArmOrder({ arms: args.arms, order: args.order, ...(orderSeed === undefined ? {} : { orderSeed }) })
  console.error(`[compare-roles] order     ${planned.run.map((arm) => arm.label).join(' → ')}${planned.mode === 'random' ? ` (random, --seed ${planned.seed} reproduces it)` : ' (as given)'}`)
  if (args.dryRun) {
    console.error('[compare-roles] dry run — nothing spawned')
    return
  }

  const started = Date.now()
  console.error(args.advertise
    ? `[compare-roles] live      DSH pages on ${args.repoRoot} show the arms under "评估中" (observe-only); --no-advertise hides them`
    : '[compare-roles] live      not advertised (--no-advertise)')
  const result = await compareRoles({
    manifest,
    arms: args.arms,
    repoRoot: args.repoRoot,
    ...(args.outDir === undefined ? {} : { outDir: args.outDir }),
    channels: [
      new ClaudeCodeChannel({ command: 'claude' }),
      new CodexWebSocketChannel({ command: 'codex' }),
    ],
    keepClone: args.keepClone,
    order: args.order,
    ...(orderSeed === undefined ? {} : { orderSeed }),
    ...(args.advertise ? {} : { advertise: false as const }),
    onArm: (arm) => {
      const status = arm.error === undefined ? `${arm.runStatus} / step ${arm.step.status}` : `error: ${arm.error}`
      const hidden = arm.hidden === undefined ? '' : `, hidden=${arm.hidden.passed}/${arm.hidden.total}`
      console.error(`[compare-roles] ${arm.label.padEnd(9)} done — ${status}${arm.journal === undefined ? '' : `, tool_calls=${arm.journal.toolCalls}`}${hidden}`)
    },
  })
  console.error(`[compare-roles] finished in ${Math.round((Date.now() - started) / 1000)}s`)
  for (const line of result.record.verdict ?? []) console.error(`[compare-roles] 读数: ${line}`)
  for (const note of result.record.notes) console.error(`[compare-roles] note: ${note}`)
  // stdout carries only the record path, so this can be piped.
  process.stdout.write(`${result.markdownFile}\n`)
}

main().catch((error: unknown) => {
  console.error(`[compare-roles] failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
