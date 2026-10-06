#!/usr/bin/env tsx
/**
 * DSH governed-pipeline CLI — the command a workflow skill's SKILL.md tells a
 * main agent to run when a task needs the governed path: persisted state, mechanical
 * step order, isolated worktrees with checked merges, the workflow's own checks.
 *
 * Usage:
 *   pnpm dsh:start-workflow <workflowId> --input task="..." [--input <name>=<value>]... [--repo <path>]
 *   pnpm dsh:start-workflow --list
 *   pnpm dsh:start-workflow --status <runId>
 *   pnpm dsh:start-workflow --cancel <runId>
 *   pnpm dsh:start-workflow --retry <runId> <stepId>
 *   pnpm dsh:start-workflow --recover
 *   pnpm dsh:start-workflow --resume <runId>
 *
 * `--harness codex|claude-code` runs every step on that harness instead of
 * what each role declares (for when one harness is unavailable here).
 *
 * Common options: `--repo <path>` (default: cwd; must be a clean git
 * repository — the run starts from its HEAD), `--skills-dir <dir>` (default
 * `<repo>/.dsh/skills`), `--runs-dir <dir>` (default `<repo>/.dsh/runtime/runs`,
 * the same directory the orchestrator plugin uses, so the two share run
 * records and leases).
 *
 * The scheduler lives in this process, so the command stays until the run
 * reaches a wait state (`delivery_ready`, `waiting_action`) or a terminal one,
 * then prints where each step ended. Ctrl-C cancels the run: agents and checks
 * are stopped and the run ends `cancelled`. A run left `waiting_action` (a
 * failed check, a merge conflict) can be retried step by step with `--retry`.
 *
 * If this process dies instead (killed, crashed, machine off), the run is
 * left mid-flight. `--recover` finds such runs once their lease has lapsed
 * (the DSH orchestrator plugin does the same when it starts), marks the
 * steps that were running `interrupted` and runs nothing; `--resume <runId>`
 * then re-runs exactly those steps from the integration commit — steps that
 * merged stay merged — and carries on. Time the run spent dead still counts
 * toward the workflow's `max_run_seconds`.
 *
 * The result lands on the run's integration ref, never on your branch:
 * `delivery_ready` prints the ref and commit to review and apply yourself.
 */
import path from 'node:path'

import {
  AgentManager,
  AgentManagerExecutor,
  ClaudeCodeChannel,
  CodexWebSocketChannel,
  FileRoleProvider,
  FileWorkflowSkillProvider,
  installShutdownHandlers,
  startWorkflow,
} from '@dsh/agent-manager'
import { FileRunLeaseStore, FileRunRepository, Scheduler, type RunAggregate } from '@dsh/core'
import { GitWorkspaceDriver, WorkflowCheckVerificationDriver } from '@dsh/workspace-git'

type Command =
  | { kind: 'start'; workflowId: string; input: Record<string, string>; harness?: string }
  | { kind: 'list' }
  | { kind: 'status'; runId: string }
  | { kind: 'cancel'; runId: string }
  | { kind: 'retry'; runId: string; stepId: string }
  | { kind: 'resume'; runId: string }
  | { kind: 'recover' }

interface ParsedArgs {
  command: Command
  repoRoot: string
  skillsDir: string
  runsDir: string
}

