import type { WindowGeometry } from './model.js'

/** One journal event as the `/conversation` route returns it. */
export interface JournalItem {
  seq: number
  timestamp: number
  kind: string
  role: string
  payload: unknown
}

/** A page of the `/conversation` route. */
export interface ConversationPage {
  items: JournalItem[]
  /** Cursor after the last returned event (or the request's `after` when nothing new). */
  cursor: string | null
  /** Present when more events wait beyond this page. */
  nextCursor: string | null
}

/**
 * What one Agent window holds of its conversation: the events read so far
 * and the cursor to read on from. Windows poll with `after=<cursor>`, so each
 * poll transfers only what is new — before, every poll re-read the
 * first 100 events and a conversation longer than that never showed its end.
 */
export interface ConversationState {
  items: JournalItem[]
  cursor: string | null
}

export const EMPTY_CONVERSATION: ConversationState = { items: [], cursor: null }

/** Events kept per window; older ones are dropped from view (the journal keeps them). */
export const MAX_CONVERSATION_ITEMS = 2_000

/** Append a page, ignoring anything already held, keeping `seq` order and a bounded length. */
export function mergeConversationPage(state: ConversationState, page: Pick<ConversationPage, 'items' | 'cursor'>): ConversationState {
  const lastSeq = state.items.at(-1)?.seq ?? -1
  const fresh = page.items.filter((item) => item.seq > lastSeq).sort((a, b) => a.seq - b.seq)
  const cursor = page.cursor ?? state.cursor
  if (fresh.length === 0) return cursor === state.cursor ? state : { ...state, cursor }
  const items = [...state.items, ...fresh]
  return { items: items.length > MAX_CONVERSATION_ITEMS ? items.slice(items.length - MAX_CONVERSATION_ITEMS) : items, cursor }
}

/** What a window renders: messages, tool calls paired with their results, errors. */
export type ConversationEntry =
  | { type: 'message'; key: string; role: 'user' | 'assistant'; text: string; at: number }
  | { type: 'tool'; key: string; name: string; summary: string; status: 'running' | 'ok' | 'error'; output?: string; at: number }
  | { type: 'error'; key: string; text: string; at: number }

/**
 * Turn events into renderable entries. A `tool_result` is folded into the
 * `tool_call` with the same `toolUseId`; heartbeats and retry reports are not
 * entries (see {@link currentActivity}).
 */
export function toConversationEntries(items: readonly JournalItem[]): ConversationEntry[] {
  const entries: ConversationEntry[] = []
  const toolIndex = new Map<string, number>()
  for (const item of items) {
    const payload = asRecord(item.payload)
    if (item.kind === 'message') {
      const text = typeof payload?.text === 'string' ? payload.text : ''
      if (text === '') continue
      entries.push({ type: 'message', key: `m${item.seq}`, role: item.role === 'user' ? 'user' : 'assistant', text, at: item.timestamp })
    } else if (item.kind === 'tool_call') {
      const id = typeof payload?.toolUseId === 'string' ? payload.toolUseId : `seq-${item.seq}`
      const name = typeof payload?.name === 'string' ? payload.name : 'tool'
      toolIndex.set(id, entries.length)
      entries.push({ type: 'tool', key: `t${item.seq}`, name, summary: describeToolInput(payload?.input), status: 'running', at: item.timestamp })
    } else if (item.kind === 'tool_result') {
      const id = typeof payload?.toolUseId === 'string' ? payload.toolUseId : undefined
      const index = id === undefined ? undefined : toolIndex.get(id)
      const entry = index === undefined ? undefined : entries[index]
      if (entry === undefined || entry.type !== 'tool') continue
      const output = describeToolOutput(payload?.content)
      entries[index!] = { ...entry, status: payload?.isError === true ? 'error' : 'ok', ...(output === '' ? {} : { output }) }
    } else if (item.kind === 'error') {
      const text = typeof payload?.message === 'string' ? payload.message : JSON.stringify(item.payload)
      entries.push({ type: 'error', key: `e${item.seq}`, text, at: item.timestamp })
    }
  }
  return entries
}

/** One line saying what a tool call was about: the command, the file, or the input in brief. */
export function describeToolInput(input: unknown): string {
  if (typeof input === 'string') return truncate(input, 160)
  if (Array.isArray(input)) return truncate(input.map(String).join(' '), 160)
  const record = asRecord(input)
  if (record === undefined) return ''
  for (const key of ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return truncate(value, 160)
    if (Array.isArray(value) && value.length > 0) return truncate(value.map(String).join(' '), 160)
  }
  const changes = record.changes
  if (Array.isArray(changes)) return truncate(changes.map((change) => String(asRecord(change)?.path ?? '?')).join(', '), 160)
  return truncate(JSON.stringify(record), 160)
}

