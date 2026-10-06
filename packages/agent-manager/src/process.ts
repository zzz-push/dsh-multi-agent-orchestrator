import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { promisify } from 'node:util'
import { ChannelSpawnError } from './errors.js'

const execFileAsync = promisify(execFile)

/** How a child process ended. */
export interface ProcessExitInfo {
  /** Process exit code; `null` when terminated by a signal. */
  code: number | null
  /** Terminating signal, when applicable. */
  signal: NodeJS.Signals | null
  /** Epoch milliseconds at which the process exited. */
  timestamp: number
}

export interface SpawnManagedOptions {
  /** Executable, e.g. `claude` or `codex`. */
  command: string
  /** Arguments passed to the executable. */
  args: readonly string[]
  /** Working directory (defaults to `process.cwd()`). */
  cwd?: string
  /** Extra environment variables merged over `process.env`. */
  env?: Record<string, string>
  /** Called with one stdout chunk as it arrives. */
  onStdout?: (chunk: Buffer) => void
  /** Called with one stderr chunk as it arrives. */
  onStderr?: (chunk: Buffer) => void
}

/**
 * Wrapper around one spawned child process: liveness probing, exit
 * tracking and graceful kill. Every process created through
 * {@link spawnManaged} must eventually be reaped with
 * {@link ManagedProcess.killGraceful} or the manager's dispose path —
 * orphan processes are a hard bug in this project.
 */
export interface ManagedProcess {
  /** OS process id. */
  readonly pid: number
  /** Resolves after the OS process is created; rejects when spawn itself fails. */
  readonly spawned: Promise<void>
  /** True while the process has not exited (spawn errors included). */
  alive(): boolean
  /**
   * Resolves when the process exits (or fails to spawn), with the exit
   * info. Never rejects: spawn failures resolve with a synthesized
   * {@link ProcessExitInfo} carrying code `null` and signal `null`.
   */
  readonly exit: Promise<ProcessExitInfo>
  /** Underlying stdin stream (used by line-framed protocols). */
  readonly stdin: ChildProcess['stdin']
  /**
   * Terminate the process: SIGTERM first, SIGKILL after `graceMs`.
   * Resolves once the process is confirmed dead. Idempotent.
   */
  killGraceful(graceMs?: number): Promise<ProcessExitInfo>
  /**
   * Flush and close stdin. For stdin-driven protocols (Claude Code
   * stream-json `-p`) this signals end-of-input and usually lets the
   * process exit by itself.
   */
  endStdin(): void
}

/**
 * Spawn a child process under the manager's lifecycle discipline.
 *
 * The returned {@link ManagedProcess} resolves its `exit` promise from the
 * `exit` event (i.e. after the OS reaps the process), so awaiting
 * `killGraceful` guarantees no zombie remains.
 */
export function spawnManaged(options: SpawnManagedOptions): ManagedProcess {
  let child: ChildProcess
  try {
    child = spawn(options.command, [...options.args], {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    } satisfies SpawnOptions)
  } catch (error) {
    throw new ChannelSpawnError(options.command, String(error), { cause: error })
  }

  child.stdout?.on('data', (chunk: Buffer) => options.onStdout?.(chunk))
  child.stderr?.on('data', (chunk: Buffer) => options.onStderr?.(chunk))
  // Writing to a closed stdin raises EPIPE on the stream; swallow it —
  // the exit event is the authoritative close signal.
  child.stdin?.on('error', () => {})

  let settled = false
  let spawnSettled = false
  let exitInfo: ProcessExitInfo = { code: null, signal: null, timestamp: 0 }
  let resolveSpawned: (() => void) | undefined
  let rejectSpawned: ((error: unknown) => void) | undefined
  const spawned = new Promise<void>((resolve, reject) => {
    resolveSpawned = resolve
    rejectSpawned = reject
  })
  const exit = new Promise<ProcessExitInfo>((resolve) => {
    const finish = (info: ProcessExitInfo): void => {
      if (settled) return
      settled = true
      exitInfo = info
      resolve(info)
    }
    child.once('spawn', () => {
      spawnSettled = true
      resolveSpawned?.()
    })
    child.once('error', (error) => {
      if (!spawnSettled) {
        spawnSettled = true
        rejectSpawned?.(new ChannelSpawnError(options.command, String(error), { cause: error }))
      }
      finish({ code: null, signal: null, timestamp: Date.now() })
    })
    child.once('exit', (code, signal) => {
      if (!spawnSettled) {
        spawnSettled = true
        rejectSpawned?.(
          new ChannelSpawnError(options.command, `process exited before spawn completed (code ${String(code)})`),
        )
      }
      finish({ code, signal, timestamp: Date.now() })
    })
  })

  const managed: ManagedProcess = {
    pid: child.pid ?? -1,
    spawned,
    alive: () => child.exitCode === null && child.signalCode === null && !settled,
    exit,
    stdin: child.stdin,
    async killGraceful(graceMs = 2_000): Promise<ProcessExitInfo> {
      if (settled) return exitInfo
      // `codex` and `claude` on PATH are npm launcher scripts that exec the
      // real binary as a grandchild with inherited stdio. Signalling only the
      // direct child relies on the launcher forwarding — and on the binary
      // honouring — the signal within the grace period. Observed during testing
      // with codex 0.155.1: the launcher died on the SIGKILL fallback, the
      // native app-server lived on reparented to launchd, and the host node
      // process could never exit because the orphan still held our stdout/
      // stderr pipes. So the whole tree is snapshotted while the launcher is
      // still alive and every member is signalled directly.
      const tree = await descendantsOf(child.pid)
      // Ask politely first.
      child.kill('SIGTERM')
      signalEach(tree, 'SIGTERM')
      const result = await Promise.race([
        exit,
        new Promise<ProcessExitInfo>((resolve) => {
          setTimeout(() => resolve({ code: null, signal: null, timestamp: -1 }), graceMs).unref?.()
        }),
      ])
      let info = result
      if (result.timestamp === -1) {
        child.kill('SIGKILL')
        signalEach(tree, 'SIGKILL')
        info = await exit
      } else {
        // The launcher is gone; anything below it that ignored SIGTERM is
        // now an orphan by definition, so there is nothing to wait for.
        signalEach(tree, 'SIGKILL')
      }
      // Teardown is over: drop our ends of the pipes so a survivor we could
      // not see (double-forked, setsid) cannot keep this event loop alive.
      child.stdout?.destroy()
      child.stderr?.destroy()
      return info
    },
    endStdin(): void {
      child.stdin?.end()
    },
  }
  live.add(managed)
  void exit.then(() => live.delete(managed))
  return managed
}

