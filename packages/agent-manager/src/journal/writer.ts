import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import path from 'node:path'
import { JournalError } from '../errors.js'
import type { ChannelEvent, JournalEvent, JournalEventKind, JournalEventRole } from './types.js'

/**
 * Minimal logger contract used by the journal. Cordis loggers satisfy this
 * shape structurally; tests can provide a small spy.
 */
export interface JournalLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface JournalWriterOptions {
  /** Absolute or cwd-relative path of the JSONL journal file. */
  file: string
  /** Optional logger; defaults to silent. */
  logger?: JournalLogger
}

/**
 * Append-only, JSONL event journal.
 *
 * Each physical line is one `JournalEvent`, rather than a harness-native
 * record. The file descriptor is opened in append mode and each event is
 * written synchronously: a channel callback can append while `sendChat` is
 * waiting, and a reader in another part of the process sees the event without
 * waiting for a turn promise or a stream flush. The small synchronous write is
 * intentional; it is the journal's durability boundary, not the harness I/O
 * path.
 */
export class JournalWriter {
  private readonly logger?: JournalLogger
  private readonly file: string
  private readonly fd: number
  private nextSeq: number
  private closed = false

  constructor(options: JournalWriterOptions) {
    this.logger = options.logger
    this.file = path.resolve(options.file)
    mkdirSync(path.dirname(this.file), { recursive: true })
    this.nextSeq = readLastSeq(this.file)
    try {
      this.fd = openSync(this.file, 'a')
    } catch (error) {
      throw new JournalError(`Cannot open journal file "${this.file}"`, { cause: error })
    }
    this.logger?.info(`Journal opened at ${this.file} (next seq ${this.nextSeq})`)
  }

  /**
   * Append one event and return the complete record, including its cursor and
   * timestamp. The append is independent of any in-flight `sendChat` call.
   */
  append(agentId: string, kind: JournalEventKind, role: JournalEventRole, payload: unknown): JournalEvent {
    if (this.closed) throw new JournalError('Journal writer is closed')
    const event: JournalEvent = {
      seq: this.nextSeq,
      timestamp: Date.now(),
      agentId,
      kind,
      role,
      payload,
    }
    this.nextSeq += 1
    try {
      writeSync(this.fd, `${JSON.stringify(event)}\n`, undefined, 'utf8')
    } catch (error) {
      throw new JournalError(`Failed to append journal event ${event.seq}`, { cause: error })
    }
    return event
  }

  /** Convenience wrapper accepting a channel event sink value. */
  appendChannelEvent(agentId: string, event: ChannelEvent): JournalEvent {
    return this.append(agentId, event.kind, event.role, event.payload)
  }

  /** Last assigned sequence number (for diagnostics and tests). */
  get lastSeq(): number {
    return this.nextSeq - 1
  }

  /** Ensure all appended bytes have reached the filesystem's write boundary. */
  async flush(): Promise<void> {
    if (this.closed) throw new JournalError('Journal writer is closed')
    try {
      fsyncSync(this.fd)
    } catch (error) {
      throw new JournalError('Journal fsync failed', { cause: error })
    }
  }

  /** Close the journal descriptor. Safe to call more than once. */
  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      fsyncSync(this.fd)
    } catch (error) {
      this.logger?.error(`Journal close failed: ${String(error)}`)
    } finally {
      closeSync(this.fd)
    }
    this.logger?.info('Journal closed')
  }
}

/**
 * Read the last valid line while tolerating a crash-truncated tail.
 * Returns the next sequence number, preserving cursor monotonicity across a
 * manager restart. Both the current raw-event format and the early scaffold's
 * `{ seq, event }` wrapper are accepted for migration safety.
 */
function readLastSeq(file: string): number {
  if (!existsSync(file)) return 0
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch (error) {
    throw new JournalError(`Cannot read journal file "${file}"`, { cause: error })
  }
  try {
    const content = readFileSync(file, 'utf8')
    const lines = content.split(/\r?\n/)
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim()
      if (line === undefined || line === '') continue
      try {
        const parsed: unknown = JSON.parse(line)
        const record = parsed as { seq?: unknown; event?: { seq?: unknown } }
        const seq = typeof record.seq === 'number'
          ? record.seq
          : typeof record.event?.seq === 'number'
            ? record.event.seq
            : undefined
        if (typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0) return seq + 1
      } catch {
        // Continue backwards to the last complete valid record.
      }
    }
    return 0
  } catch {
    // A truncated final line is ignored; the next append starts from the last
    // complete event that a future reader can still consume.
    return 0
  } finally {
    closeSync(fd)
  }
}