/** The tail of a tool's output, as text. */
export function describeToolOutput(content: unknown): string {
  let text: string
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    text = content.map((part) => {
      const record = asRecord(part)
      return typeof record?.text === 'string' ? record.text : typeof part === 'string' ? part : ''
    }).join('\n')
  } else if (content === undefined || content === null) text = ''
  else text = JSON.stringify(content)
  const trimmed = text.trimEnd()
  return trimmed.length <= 4_000 ? trimmed : `…${trimmed.slice(trimmed.length - 4_000)}`
}

/** What the agent is doing out of sight, from the harness's own reports. */
export type AgentActivity =
  | { kind: 'idle' }
  | { kind: 'thinking'; since: number; tokens?: number }
  | { kind: 'retrying'; since: number; message: string }

/**
 * The latest activity report, if nothing visible happened after it and it is
 * recent: a thinking heartbeat (or an open codex reasoning span), or a
 * provider retry. Heartbeats arrive every 30 s at most, so "recent" allows
 * a little over that.
 */
export function currentActivity(items: readonly JournalItem[], now: number, staleMs = 45_000): AgentActivity {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    const payload = asRecord(item.payload)
    if (item.kind === 'agent.provider_retry') {
      return now - item.timestamp <= staleMs ? { kind: 'retrying', since: item.timestamp, message: typeof payload?.message === 'string' ? payload.message : '' } : { kind: 'idle' }
    }
    if (item.kind === 'agent.activity') {
      if (payload?.phase === 'completed') return { kind: 'idle' }
      // An open reasoning span has no heartbeat; it stays "thinking" until it closes.
      const open = payload?.activity === 'reasoning' && payload.phase === 'started'
      if (!open && now - item.timestamp > staleMs) return { kind: 'idle' }
      return { kind: 'thinking', since: item.timestamp, ...(typeof payload?.tokens === 'number' ? { tokens: payload.tokens } : {}) }
    }
    return { kind: 'idle' }
  }
  return { kind: 'idle' }
}

/** Per-browser state that survives a reload: unsent drafts and window placement. */
export interface PersistedWindows {
  drafts: Record<string, string>
  geometries: Record<string, WindowGeometry>
}

export const PERSISTED_WINDOWS_KEY = 'dsh-agent-manager:windows:v1'

/** Read the saved state; anything unreadable (private mode, corrupt JSON) is an empty state. */
export function loadPersistedWindows(storage: Pick<Storage, 'getItem'> | undefined): PersistedWindows {
  const empty: PersistedWindows = { drafts: {}, geometries: {} }
  try {
    const raw = storage?.getItem(PERSISTED_WINDOWS_KEY)
    if (raw === null || raw === undefined) return empty
    const parsed = asRecord(JSON.parse(raw))
    const drafts: Record<string, string> = {}
    for (const [agentId, draft] of Object.entries(asRecord(parsed?.drafts) ?? {})) {
      if (typeof draft === 'string' && draft !== '') drafts[agentId] = draft
    }
    const geometries: Record<string, WindowGeometry> = {}
    for (const [agentId, value] of Object.entries(asRecord(parsed?.geometries) ?? {})) {
      const geometry = asRecord(value)
      if (geometry !== undefined && ['left', 'top', 'width', 'height'].every((key) => typeof geometry[key] === 'number' && Number.isFinite(geometry[key]))) {
        geometries[agentId] = geometry as unknown as WindowGeometry
      }
    }
    return { drafts, geometries }
  } catch {
    return empty
  }
}

/** Save, keeping only agents that still exist so the entry does not grow forever. Failures are ignored. */
export function savePersistedWindows(storage: Pick<Storage, 'setItem'> | undefined, state: PersistedWindows, liveAgentIds: ReadonlySet<string>): void {
  const keep = <T>(record: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(record).filter(([agentId]) => liveAgentIds.has(agentId)))
  try {
    storage?.setItem(PERSISTED_WINDOWS_KEY, JSON.stringify({ drafts: keep(state.drafts), geometries: keep(state.geometries) }))
  } catch {
    // Storage full or unavailable: persistence is a convenience, not a requirement.
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`
}
