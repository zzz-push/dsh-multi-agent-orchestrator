import { describe, expect, it } from 'vitest'

import {
  currentActivity,
  describeToolInput,
  describeToolOutput,
  EMPTY_CONVERSATION,
  loadPersistedWindows,
  MAX_CONVERSATION_ITEMS,
  mergeConversationPage,
  PERSISTED_WINDOWS_KEY,
  savePersistedWindows,
  toConversationEntries,
  type JournalItem,
} from '../src/client/conversation.js'

const item = (seq: number, kind: string, role: string, payload: unknown, timestamp = seq * 1_000): JournalItem => ({ seq, kind, role, payload, timestamp })

describe('conversation paging', () => {
  it('appends only events it has not seen, in seq order, and advances the cursor', () => {
    const first = mergeConversationPage(EMPTY_CONVERSATION, { items: [item(1, 'message', 'user', { text: 'a' }), item(2, 'message', 'assistant', { text: 'b' })], cursor: '2' })
    expect(first.items.map((entry) => entry.seq)).toEqual([1, 2])
    expect(first.cursor).toBe('2')
    const overlapping = mergeConversationPage(first, { items: [item(2, 'message', 'assistant', { text: 'b' }), item(4, 'error', 'system', {}), item(3, 'tool_call', 'assistant', {})], cursor: '4' })
    expect(overlapping.items.map((entry) => entry.seq)).toEqual([1, 2, 3, 4])
    // Nothing new: the same state object comes back, so React does not re-render.
    expect(mergeConversationPage(overlapping, { items: [], cursor: '4' })).toBe(overlapping)
  })

  it('keeps a bounded tail of a very long conversation', () => {
    const many = Array.from({ length: MAX_CONVERSATION_ITEMS + 10 }, (_, index) => item(index + 1, 'message', 'assistant', { text: String(index) }))
    const state = mergeConversationPage(EMPTY_CONVERSATION, { items: many, cursor: String(many.length) })
    expect(state.items).toHaveLength(MAX_CONVERSATION_ITEMS)
    expect(state.items[0]?.seq).toBe(11)
  })
})

describe('conversation entries', () => {
  it('pairs each tool call with its result and leaves heartbeats out', () => {
    const entries = toConversationEntries([
      item(1, 'message', 'user', { text: 'fix it' }),
      item(2, 'agent.activity', 'system', { activity: 'thinking', phase: 'progress' }),
      item(3, 'tool_call', 'assistant', { toolUseId: 't1', name: 'Bash', input: { command: 'pnpm test' } }),
      item(4, 'tool_call', 'assistant', { toolUseId: 't2', name: 'Edit', input: { file_path: 'src/a.ts' } }),
      item(5, 'tool_result', 'user', { toolUseId: 't1', isError: false, content: 'Tests 3 passed' }),
      item(6, 'tool_result', 'user', { toolUseId: 't2', isError: true, content: [{ type: 'text', text: 'no such file' }] }),
      item(7, 'message', 'assistant', { text: 'done' }),
      item(8, 'error', 'system', { code: 'timeout', message: 'turn timed out' }),
    ])
    expect(entries).toEqual([
      { type: 'message', key: 'm1', role: 'user', text: 'fix it', at: 1_000 },
      { type: 'tool', key: 't3', name: 'Bash', summary: 'pnpm test', status: 'ok', output: 'Tests 3 passed', at: 3_000 },
      { type: 'tool', key: 't4', name: 'Edit', summary: 'src/a.ts', status: 'error', output: 'no such file', at: 4_000 },
      { type: 'message', key: 'm7', role: 'assistant', text: 'done', at: 7_000 },
      { type: 'error', key: 'e8', text: 'turn timed out', at: 8_000 },
    ])
  })

  it('summarises tool inputs and outputs of the shapes both harnesses produce', () => {
    expect(describeToolInput('ls -la')).toBe('ls -la')
    expect(describeToolInput(['git', 'status'])).toBe('git status')
    expect(describeToolInput({ command: ['pnpm', 'build'] })).toBe('pnpm build')
    expect(describeToolInput({ changes: [{ path: 'a.ts' }, { path: 'b.ts' }] })).toBe('a.ts, b.ts')
    expect(describeToolInput({ other: 1 })).toBe('{"other":1}')
    expect(describeToolInput('x'.repeat(300))).toHaveLength(160)
    expect(describeToolOutput(undefined)).toBe('')
    expect(describeToolOutput({ exitCode: 0 })).toBe('{"exitCode":0}')
    expect(describeToolOutput('y'.repeat(5_000)).startsWith('…')).toBe(true)
  })
})