/** Every process spawned through {@link spawnManaged} that has not exited yet. */
const live = new Set<ManagedProcess>()

/** Snapshot of the managed child processes still alive in this host process. */
export function liveManagedProcesses(): ManagedProcess[] {
  return [...live]
}

const SIGNAL_NUMBERS: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }
let shutdownInstalled = false

/**
 * Make SIGINT / SIGTERM / SIGHUP take the managed children down with the host.
 *
 * Without a handler Node exits on these signals immediately: no `finally`
 * runs, no `dispose()`, and every harness child is reparented to init.
 * Observed during testing: interrupting `pnpm dsh:compare-roles` mid-run left the
 * codex app-server alive under PID 1. Tree-aware `killGraceful()` only helps
 * if something calls it.
 *
 * The handler kills every live managed process tree (the same SIGTERM →
 * SIGKILL escalation as `killGraceful`), then exits with the conventional
 * 128 + signal number. A second signal while cleanup runs exits at once.
 * Idempotent; meant for CLIs and long-running hosts, not for libraries —
 * installing a signal handler changes the host's exit behaviour.
 */
export function installShutdownHandlers(options: { graceMs?: number; onSignal?: (signal: NodeJS.Signals) => void } = {}): void {
  if (shutdownInstalled) return
  shutdownInstalled = true
  let shuttingDown = false
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      const code = 128 + (SIGNAL_NUMBERS[signal] ?? 0)
      if (shuttingDown) process.exit(code)
      shuttingDown = true
      options.onSignal?.(signal)
      void killAllGraceful(liveManagedProcesses(), options.graceMs ?? 2_000)
        .catch(() => undefined)
        .finally(() => process.exit(code))
    })
  }
}

/**
 * Every live descendant of `pid` (children first, then their children, …),
 * found through `pgrep -P`. Best effort: an unavailable `pgrep` or a process
 * that exits mid-walk simply yields fewer pids, never an error.
 */
async function descendantsOf(pid: number | undefined): Promise<number[]> {
  if (pid === undefined || pid <= 0 || process.platform === 'win32') return []
  const found: number[] = []
  const queue = [pid]
  while (queue.length > 0) {
    const parent = queue.shift()!
    let stdout = ''
    try {
      ;({ stdout } = await execFileAsync('pgrep', ['-P', String(parent)]))
    } catch {
      // pgrep exits 1 when there are no children — the common, normal case.
      continue
    }
    for (const line of stdout.split('\n')) {
      const value = Number.parseInt(line.trim(), 10)
      if (Number.isInteger(value) && value > 0 && !found.includes(value)) {
        found.push(value)
        queue.push(value)
      }
    }
  }
  return found
}

/** Signal each pid, ignoring the ones that are already gone. */
function signalEach(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch {
      // ESRCH (already exited) or EPERM (not ours) — nothing to do either way.
    }
  }
}

/**
 * Graceful shutdown helper: SIGTERM all processes, escalate to SIGKILL,
 * and resolve only after every one of them has exited. The manager calls
 * this from its disposer so no sub-agent survives a host shutdown.
 */
export async function killAllGraceful(processes: readonly ManagedProcess[], graceMs = 2_000): Promise<void> {
  await Promise.all(processes.map((proc) => proc.killGraceful(graceMs)))
}