const USAGE = [
  'usage: start-workflow <workflowId> --input <name>=<value>... [--harness <name>] [--repo <path>] [--skills-dir <dir>] [--runs-dir <dir>]',
  '       start-workflow --list | --status <runId> | --cancel <runId> | --retry <runId> <stepId> | --recover | --resume <runId>',
].join('\n')

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = []
  const input: Record<string, string> = {}
  let repoRoot = process.cwd()
  let skillsDir: string | undefined
  let runsDir: string | undefined
  let mode: 'start' | 'list' | 'status' | 'cancel' | 'retry' | 'resume' | 'recover' = 'start'
  let harness: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    if (arg === '--input') {
      const pair = argv[index += 1] ?? ''
      const separator = pair.indexOf('=')
      if (separator <= 0) throw new Error(`--input needs <name>=<value>, got ${JSON.stringify(pair)}`)
      input[pair.slice(0, separator)] = pair.slice(separator + 1)
      continue
    }
    if (arg === '--repo') { repoRoot = path.resolve(argv[index += 1] ?? ''); continue }
    if (arg === '--harness') { harness = argv[index += 1]; continue }
    if (arg === '--skills-dir') { skillsDir = path.resolve(argv[index += 1] ?? ''); continue }
    if (arg === '--runs-dir') { runsDir = path.resolve(argv[index += 1] ?? ''); continue }
    if (arg === '--list') { mode = 'list'; continue }
    if (arg === '--status') { mode = 'status'; continue }
    if (arg === '--cancel') { mode = 'cancel'; continue }
    if (arg === '--retry') { mode = 'retry'; continue }
    if (arg === '--resume') { mode = 'resume'; continue }
    if (arg === '--recover') { mode = 'recover'; continue }
    if (arg.startsWith('--')) throw new Error(`unknown option ${arg}\n${USAGE}`)
    positional.push(arg)
  }
  const [first, second] = positional
  const need = (value: string | undefined): string => {
    if (value === undefined || value === '') throw new Error(USAGE)
    return value
  }
  const command: Command = mode === 'list' ? { kind: 'list' }
    : mode === 'recover' ? { kind: 'recover' }
    : mode === 'status' ? { kind: 'status', runId: need(first) }
    : mode === 'cancel' ? { kind: 'cancel', runId: need(first) }
    : mode === 'retry' ? { kind: 'retry', runId: need(first), stepId: need(second) }
    : mode === 'resume' ? { kind: 'resume', runId: need(first) }
    : { kind: 'start', workflowId: need(first), input, ...(harness === undefined ? {} : { harness }) }
  return {
    command,
    repoRoot,
    skillsDir: skillsDir ?? path.join(repoRoot, '.dsh', 'skills'),
    runsDir: runsDir ?? path.join(repoRoot, '.dsh', 'runtime', 'runs'),
  }
}

/** Everything a scheduler in this process needs; agents only when something will run. */
function pipeline(args: ParsedArgs) {
  const runRepository = new FileRunRepository({ dir: args.runsDir })
  const leases = new FileRunLeaseStore({ dir: args.runsDir })
  const roles = new FileRoleProvider({ rolesDir: path.join(args.repoRoot, '.dsh', 'roles') })
  const manager = new AgentManager({
    roleProvider: roles,
    journalFile: path.join(args.repoRoot, '.dsh', 'runtime', 'workflow-events.jsonl'),
    cwd: args.repoRoot,
    channels: [new ClaudeCodeChannel({ command: 'claude' }), new CodexWebSocketChannel({ command: 'codex' })],
  })
  const workspaceDriver = new GitWorkspaceDriver()
  const scheduler = new Scheduler({
    repository: runRepository,
    leases,
    agentExecutor: new AgentManagerExecutor(manager),
    workspaceDriver,
    verificationDriver: new WorkflowCheckVerificationDriver(),
  })
  return { runRepository, roles, manager, workspaceDriver, scheduler }
}

