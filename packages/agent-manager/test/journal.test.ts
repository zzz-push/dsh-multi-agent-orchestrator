import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JournalReader } from '../src/journal/reader.js'
import { JournalWriter } from '../src/journal/writer.js'

const tempDirs: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function journalPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-journal-'))
  tempDirs.push(dir)
  return path.join(dir, 'events.jsonl')
}

describe('JournalWriter and JournalReader', () => {
  it('writes raw append-only events immediately and paginates with seq cursors', async () => {
    const file = await journalPath()
    const writer = new JournalWriter({ file })
    const first = writer.append('agent-1', 'message', 'user', { text: 'one' })
    const second = writer.append('agent-1', 'message', 'assistant', { text: 'two' })
    writer.append('agent-1', 'tool_call', 'assistant', { name: 'Read' })
    expect(first.seq).toBe(0)
    expect(second.seq).toBe(1)
    expect((await readFile(file, 'utf8')).split('\n').filter(Boolean)).toHaveLength(3)

    const reader = new JournalReader({ file })
    const page = await reader.readConversation({ agentId: 'agent-1', limit: 2 })
    expect(page.items.map((item) => item.seq)).toEqual([0, 1])
    expect(page.nextCursor).toBe('1')
    const next = await reader.readConversation({ agentId: 'agent-1', after: page.nextCursor, kinds: ['tool_call'] })
    expect(next.items).toHaveLength(1)
    expect(next.items[0]?.kind).toBe('tool_call')
    expect((await reader.readConversation({ agentId: 'other' })).items).toEqual([])
    await writer.dispose()
  })

  it('resumes sequence numbers after restart and accepts the legacy wrapper', async () => {
    const file = await journalPath()
    const writer = new JournalWriter({ file })
    writer.append('agent-1', 'message', 'assistant', { text: 'persisted' })
    await writer.dispose()
    const restarted = new JournalWriter({ file })
    expect(restarted.append('agent-1', 'message', 'assistant', { text: 'next' }).seq).toBe(1)
    await restarted.dispose()

    const legacyFile = await journalPath()
    await writeFile(legacyFile, `${JSON.stringify({ seq: 9, event: {
      seq: 9,
      timestamp: 1,
      agentId: 'agent-1',
      kind: 'message',
      role: 'assistant',
      payload: { text: 'old' },
    } })}\n`)
    const legacyWriter = new JournalWriter({ file: legacyFile })
    expect(legacyWriter.append('agent-1', 'message', 'assistant', { text: 'new' }).seq).toBe(10)
    await legacyWriter.dispose()

    const truncatedFile = await journalPath()
    await writeFile(truncatedFile, `${JSON.stringify({ seq: 4, agentId: 'agent-1', kind: 'message', role: 'assistant', payload: {} })}\n{broken`)
    const truncatedWriter = new JournalWriter({ file: truncatedFile })
    expect(truncatedWriter.append('agent-1', 'message', 'assistant', { text: 'after-crash' }).seq).toBe(5)
    await truncatedWriter.dispose()
  })

  it('filters roles, applies before bounds, and rejects invalid cursors', async () => {
    const file = await journalPath()
    const writer = new JournalWriter({ file })
    writer.append('agent-1', 'agent.spawned', 'system', {})
    writer.append('agent-1', 'message', 'user', { text: 'hello' })
    writer.append('agent-1', 'message', 'assistant', { text: 'hi' })
    await writer.dispose()
    const reader = new JournalReader({ file })
    const result = await reader.readConversation({ agentId: 'agent-1', roles: ['assistant'], before: 3 })
    expect(result.items.map((item) => item.seq)).toEqual([2])
    await expect(reader.readConversation({ agentId: 'agent-1', after: 'nope' })).rejects.toThrow('Invalid cursor')
    await expect(reader.readConversation({ agentId: 'agent-1', limit: 0 })).rejects.toThrow('Invalid limit')
    await expect(reader.readConversation({ agentId: 'agent-1', limit: 1001 })).rejects.toThrow('exceeds')
  })
})
