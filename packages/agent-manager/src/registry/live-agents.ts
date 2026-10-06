import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { JournalLogger } from '../journal/writer.js'

/**
 * One live agent advertised to every other process on this machine.
 *
 * `AgentManager` publishes an entry when a child opens and withdraws it when
 * the child exits, so a DSH page can list agents that a script, a demo or
 * another host started — as long as they went through `AgentManager`. The
 * entry carries everything a read-only observer needs: where the child runs
 * (`cwd`, the project it belongs to) and which journal holds its history.
 */
/**
 * Marks an agent as one arm of a running role comparison (`@dsh/role-eval`).
 *
 * Such an agent is shown to DSH pages in its own "评估中" group and is
 * observe-only: its owner refuses chat, commands and close requests coming
 * from other processes, because a message typed into a running arm would
 * change what is being measured.
 */
export interface EvaluationContext {
  /** Comparison record id. */
  comparisonId: string
  /** Task manifest id. */
  taskId: string
  /** Arm label, e.g. `baseline` / `candidate`. */
  arm: string
  /**
   * The project the comparison is about. The arm itself runs in a temporary
   * worktree outside any workspace, so pages match on this instead of `cwd`.
   */
  workspace: string
}

export interface LiveAgentEntry {
  /** Manager-generated agent id. */
  agentId: string
  /** Pid of the process whose `AgentManager` owns the channel. */
  ownerPid: number
  /**
   * Random id generated once per `AgentManager` process. `ownerPid`
   * alone is not a safe identity across time: the OS can reassign a pid to an
   * unrelated process after the real owner exits. Every entry from the same
   * owner process carries the same generation; it also names that owner's
   * control socket file, so a pid getting reused can never collide with a
   * stale socket path left behind by a different, earlier process.
   */
  ownerGeneration: string
  /** Absolute path of the owner's control socket (see `control/server.ts`). */
  controlSocketPath: string
  /**
   * OS pid of the actual harness child process, when the `Channel` adapter
   * exposes one. Lets `list()` tell a live orphan (owner gone,
   * this pid still running — the adapter's process outlived the manager
   * that spawned it) from a merely stale entry (owner gone, nothing left
   * running either). Diagnostic only: `list()` logs an orphan, it never
   * signals `childPid` on its own.
   */
  childPid?: number
  /** Role the agent was spawned with. */
  roleId: string
  /**
   * Role definition version / content hash at spawn time. Optional
   * on the wire: an entry written by an agent-manager that predates these
   * fields must still be discoverable, so a reader tolerates their absence.
   */
  roleVersion?: string
  roleHash?: string
  /** Harness behind the channel (`codex`, `claude-code`, …). */
  harness: string
  /** Harness-native session id. */
  harnessSessionId: string
  /** Absolute working directory of the child. */
  cwd: string
  /** Absolute path of the owner's journal, the only trusted conversation source. */
  journalFile: string
  keepAliveAfterTask: boolean
  interactionMode: 'headless' | 'interactive'
  showWindow: boolean
  windowHandle?: string
  /** Epoch ms when the owner published the entry. */
  spawnedAt: number
  /**
   * Turn timeout the owner applies to a `sendChat` that names none — the
   * role's own, or the project policy default. A forwarding
   * process waits this long for the reply instead of a guess of its own.
   */
  chatTimeoutMs?: number
  /** Present when the agent is an arm of a running role comparison. */
  evaluation?: EvaluationContext
}

/** Cross-process advertisement of live agents. */
export interface LiveAgentRegistry {
  /** Publish (or replace) one entry. */
  register(entry: LiveAgentEntry): Promise<void>
  /** Withdraw one entry; unknown ids are a no-op. */
  unregister(agentId: string): Promise<void>
  /** Entries whose owner process is still alive; stale ones are pruned. */
  list(): Promise<LiveAgentEntry[]>
}

/**
 * Registry location shared by every process of one user. `DSH_HOME` wins so a
 * relocated harness home keeps host and scripts on the same directory.
 */
export function defaultLiveAgentRegistryDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
): string {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME
    : path.join(homedir, '.dsh')
  return path.join(home, 'runtime', 'agent-manager', 'live-agents')
}

/** True when a signal-0 probe finds the pid; EPERM still means "exists". */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface FileLiveAgentRegistryOptions {
  /** Directory holding one `<agentId>.json` per live agent. */
  dir: string
  logger?: JournalLogger
  /** Liveness probe, injectable for tests. */
  isAlive?: (pid: number) => boolean
}

/**
 * One JSON file per agent under a shared directory. Writes go through a
 * temp file + rename so a concurrent reader never sees a torn entry, and
 * all operations of one registry are serialized so a fast spawn→exit pair
 * cannot leave the register landing after the unregister.
 */
