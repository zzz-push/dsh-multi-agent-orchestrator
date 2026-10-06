import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { JournalWriter } from '@dsh/agent-manager'

import { collectJournalMetrics } from '../src/journal-metrics.js'
import { cleanupDirs, dirs } from './fixtures.js'

afterEach(cleanupDirs)

async function journal(): Promise<{ file: string; writer: JournalWriter }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-jm-'))
  dirs.push(dir)
  const file = path.join(dir, 'events.jsonl')
  return { file, writer: new JournalWriter({ file }) }
}

/** Write a journal directly, so event timestamps can be chosen. */
async function timedJournal(events: Array<{ at: number; kind: string; role?: string; payload?: Record<string, unknown> }>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-jm-t-'))
  dirs.push(dir)
  const file = path.join(dir, 'events.jsonl')
  const lines = events.map((event, seq) => JSON.stringify({
    seq,
    timestamp: event.at,
    agentId: 'a',
    kind: event.kind,
    role: event.role ?? 'assistant',
    payload: event.payload ?? (event.kind === 'agent.spawned' ? { roleId: 'worker', harness: 'codex' } : {}),
  }))
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8')
  return file
}

describe('collectJournalMetrics', () => {
  it('separates provider stalls from work: effectiveMs excludes silences over the threshold', async () => {
    const minute = 60_000
    const file = await timedJournal([
      { at: 0, kind: 'agent.spawned', role: 'system' },
      { at: 2 * minute, kind: 'tool_call' },
      // A 20-minute silence: the provider stalled, the harness was not working.
      { at: 22 * minute, kind: 'tool_call' },
      { at: 24 * minute, kind: 'message' },
      // Under the threshold — ordinary thinking time, counted as work.
      { at: 27 * minute, kind: 'chat.replied' },
    ])

    const metrics = await collectJournalMetrics(file, 'a')
    expect(metrics.wallMs).toBe(27 * minute)
    expect(metrics.stalls).toEqual([{ at: 2 * minute, ms: 20 * minute }])
    expect(metrics.stalledMs).toBe(20 * minute)
    expect(metrics.effectiveMs).toBe(7 * minute)

    // The threshold is a parameter, not a constant of the world. It is a
    // strict comparison, so a gap exactly at the threshold still counts as work.
    const strict = await collectJournalMetrics(file, 'a', { stallThresholdMs: 2 * minute })
    expect(strict.stalls.map((stall) => stall.ms)).toEqual([20 * minute, 3 * minute])
    expect(strict.effectiveMs).toBe(4 * minute)
  })

  describe('telling thinking from stalling', () => {
    const minute = 60_000
    const heartbeat = (at: number) => ({ at, kind: 'agent.activity', role: 'system', payload: { activity: 'thinking', phase: 'progress' } })

    it('counts a long quiet stretch covered by heartbeats as thinking — effective time, not a stall', async () => {
      const file = await timedJournal([
        { at: 0, kind: 'agent.spawned', role: 'system' },
        { at: 1 * minute, kind: 'tool_call' },
        heartbeat(4 * minute), heartbeat(8 * minute), heartbeat(12 * minute), heartbeat(16 * minute), heartbeat(20 * minute),
        { at: 21 * minute, kind: 'tool_call' },
      ])
      const metrics = await collectJournalMetrics(file, 'a')
      expect(metrics.stalls).toEqual([])
      expect(metrics.thinking).toEqual([{ at: 1 * minute, ms: 20 * minute, evidence: 'heartbeat' }])
      expect(metrics.effectiveMs).toBe(21 * minute)
      expect(metrics.activityEvents).toBe(5)
    })

    it('splits a stretch where the heartbeats stop: the silent tail is a stall, the covered head is thinking', async () => {
      const file = await timedJournal([
        { at: 0, kind: 'agent.spawned', role: 'system' },
        heartbeat(3 * minute), heartbeat(6 * minute),
        { at: 20 * minute, kind: 'message' },
      ])
      const metrics = await collectJournalMetrics(file, 'a')
      expect(metrics.stalls).toEqual([{ at: 6 * minute, ms: 14 * minute }])
      expect(metrics.thinking).toEqual([{ at: 0, ms: 6 * minute, evidence: 'heartbeat' }])
      expect(metrics.effectiveMs).toBe(6 * minute)
    })

    it('counts the silence inside an open codex reasoning span as reasoning', async () => {
      const file = await timedJournal([
        { at: 0, kind: 'agent.spawned', role: 'system' },
        { at: 2 * minute, kind: 'agent.activity', role: 'system', payload: { activity: 'reasoning', phase: 'started' } },
        { at: 22 * minute, kind: 'agent.activity', role: 'system', payload: { activity: 'reasoning', phase: 'completed' } },
        { at: 23 * minute, kind: 'message' },
      ])
      const metrics = await collectJournalMetrics(file, 'a')
      expect(metrics.stalls).toEqual([])
      expect(metrics.thinking).toEqual([{ at: 2 * minute, ms: 20 * minute, evidence: 'reasoning' }])
      expect(metrics.effectiveMs).toBe(23 * minute)
    })

    it('treats a reasoning silence that ends in a provider retry as a stall — the request hung', async () => {
      const file = await timedJournal([
        { at: 0, kind: 'agent.spawned', role: 'system' },
        { at: 2 * minute, kind: 'agent.activity', role: 'system', payload: { activity: 'reasoning', phase: 'started' } },
        { at: 12 * minute, kind: 'agent.provider_retry', role: 'system', payload: { message: 'stream disconnected' } },
        { at: 13 * minute, kind: 'agent.activity', role: 'system', payload: { activity: 'reasoning', phase: 'completed' } },
        { at: 14 * minute, kind: 'tool_call' },
      ])
      const metrics = await collectJournalMetrics(file, 'a')
      expect(metrics.stalls).toEqual([{ at: 2 * minute, ms: 10 * minute }])
      expect(metrics.thinking).toEqual([])
      expect(metrics.providerRetries).toBe(1)
      expect(metrics.effectiveMs).toBe(4 * minute)
    })

    it('marks a journal without activity events as carrying no evidence either way', async () => {
      const file = await timedJournal([
        { at: 0, kind: 'agent.spawned', role: 'system' },
        { at: 20 * minute, kind: 'message' },
      ])
      const metrics = await collectJournalMetrics(file, 'a')
      expect(metrics.activityEvents).toBe(0)
      expect(metrics.stalls).toHaveLength(1)
      expect(metrics.thinking).toEqual([])
    })
  })

  it('ends the agent\'s time at its last reply: the controller\'s checks afterwards are not the agent\'s stall', async () => {
    const minute = 60_000
    const file = await timedJournal([
      { at: 0, kind: 'agent.spawned', role: 'system' },
      { at: 1 * minute, kind: 'tool_call' },
      { at: 4 * minute, kind: 'chat.replied' },
      // 15 minutes of checks, then the controller closes the agent.
      { at: 19 * minute, kind: 'agent.exited', role: 'system' },
    ])
    const metrics = await collectJournalMetrics(file, 'a')
    expect(metrics.stalls).toEqual([])
    expect(metrics.turnEndedAt).toBe(4 * minute)
    expect(metrics.lastEventAt).toBe(19 * minute)
    expect(metrics.wallMs).toBe(4 * minute)
    expect(metrics.effectiveMs).toBe(4 * minute)
    expect(metrics.exited).toBeDefined()
  })

  it('reports no stalls for a continuously active agent', async () => {
    const file = await timedJournal([
      { at: 0, kind: 'agent.spawned', role: 'system' },
      { at: 10_000, kind: 'tool_call' },
      { at: 20_000, kind: 'tool_result', role: 'user' },
    ])
    const metrics = await collectJournalMetrics(file, 'a')
    expect(metrics.stalls).toEqual([])
    expect(metrics.stalledMs).toBe(0)
    expect(metrics.effectiveMs).toBe(20_000)
  })

  it('counts only the requested agent, across pages, and reads spawn/verification/exit facts', async () => {
    const { file, writer } = await journal()
    writer.append('a', 'agent.spawned', 'system', { roleId: 'worker', roleVersion: '2.0.0', roleHash: 'h'.repeat(64), harness: 'codex', policyApplied: true, cwd: '/w', keepAliveAfterTask: true })
    // Another agent's noise, interleaved.
    writer.append('b', 'agent.spawned', 'system', { roleId: 'other', harness: 'codex', cwd: '/w', keepAliveAfterTask: true })
    writer.append('a', 'chat.sent', 'user', { text: 'do it' })
    writer.append('a', 'message', 'user', { text: 'do it' })
    // More than one page of tool events.
    for (let index = 0; index < 1_200; index += 1) {
      writer.append('a', 'tool_call', 'assistant', { toolUseId: `t${index}`, name: 'shell' })
      writer.append('a', 'tool_result', 'user', { toolUseId: `t${index}`, isError: false })
      writer.append('b', 'tool_call', 'assistant', { toolUseId: `x${index}`, name: 'shell' })
    }
    writer.append('a', 'policy.violation', 'system', { command: 'rm -rf' })
    writer.append('a', 'error', 'system', { message: 'boom' })
    writer.append('a', 'message', 'assistant', { text: 'done' })
    writer.append('a', 'verification.completed', 'system', {
      roleId: 'worker', totalRules: 3, passed: 2, failed: 1,
      results: [{ type: 'output_structure', passed: true }, { type: 'content_policy', passed: true }, { type: 'artifact_exists', passed: false, message: 'missing' }],
    })
    writer.append('a', 'agent.exited', 'system', { exitCode: 0, signal: null })
    await writer.dispose()

    const metrics = await collectJournalMetrics(file, 'a')
    expect(metrics).toMatchObject({
      agentId: 'a',
      spawned: { roleId: 'worker', roleVersion: '2.0.0', roleHash: 'h'.repeat(64), harness: 'codex', policyApplied: true },
      toolCalls: 1_200,
      toolResults: 1_200,
      assistantMessages: 1,
      userMessages: 1,
      errors: 1,
      policyViolations: 1,
      verification: { totalRules: 3, passed: 2, failed: 1 },
      exited: { exitCode: 0, signal: null },
      events: 2_408,
    })
    expect(metrics.verification?.results[2]).toEqual({ type: 'artifact_exists', passed: false, message: 'missing' })
    expect(metrics.wallMs).toBeGreaterThanOrEqual(0)
    expect(metrics.lastEventAt).toBeGreaterThanOrEqual(metrics.spawned!.at)
  })

  it('leaves spawn, verification and exit absent — not zeroed — when the journal has no such events', async () => {
    const { file, writer } = await journal()
    writer.append('a', 'tool_call', 'assistant', { toolUseId: 't0', name: 'shell' })
    await writer.dispose()
    const metrics = await collectJournalMetrics(file, 'a')
    expect(metrics.toolCalls).toBe(1)
    expect(metrics.spawned).toBeUndefined()
    expect(metrics.verification).toBeUndefined()
    expect(metrics.exited).toBeUndefined()
    expect(metrics.wallMs).toBeUndefined()
    // An agent with no events at all.
    expect(await collectJournalMetrics(file, 'nobody')).toMatchObject({ events: 0, toolCalls: 0 })
  })
})
