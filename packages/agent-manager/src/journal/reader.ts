import { createReadStream, existsSync } from 'node:fs'
import readline from 'node:readline'
import { JournalError } from '../errors.js'
import type { JournalEvent, JournalEventKind, JournalEventRole, ReadConversationOptions, ReadConversationResult } from './types.js'

/** Default page size used when `limit` is omitted. */
export const DEFAULT_PAGE_SIZE = 20

export interface JournalReaderOptions {
  /** Path of the JSONL journal file written by {@link JournalWriter}. */
  file: string
  /** Maximum page size accepted by `readConversation`. */
  maxPageSize?: number
  /** Optional logger; defaults to silent. */
  logger?: {
    warn(message: string): void
  }
}

/**
 * Cursor-paginated reads over the agent-manager journal file.
 *
 * Pagination is **cursor-based on `seq`**, never timestamp-based: several
 * events can share one millisecond, and a timestamp cursor would silently
 * drop or duplicate them. `readConversation` returns events in ascending
 * `seq` order and hands back `nextCursor` (the last returned `seq`) for the
 * next page.
 *
 * Because the writer appends in real time, a reader can poll
 * `readConversation({ after })` during a long `sendChat` and observe fresh
 * `message` / `tool_call` events while the turn is still running
 *.
 */
export class JournalReader {
  private readonly file: string
  private readonly maxPageSize: number
  private readonly logger?: { warn(message: string): void }

  constructor(options: JournalReaderOptions) {
    this.file = options.file
    this.maxPageSize = options.maxPageSize ?? 1000
    this.logger = options.logger
  }

  /** Path of the journal file this reader is attached to. */
  get path(): string {
    return this.file
  }

  /**
   * Return one page of events matching the query, oldest first.
   *
   * - `after` is the `nextCursor` of the previous page (an `seq` cursor).
   * - `before` is an exclusive `seq` upper bound.
   * - `roles` / `kinds` filter the page; filters apply before pagination.
   * - `limit` defaults to {@link DEFAULT_PAGE_SIZE}.
   *
   * @throws {JournalError} when the journal file cannot be read.
   */
  async readConversation(options: ReadConversationOptions): Promise<ReadConversationResult> {
    const limit = options.limit ?? DEFAULT_PAGE_SIZE
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new JournalError(`Invalid limit ${String(options.limit)}: must be a positive integer`)
    }
    if (limit > this.maxPageSize) {
      throw new JournalError(`Limit ${limit} exceeds maximum page size ${this.maxPageSize}`)
    }
    const afterSeq = parseCursor(options.after)
    const beforeSeq = options.before
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0)) {
      throw new JournalError(`Invalid before cursor ${String(beforeSeq)}: expected a non-negative safe integer`)
    }
    if (afterSeq !== undefined && beforeSeq !== undefined && afterSeq >= beforeSeq) {
      return { items: [] }
    }
    const kinds = options.kinds === undefined ? null : new Set<JournalEventKind>(options.kinds)
    const roles = options.roles === undefined ? null : new Set<JournalEventRole>(options.roles)

    const matches: JournalEvent[] = []
    await this.scan((event) => {
      if (event.agentId !== options.agentId) return true
      if (afterSeq !== undefined && event.seq <= afterSeq) return true
      if (beforeSeq !== undefined && event.seq >= beforeSeq) return true
      if (kinds !== null && !kinds.has(event.kind)) return true
      if (roles !== null && !roles.has(event.role)) return true
      matches.push(event)
      // Fetch one extra item so we know whether another page exists.
      return matches.length <= limit
    })

    const hasMore = matches.length > limit
    const items = hasMore ? matches.slice(0, limit) : matches
    return {
      items,
      ...(hasMore ? { nextCursor: String(items[items.length - 1]!.seq) } : {}),
    }
  }

  /**
   * Scan the journal file line by line, invoking `onEvent` for each well
   * formed record. Scanning stops early when `onEvent` returns `false`.
   */
  private async scan(onEvent: (event: JournalEvent) => boolean): Promise<void> {
    if (!existsSync(this.file)) return
    const input = createReadStream(this.file, { encoding: 'utf8' })
    const lines = readline.createInterface({ input, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (line.trim() === '') continue
        let record: unknown
        try {
          record = JSON.parse(line)
        } catch {
          this.logger?.warn(`Journal: skipping malformed line (${line.slice(0, 80)}…)`)
          continue
        }
        // Accept the current raw-event format and the wrapper used by the
        // first scaffold so journals created during development remain useful.
        const event = (record as { event?: JournalEvent }).event ?? (record as JournalEvent)
        if (typeof event !== 'object' || event === null) continue
        const seq = (event as { seq?: unknown }).seq
        if (typeof seq !== 'number') continue
        if (!onEvent(event)) break
      }
    } catch (error) {
      throw new JournalError(`Failed to read journal file "${this.file}"`, { cause: error })
    } finally {
      input.destroy()
    }
  }
}

/**
 * Normalize a `nextCursor`/`after` value to a numeric seq. Returns
 * `undefined` for an empty cursor; throws on a cursor that is not a
 * non-negative integer.
 */
function parseCursor(after: string | undefined): number | undefined {
  if (after === undefined || after === '') return undefined
  if (!/^\d+$/.test(after)) {
    throw new JournalError(`Invalid cursor "${after}": expected a decimal seq string`)
  }
  const value = Number(after)
  if (!Number.isSafeInteger(value)) {
    throw new JournalError(`Invalid cursor "${after}": out of safe integer range`)
  }
  return value
}