export class FileLiveAgentRegistry implements LiveAgentRegistry {
  private readonly dir: string
  private readonly logger?: JournalLogger
  private readonly isAlive: (pid: number) => boolean
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: FileLiveAgentRegistryOptions) {
    this.dir = path.resolve(options.dir)
    this.logger = options.logger
    this.isAlive = options.isAlive ?? isProcessAlive
  }

  /** Directory this registry reads and writes. */
  get path(): string {
    return this.dir
  }

  register(entry: LiveAgentEntry): Promise<void> {
    return this.serialize(async () => {
      await mkdir(this.dir, { recursive: true })
      const target = this.fileFor(entry.agentId)
      const temporary = `${target}.${process.pid}.tmp`
      await writeFile(temporary, JSON.stringify(entry), 'utf8')
      await rename(temporary, target)
    })
  }

  unregister(agentId: string): Promise<void> {
    return this.serialize(() => rm(this.fileFor(agentId), { force: true }))
  }

  list(): Promise<LiveAgentEntry[]> {
    return this.serialize(async () => {
      let names: string[]
      try {
        names = await readdir(this.dir)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
      const entries: LiveAgentEntry[] = []
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const file = path.join(this.dir, name)
        const entry = parseLiveAgentEntry(await readFile(file, 'utf8').catch(() => ''))
        if (entry === undefined) {
          this.logger?.warn(`Ignoring malformed live-agent entry ${file}`)
          continue
        }
        if (!this.isAlive(entry.ownerPid)) {
          // The owner is gone, so nothing can drive this child any more; drop
          // the advertisement so pages stop listing a ghost.
          if (entry.childPid !== undefined && this.isAlive(entry.childPid)) {
            // The owner never reached its own dispose()/close() path (a
            // crash, a kill -9, ...) and left its harness child running
            //. This is diagnostic only — killing a pid on the
            // strength of a file another process wrote is not something to
            // do without an operator's explicit say-so — so this only logs;
            // it does not touch `entry.childPid`.
            this.logger?.warn(
              `Agent ${entry.agentId}'s owner (pid ${entry.ownerPid}) is gone but its ${entry.harness} process `
              + `(pid ${entry.childPid}) is still running — orphaned, needs manual cleanup`,
            )
          }
          await rm(file, { force: true }).catch(() => undefined)
          continue
        }
        entries.push(entry)
      }
      return entries.sort((left, right) => left.spawnedAt - right.spawnedAt)
    })
  }

  private fileFor(agentId: string): string {
    if (!/^[A-Za-z0-9_.-]+$/.test(agentId)) throw new Error(`Unsafe agent id for registry file: ${agentId}`)
    return path.join(this.dir, `${agentId}.json`)
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }
}

/** Parse one registry file; anything that is not a complete entry is rejected. */
export function parseLiveAgentEntry(text: string): LiveAgentEntry | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const string = (key: string): string | undefined =>
    typeof record[key] === 'string' && (record[key] as string) !== '' ? record[key] as string : undefined
  const boolean = (key: string): boolean | undefined => typeof record[key] === 'boolean' ? record[key] as boolean : undefined
  const agentId = string('agentId')
  const ownerGeneration = string('ownerGeneration')
  const controlSocketPath = string('controlSocketPath')
  const roleId = string('roleId')
  const harness = string('harness')
  const harnessSessionId = string('harnessSessionId')
  const cwd = string('cwd')
  const journalFile = string('journalFile')
  const keepAliveAfterTask = boolean('keepAliveAfterTask')
  const showWindow = boolean('showWindow')
  const interactionMode = record.interactionMode
  const ownerPid = record.ownerPid
  const spawnedAt = record.spawnedAt
  if (
    agentId === undefined || ownerGeneration === undefined || controlSocketPath === undefined
    || roleId === undefined || harness === undefined || harnessSessionId === undefined
    || cwd === undefined || journalFile === undefined || keepAliveAfterTask === undefined || showWindow === undefined
    || (interactionMode !== 'headless' && interactionMode !== 'interactive')
    || typeof ownerPid !== 'number' || !Number.isInteger(ownerPid)
    || typeof spawnedAt !== 'number' || !Number.isFinite(spawnedAt)
  ) return undefined
  const windowHandle = string('windowHandle')
  const childPid = typeof record.childPid === 'number' && Number.isInteger(record.childPid) ? record.childPid : undefined
  const roleVersion = string('roleVersion')
  const roleHash = string('roleHash')
  const chatTimeoutMs = typeof record.chatTimeoutMs === 'number' && Number.isInteger(record.chatTimeoutMs) && record.chatTimeoutMs > 0 ? record.chatTimeoutMs : undefined
  const evaluation = parseEvaluation(record.evaluation)
  return {
    agentId,
    ownerPid,
    ownerGeneration,
    controlSocketPath,
    ...(childPid === undefined ? {} : { childPid }),
    roleId,
    ...(roleVersion === undefined ? {} : { roleVersion }),
    ...(roleHash === undefined ? {} : { roleHash }),
    harness,
    harnessSessionId,
    cwd,
    journalFile,
    keepAliveAfterTask,
    interactionMode,
    showWindow,
    ...(windowHandle === undefined ? {} : { windowHandle }),
    spawnedAt,
    ...(chatTimeoutMs === undefined ? {} : { chatTimeoutMs }),
    ...(evaluation === undefined ? {} : { evaluation }),
  }
}

/** A malformed evaluation block is dropped, not fatal: the entry stays discoverable as a plain agent. */
function parseEvaluation(value: unknown): EvaluationContext | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const fields = ['comparisonId', 'taskId', 'arm', 'workspace'] as const
  if (!fields.every((key) => typeof record[key] === 'string' && record[key] !== '')) return undefined
  return {
    comparisonId: record.comparisonId as string,
    taskId: record.taskId as string,
    arm: record.arm as string,
    workspace: record.workspace as string,
  }
}
