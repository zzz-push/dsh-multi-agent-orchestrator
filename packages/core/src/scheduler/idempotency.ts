import type { RunAggregate, RunId } from '../run/types.js'

export interface StartRunIdentity {
  runId: RunId
  inputHash: string
}

/** Process-local idempotency index for start_run and command IDs. */
export class IdempotencyRegistry {
  private readonly starts = new Map<string, StartRunIdentity>()
  private readonly commands = new Map<RunId, Set<string>>()

  getStart(key: string, inputHash: string): RunId | undefined {
    const existing = this.starts.get(key)
    if (existing === undefined || existing.inputHash !== inputHash) return undefined
    return existing.runId
  }

  rememberStart(key: string, inputHash: string, runId: RunId): void {
    const existing = this.starts.get(key)
    if (existing !== undefined && (existing.inputHash !== inputHash || existing.runId !== runId)) {
      throw new Error(`Idempotency key ${key} was already used with different input`)
    }
    this.starts.set(key, { runId, inputHash })
  }

  hasCommand(runId: RunId, commandId: string): boolean {
    return this.commands.get(runId)?.has(commandId) ?? false
  }

  rememberCommand(runId: RunId, commandId: string): boolean {
    const commands = this.commands.get(runId) ?? new Set<string>()
    if (commands.has(commandId)) return false
    commands.add(commandId)
    this.commands.set(runId, commands)
    return true
  }

  seed(run: RunAggregate): void {
    if (run.idempotencyKey !== undefined) this.rememberStart(run.idempotencyKey, run.workflowHash, run.id)
    for (const commandId of run.processedCommandIds ?? []) this.rememberCommand(run.id, commandId)
  }
}

export class IdempotencyManager extends IdempotencyRegistry {}
export class InMemoryIdempotencyStore extends IdempotencyRegistry {}

export function isDuplicateCommand(registry: IdempotencyRegistry, runId: RunId, commandId: string): boolean {
  return !registry.rememberCommand(runId, commandId)
}
