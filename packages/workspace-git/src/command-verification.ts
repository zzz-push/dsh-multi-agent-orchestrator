import { spawn } from 'node:child_process'
import path from 'node:path'

import type { CheckRequest, CheckResult, VerificationDriver, VerificationEvidence } from '@dsh/core'

/** One controller-side check to run inside an attempt's worktree. */
export interface VerificationCommand {
  /** Label recorded in the evidence, e.g. `pnpm test`. */
  name: string
  /**
   * Shell command line, run through `sh -c` with the worktree as cwd — the
   * same way a `package.json` script runs, so `&&`, redirects and `$VAR`
   * work. This is controller-side trust: the command comes from a check
   * manifest the project author wrote, not from any agent.
   */
  command: string
  /** Per-command wall-clock cap; default {@link CommandVerificationDriverOptions.timeoutMs}. */
  timeoutMs?: number
  /** Extra environment for this command only. */
  env?: Record<string, string>
}

/** Options for {@link CommandVerificationDriver}. */
export interface CommandVerificationDriverOptions {
  /** Checks, run in order; the first failure stops the sequence. */
  commands: readonly VerificationCommand[]
  /** Default per-command cap, in milliseconds. Default: 10 minutes. */
  timeoutMs?: number
  /** How many trailing output lines to keep per command in the evidence. Default: 40. */
  outputTailLines?: number
  /** Shell binary. Default: `sh`. */
  shell?: string
  /**
   * Environment applied to every command, over `process.env` and under each
   * command's own `env`. Use it to make checks independent of the operator's
   * machine — e.g. `{ LC_ALL: 'C' }`, so a test that matches English tool
   * output does not fail on a host with a translated locale.
   */
  env?: Record<string, string>
}

/** How long a check's process group gets between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 5_000

type Outcome = { exitCode: number | null; signal: NodeJS.Signals | null; output: string; timedOut: boolean }

/**
 * `VerificationDriver` that runs a fixed list of shell checks in the
 * attempt's worktree and reports what each one did.
 *
 * This is the controller's own opinion of the attempt — `pnpm build`,
 * `pnpm test`, whatever the manifest lists — recorded as exit codes and
 * output tails, independent of anything the agent claims about its work.
 * That independence is the point: the Scheduler fails the step on a
 * non-zero exit no matter how confident the agent's summary was.
 *
 * Checks run sequentially and stop at the first failure, like a CI job. The
 * evidence still lists every check that ran, so a reader sees which one
 * broke and what it printed. A check that overruns its cap is killed with
 * SIGTERM and recorded with `signal: 'SIGTERM'` and an explicit note; that
 * counts as a failure.
 *
 * A check runs in its own process group, and stopping it — on timeout or
 * when the request's `signal` aborts (a cancelled run) — signals the whole
 * group: `sh -c 'pnpm test'` is three generations of processes deep, and
 * killing only `sh` would leave the test runner going. A group that ignores SIGTERM gets SIGKILL after
 * {@link KILL_GRACE_MS}.
 */
export class CommandVerificationDriver implements VerificationDriver {
  private readonly commands: readonly VerificationCommand[]
  private readonly timeoutMs: number
  private readonly outputTailLines: number
  private readonly shell: string
  private readonly env: Record<string, string>

  constructor(options: CommandVerificationDriverOptions) {
    this.commands = options.commands
    this.timeoutMs = options.timeoutMs ?? 600_000
    this.outputTailLines = options.outputTailLines ?? 40
    this.shell = options.shell ?? 'sh'
    this.env = options.env ?? {}
  }

  async run(check: CheckRequest): Promise<CheckResult> {
    if (check.worktreePath === undefined) {
      return { passed: false, failureMessage: 'CommandVerificationDriver needs a worktreePath to run checks in' }
    }
    const checks: NonNullable<VerificationEvidence['checks']> = []
    for (const command of this.commands) {
      if (check.signal?.aborted === true) {
        return { passed: false, evidence: { passed: false, checks }, failureMessage: 'Checks cancelled' }
      }
      const startedAt = Date.now()
      const outcome = await this.exec(command, check.worktreePath, check.signal)
      const durationMs = Date.now() - startedAt
      const summary = outcome.timedOut
        ? `[timed out after ${command.timeoutMs ?? this.timeoutMs}ms]\n${tail(outcome.output, this.outputTailLines)}`
        : tail(outcome.output, this.outputTailLines)
      checks.push({
        name: command.name,
        ...(outcome.exitCode === null ? {} : { exitCode: outcome.exitCode }),
        ...(outcome.signal === null ? {} : { signal: outcome.signal }),
        durationMs,
        outputSummary: summary,
      })
      if (outcome.exitCode !== 0) {
        const reason = outcome.timedOut
          ? `timed out`
          : outcome.signal !== null ? `killed by ${outcome.signal}` : `exited with code ${outcome.exitCode}`
        return {
          passed: false,
          evidence: { passed: false, checks },
          failureMessage: `Check "${command.name}" ${reason}`,
        }
      }
    }
    return { passed: true, evidence: { passed: true, checks } }
  }

  private exec(command: VerificationCommand, cwd: string, signal: AbortSignal | undefined): Promise<Outcome> {
    return runProcess({
      file: this.shell,
      args: ['-c', command.command],
      cwd,
      env: { ...process.env, ...this.env, ...command.env },
      timeoutMs: command.timeoutMs ?? this.timeoutMs,
      signal,
    })
  }
}