describe('what the agent is doing out of sight', () => {
  it('reports thinking from a recent heartbeat, retrying from a recent retry, and idle once anything visible follows', () => {
    const heartbeat = item(1, 'agent.activity', 'system', { activity: 'thinking', phase: 'progress', tokens: 800 }, 10_000)
    expect(currentActivity([heartbeat], 20_000)).toEqual({ kind: 'thinking', since: 10_000, tokens: 800 })
    expect(currentActivity([heartbeat], 90_000)).toEqual({ kind: 'idle' })
    expect(currentActivity([heartbeat, item(2, 'tool_call', 'assistant', {}, 11_000)], 12_000)).toEqual({ kind: 'idle' })
    expect(currentActivity([item(3, 'agent.provider_retry', 'system', { message: 'overloaded' }, 10_000)], 12_000)).toEqual({ kind: 'retrying', since: 10_000, message: 'overloaded' })
    // A codex reasoning span has no heartbeat: open means thinking, however long.
    expect(currentActivity([item(4, 'agent.activity', 'system', { activity: 'reasoning', phase: 'started' }, 10_000)], 900_000)).toMatchObject({ kind: 'thinking' })
    expect(currentActivity([item(5, 'agent.activity', 'system', { activity: 'reasoning', phase: 'completed' }, 10_000)], 11_000)).toEqual({ kind: 'idle' })
    expect(currentActivity([], 0)).toEqual({ kind: 'idle' })
  })
})

describe('persisted drafts and window placement', () => {
  class MemoryStorage {
    readonly values = new Map<string, string>()
    getItem(key: string): string | null { return this.values.get(key) ?? null }
    setItem(key: string, value: string): void { this.values.set(key, value) }
  }

  it('round-trips drafts and geometry, dropping agents that no longer exist', () => {
    const storage = new MemoryStorage()
    const geometry = { left: 10, top: 20, width: 400, height: 300 }
    savePersistedWindows(storage, { drafts: { a: 'half-written', gone: 'x' }, geometries: { a: geometry, gone: geometry } }, new Set(['a']))
    expect(loadPersistedWindows(storage)).toEqual({ drafts: { a: 'half-written' }, geometries: { a: geometry } })
  })

  it('reads anything broken as nothing saved, and never throws', () => {
    const storage = new MemoryStorage()
    expect(loadPersistedWindows(undefined)).toEqual({ drafts: {}, geometries: {} })
    storage.setItem(PERSISTED_WINDOWS_KEY, '{ not json')
    expect(loadPersistedWindows(storage)).toEqual({ drafts: {}, geometries: {} })
    storage.setItem(PERSISTED_WINDOWS_KEY, JSON.stringify({ drafts: { a: 3, b: '' }, geometries: { a: { left: 'x' } } }))
    expect(loadPersistedWindows(storage)).toEqual({ drafts: {}, geometries: {} })
    const throwing = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('full') } }
    expect(loadPersistedWindows(throwing)).toEqual({ drafts: {}, geometries: {} })
    expect(() => savePersistedWindows(throwing, { drafts: {}, geometries: {} }, new Set())).not.toThrow()
  })
})