function describe(run: RunAggregate): string {
  const lines = [`run ${run.id} — ${run.status}${run.failure === undefined ? '' : ` (${run.failure.code}: ${run.failure.message})`}`]
  const steps = Object.values(run.steps).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  for (const step of steps) {
    const attempt = step.attempts.at(-1)
    const checks = attempt?.evidence?.checks?.map((check) => `${check.name}=${check.exitCode ?? check.signal ?? '?'}`).join(' ')
    lines.push(`  ${step.id.padEnd(16)} ${step.status.padEnd(14)} attempts=${step.attempts.length}${checks === undefined || checks === '' ? '' : `  checks: ${checks}`}${step.failure === undefined ? '' : `\n  ${''.padEnd(16)} ↳ ${step.failure.code}: ${step.failure.message.split('\n')[0]}`}`)
  }
  if (run.status === 'delivery_ready') {
    lines.push('', `result: ${run.integration.ref} → ${run.integration.commit}`)
    lines.push(`review: git log --stat ${run.integration.commit} -n ${Object.keys(run.steps).length}`)
    lines.push('apply yourself when satisfied, e.g.: git merge --ff-only ' + run.integration.commit)
  } else if (run.status === 'waiting_action') {
    const broken = steps.filter((step) => step.status === 'failed' || step.status === 'merge_conflict').map((step) => step.id)
    const interrupted = steps.filter((step) => step.status === 'interrupted').map((step) => step.id)
    lines.push('')
    if (broken.length > 0) lines.push(`next: fix what broke (${broken.join(', ')}), then  pnpm dsh:start-workflow --retry ${run.id} <stepId>`)
    if (interrupted.length > 0) lines.push(`${broken.length > 0 ? 'then' : 'next'}: re-run what was interrupted (${interrupted.join(', ')}):  pnpm dsh:start-workflow --resume ${run.id}`)
    if (broken.length === 0 && interrupted.length === 0) lines.push(`next: carry on from where it stopped:  pnpm dsh:start-workflow --resume ${run.id}`)
  }
  return lines.join('\n')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const { command } = args

  if (command.kind === 'list') {
    for (const pack of await new FileWorkflowSkillProvider({ skillsDir: args.skillsDir, logger: { warn: (message) => console.error(`[start-workflow] ${message}`) } }).list()) {
      process.stdout.write(`${pack.workflowId}  ${pack.name}${pack.version === undefined ? '' : ` v${pack.version}`}\n  ${pack.description.trim().replace(/\s+/g, ' ')}\n`)
    }
    return
  }
  if (command.kind === 'recover') {
    // Marks and reports; runs nothing, so no agents are needed here.
    const runsDir = args.runsDir
    const scheduler = new Scheduler({ repository: new FileRunRepository({ dir: runsDir }), leases: new FileRunLeaseStore({ dir: runsDir }) })
    const recoveries = await scheduler.recoverAbandoned()
    if (recoveries.length === 0) process.stdout.write(`no abandoned runs in ${runsDir}\n`)
    for (const recovery of recoveries) {
      process.stdout.write(recovery.run === undefined
        ? `run ${recovery.runId} — could not be taken over: ${recovery.error ?? 'unknown error'}\n`
        : `${describe(recovery.run)}\n`)
    }
    return
  }
  if (command.kind === 'status') {
    const run = await new FileRunRepository({ dir: args.runsDir }).get(command.runId)
    if (run === undefined) throw new Error(`no run ${command.runId} in ${args.runsDir}`)
    process.stdout.write(`${describe(run)}\n`)
    return
  }

  const { manager, roles, workspaceDriver, scheduler, runRepository } = pipeline(args)
  let current: string | undefined = command.kind === 'start' ? undefined : command.runId
  installShutdownHandlers({
    onSignal: (signal) => {
      console.error(`[start-workflow] ${signal}: cancelling ${current ?? 'the run'}…`)
      if (current !== undefined) void scheduler.cancel(current).catch(() => undefined)
    },
  })
  try {
    let run: RunAggregate
    if (command.kind === 'cancel') {
      run = await scheduler.cancel(command.runId)
      if (run.status === 'cancelling') console.error('[start-workflow] another process is running it; that process stops its agents and finalizes the cancellation')
    } else if (command.kind === 'retry') {
      await scheduler.retryStep(command.runId, command.stepId)
      run = await scheduler.run(command.runId)
    } else if (command.kind === 'resume') {
      run = await scheduler.resume(command.runId)
    } else {
      const snapshot = await workspaceDriver.inspectRepository(args.repoRoot)
      const started = await startWorkflow({
        workflowId: command.workflowId,
        input: command.input,
        skillsDir: args.skillsDir,
        globalRoles: roles,
        repository: { root: snapshot.root, gitCommonDir: snapshot.gitCommonDir, baseCommit: snapshot.headCommit },
        scheduler,
        runRepository,
        initiator: { kind: 'agent' },
        ...(command.harness === undefined ? {} : { harness: command.harness }),
      })
      if (started.outcome === 'workflow_not_found') throw new Error(`no workflow ${command.workflowId} under ${args.skillsDir} (try --list)`)
      if (started.outcome === 'invalid_input') throw new Error(`invalid input:\n${started.errors.map((error) => `  ${error.path}: ${error.message}`).join('\n')}`)
      if (started.outcome === 'compile_failed') throw new Error(`workflow does not compile:\n${started.errors.map((error) => `  ${error.path}: ${error.message}`).join('\n')}`)
      current = started.runId
      console.error(`[start-workflow] run ${started.runId} started from ${snapshot.headCommit.slice(0, 12)}; record: ${path.join(args.runsDir, started.runId)}/`)
      run = await started.settled
    }
    process.stdout.write(`${describe(run)}\n`)
    if (run.status !== 'delivery_ready' && run.status !== 'cancelled' && run.status !== 'cancelling') process.exitCode = 1
  } finally {
    await manager.dispose()
  }
}

main().catch((error: unknown) => {
  console.error(`[start-workflow] failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