/**
 * Run one process in its own process group; stop the whole group on timeout
 * or abort (SIGTERM, then SIGKILL after {@link KILL_GRACE_MS}). Never
 * rejects: a spawn failure comes back as `exitCode: null` with the error in
 * the output.
 */
export function runProcess(options: {
  file: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
}): Promise<Outcome> {
  const { signal } = options
  return new Promise((resolve) => {
    const chunks: string[] = []
    let settled = false
    let timedOut = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const detached = process.platform !== 'win32'
    const proc = spawn(options.file, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached,
    })
    const signalGroup = (sig: NodeJS.Signals): void => {
      try {
        if (detached && proc.pid !== undefined) process.kill(-proc.pid, sig)
        else proc.kill(sig)
      } catch {
        // Already gone.
      }
    }
    const stop = (): void => {
      signalGroup('SIGTERM')
      killTimer ??= setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS)
      killTimer.unref?.()
    }
    const finish = (exitCode: number | null, sig: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      signal?.removeEventListener('abort', stop)
      resolve({ exitCode, signal: sig, output: chunks.join(''), timedOut })
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, options.timeoutMs)
    if (signal?.aborted) stop()
    else signal?.addEventListener('abort', stop, { once: true })
    proc.stdout?.on('data', (data: Buffer) => chunks.push(data.toString()))
    proc.stderr?.on('data', (data: Buffer) => chunks.push(data.toString()))
    proc.on('error', (error) => {
      chunks.push(`[spawn error] ${error.message}\n`)
      finish(null, null)
    })
    proc.on('close', (code, sig) => finish(code, sig))
  })
}

/** Environment every workflow check gets besides the names it allows: enough to find binaries, nothing secret. */
const BASE_CHECK_ENV = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot'] as const

/**
 * `VerificationDriver` for the governed pipeline: runs the checks the
 * workflow step itself declares (`steps[].checks`, handed over by the
 * Scheduler as `CheckRequest.commands`).
 *
 * Checks come from a compiled workflow the project author wrote, and run the
 * way the compiler describes them: argv without a shell, in `cwd` under the
 * worktree, with only `env_allow` variables (plus `PATH`/`HOME`/temp dirs
 * and `LC_ALL=C`) passed through. A failing `required: false` check is
 * recorded but does not fail the step. A step that declares no checks
 * passes with an empty check list.
 */
export class WorkflowCheckVerificationDriver implements VerificationDriver {
  private readonly outputTailLines: number

  constructor(options: { outputTailLines?: number } = {}) {
    this.outputTailLines = options.outputTailLines ?? 40
  }

  async run(check: CheckRequest): Promise<CheckResult> {
    if (check.worktreePath === undefined) {
      return { passed: false, failureMessage: 'WorkflowCheckVerificationDriver needs a worktreePath to run checks in' }
    }
    const checks: NonNullable<VerificationEvidence['checks']> = []
    for (const step of check.commands ?? []) {
      if (check.signal?.aborted === true) {
        return { passed: false, evidence: { passed: false, checks }, failureMessage: 'Checks cancelled' }
      }
      const cwd = path.resolve(check.worktreePath, step.cwd)
      if (cwd !== check.worktreePath && !cwd.startsWith(`${check.worktreePath}${path.sep}`)) {
        return { passed: false, evidence: { passed: false, checks }, failureMessage: `Check "${step.id}" cwd escapes the worktree: ${step.cwd}` }
      }
      const env: NodeJS.ProcessEnv = { LC_ALL: 'C', LANGUAGE: 'C' }
      for (const name of [...BASE_CHECK_ENV, ...step.envAllow]) {
        if (process.env[name] !== undefined) env[name] = process.env[name]
      }
      const [file, ...args] = step.command
      const startedAt = Date.now()
      const outcome = await runProcess({ file: file ?? '', args, cwd, env, timeoutMs: step.timeoutSeconds * 1000, ...(check.signal === undefined ? {} : { signal: check.signal }) })
      checks.push({
        name: step.id,
        ...(outcome.exitCode === null ? {} : { exitCode: outcome.exitCode }),
        ...(outcome.signal === null ? {} : { signal: outcome.signal }),
        durationMs: Date.now() - startedAt,
        outputSummary: `${outcome.timedOut ? `[timed out after ${step.timeoutSeconds}s]\n` : ''}${step.required ? '' : '[optional] '}${tail(outcome.output, this.outputTailLines)}`,
      })
      if (outcome.exitCode !== 0 && step.required) {
        const reason = outcome.timedOut ? 'timed out' : outcome.signal !== null ? `killed by ${outcome.signal}` : `exited with code ${outcome.exitCode}`
        return { passed: false, evidence: { passed: false, checks }, failureMessage: `Check "${step.id}" ${reason}` }
      }
    }
    return { passed: true, evidence: { passed: true, checks } }
  }
}

function tail(text: string, lines: number): string {
  // Trim first: a trailing newline would otherwise count as an empty last line.
  const all = text.trimEnd().split('\n')
  const kept = all.length <= lines ? all : all.slice(all.length - lines)
  return kept.join('\n')
}
