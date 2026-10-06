import { describe, expect, it } from 'vitest'

import { deriveNotes, deriveScorecard, deriveVerdict, renderComparisonMarkdown, type ArmRecord, type ComparisonRecord } from '../src/comparison.js'

function arm(label: string, overrides: Partial<ArmRecord> = {}): ArmRecord {
  return {
    label,
    roleId: 'worker',
    roleVersion: '1.0.0',
    roleHash: `${label}-hash-${'0'.repeat(50)}`,
    roleSource: `git:${label}`,
    runId: `run-${label}`,
    runStatus: 'delivery_ready',
    step: { status: 'merged', attempts: 1 },
    attempt: {
      agentId: `agent-${label}`,
      outcome: 'succeeded',
      summary: 'did it',
      model: 'm',
      toolCalls: 4,
      verification: { passed: true, failedRules: 0, totalRules: 2 },
      evidence: { passed: true, checks: [{ name: 'test', exitCode: 0, durationMs: 1000, outputSummary: 'ok' }], changedPaths: ['a.ts'], diffHash: 'd'.repeat(64) },
      resultCommit: 'c'.repeat(40),
      durationMs: 65_000,
    },
    journal: {
      agentId: `agent-${label}`,
      spawned: { roleId: 'worker', roleHash: `${label}-hash`, harness: 'codex', policyApplied: false, at: 0 },
      toolCalls: 4, toolResults: 4, assistantMessages: 1, userMessages: 1, errors: 0, policyViolations: 0, events: 12,
      verification: { totalRules: 2, passed: 2, failed: 0, results: [] },
      wallMs: 60_000,
      stalls: [],
      stalledMs: 0,
      thinking: [],
      thinkingMs: 0,
      activityEvents: 3,
      providerRetries: 0,
      effectiveMs: 60_000,
    },
    journalFile: `/j/${label}.jsonl`,
    runsDir: '/runs',
    ...overrides,
  }
}

function record(arms: ArmRecord[]): Omit<ComparisonRecord, 'notes'> {
  return {
    schemaVersion: 1,
    id: 'cmp',
    createdAt: 0,
    task: { id: 't', title: 'T', role: 'worker', baseCommit: 'b'.repeat(40), checks: ['test'] },
    repoRoot: '/repo',
    arms,
    // Randomized, as current records are; the fixed-order note has its own test.
    ordering: { mode: 'random', seed: 1 },
  }
}

describe('deriveScorecard', () => {
  it('gates on the turn, the step and policy denials — not on how much was changed', () => {
    expect(deriveScorecard(arm('ok'))).toMatchObject({ delivered: true, gateFailures: [] })

    const cutOff = arm('slow', {
      runStatus: 'waiting_action',
      step: { status: 'failed', attempts: 1, failure: { code: 'step_timeout', message: 'timed out' } },
      attempt: { ...arm('slow').attempt!, outcome: 'failed' },
    })
    const card = deriveScorecard(cutOff)
    expect(card.delivered).toBe(false)
    expect(card.gateFailures).toEqual(['回合未正常结束（failed）', 'step failed（step_timeout）'])

    const quota = deriveScorecard(arm('quota', {
      step: { status: 'failed', attempts: 1, failure: { code: 'provider_rate_limited', message: 'session limit' } },
    }))
    expect(quota.environmentFailure).toBe('provider_rate_limited')
    expect(deriveScorecard(arm('setup', { error: 'workspace setup failed' })).environmentFailure).toBe('setup')
    expect(card.environmentFailure).toBeUndefined()

    const refused = deriveScorecard(arm('denied', {
      journal: { ...arm('denied').journal!, policyViolations: 2 },
    }))
    expect(refused.delivered).toBe(false)
    expect(refused.gateFailures).toEqual(['2 次策略拒绝'])
  })

  it('carries correctness from the hidden checks and cost from the journal', () => {
    const scored = deriveScorecard(arm('x', {
      hidden: { commit: 'a'.repeat(40), passed: 3, total: 4, checks: [] },
      journal: { ...arm('x').journal!, wallMs: 900_000, stalledMs: 600_000, effectiveMs: 300_000, stalls: [{ at: 1, ms: 600_000 }] },
    }))
    expect(scored.correctness).toEqual({ passed: 3, total: 4 })
    expect(scored.cost).toMatchObject({ effectiveMs: 300_000, wallMs: 900_000, stalledMs: 600_000, stalls: 1 })
  })

  it('leaves correctness undefined when the manifest declared no hidden checks', () => {
    expect(deriveScorecard(arm('x')).correctness).toBeUndefined()
  })
})

describe('deriveVerdict', () => {
  const scored = (label: string, overrides: Partial<ArmRecord> = {}): ArmRecord => {
    const value = arm(label, overrides)
    return { ...value, scorecard: deriveScorecard(value) }
  }

  it('stops at the first layer that separates the arms: delivery beats correctness beats cost', () => {
    const verdict = deriveVerdict([
      scored('a', { hidden: { commit: 'c'.repeat(40), passed: 4, total: 4, checks: [] } }),
      scored('b', {
        step: { status: 'failed', attempts: 1, failure: { code: 'step_timeout', message: 't' } },
        hidden: { commit: 'd'.repeat(40), passed: 4, total: 4, checks: [] },
      }),
    ])
    expect(verdict[0]).toContain('只有 a 通过门槛')
    // Lower layers are still reported as context, not dropped.
    expect(verdict[1]).toContain('正确性：相同')
  })

  it('reads correctness when both delivered, and says so when nothing separates them', () => {
    const better = deriveVerdict([
      scored('a', { hidden: { commit: 'c'.repeat(40), passed: 4, total: 4, checks: [] } }),
      scored('b', { hidden: { commit: 'd'.repeat(40), passed: 2, total: 4, checks: [] } }),
    ])
    expect(better[1]).toContain('a 更高（隐藏检查 4/4 vs b 2/4）')

    const same = deriveVerdict([
      scored('a', { hidden: { commit: 'c'.repeat(40), passed: 4, total: 4, checks: [] } }),
      scored('b', { hidden: { commit: 'd'.repeat(40), passed: 4, total: 4, checks: [] } }),
    ])
    expect(same[2]).toContain('有效耗时相当')
  })

  it('compares effective time, not wall clock, and reports stalls as an environment fact', () => {
    const verdict = deriveVerdict([
      // 5 minutes wall clock, all of it work.
      scored('busy', {
        hidden: { commit: 'c'.repeat(40), passed: 4, total: 4, checks: [] },
        journal: { ...arm('busy').journal!, wallMs: 300_000, stalledMs: 0, effectiveMs: 300_000, stalls: [] },
      }),
      // 30 minutes wall clock, 29 of them a provider stall: 1 minute of work.
      scored('stalled', {
        hidden: { commit: 'd'.repeat(40), passed: 4, total: 4, checks: [] },
        journal: { ...arm('stalled').journal!, wallMs: 1_800_000, stalledMs: 1_740_000, effectiveMs: 60_000, stalls: [{ at: 1, ms: 1_740_000 }] },
      }),
    ])
    // On the wall clock `stalled` looks 6× slower; on effective time it is the faster one.
    expect(verdict[2]).toContain('busy 有效耗时是另一臂的 5.0×')
    expect(verdict[3]).toContain('stalled 1 次停顿共 1740s')
  })

  it('reports thinking as the role\'s own time, provider retries as environment, and flags stalls it cannot attribute', () => {
    const verdict = deriveVerdict([
      scored('thinker', {
        hidden: { commit: 'c'.repeat(40), passed: 4, total: 4, checks: [] },
        journal: { ...arm('thinker').journal!, wallMs: 1_200_000, effectiveMs: 1_200_000, thinkingMs: 900_000, thinking: [{ at: 1, ms: 900_000, evidence: 'heartbeat' }] },
      }),
      scored('legacy', {
        hidden: { commit: 'd'.repeat(40), passed: 4, total: 4, checks: [] },
        journal: { ...arm('legacy').journal!, activityEvents: 0, providerRetries: 2, wallMs: 1_200_000, stalledMs: 900_000, effectiveMs: 300_000, stalls: [{ at: 1, ms: 900_000 }] },
      }),
    ])
    expect(verdict.find((line) => line.startsWith('环境：'))).toContain('legacy 1 次停顿共 900s（journal 没有活动心跳，归因未经验证，可能含模型思考）、provider 重试 2 次')
    expect(verdict.find((line) => line.startsWith('思考：'))).toContain('thinker 900s')

    const notes = deriveNotes(record([arm('thinker'), arm('legacy', { journal: { ...arm('legacy').journal!, activityEvents: 0, stalls: [{ at: 1, ms: 900_000 }] } })]))
    expect(notes.some((note) => note.startsWith('legacy: journal 里有 1 段长时间静默，但没有任何活动心跳'))).toBe(true)
    expect(notes.some((note) => note.startsWith('thinker:'))).toBe(false)
  })

  it('does not compare at all when an arm was stopped by its environment', () => {
    const verdict = deriveVerdict([
      scored('baseline', {
        step: { status: 'failed', attempts: 1, failure: { code: 'provider_rate_limited', message: 'You\'ve hit your session limit' } },
        hidden: { commit: 'c'.repeat(40), passed: 1, total: 1, checks: [] },
      }),
      scored('candidate', {
        step: { status: 'failed', attempts: 1, failure: { code: 'provider_rate_limited', message: 'You\'ve hit your session limit' } },
        hidden: { commit: 'd'.repeat(40), passed: 0, total: 1, checks: [] },
      }),
    ])
    expect(verdict[0]).toContain('因环境原因没能完成（provider_rate_limited')
    expect(verdict[0]).toContain('不做比较')
    expect(verdict.join('\n')).not.toMatch(/更高|有效耗时是另一臂/)
    expect(verdict[1]).toContain('仅供参考')
  })

  it('still compares lower layers when both arms failed for role reasons', () => {
    const failed = { status: 'failed', attempts: 1, failure: { code: 'verification_failed', message: 'Check "test" exited with code 1' } }
    const verdict = deriveVerdict([
      scored('a', { step: failed, hidden: { commit: 'c'.repeat(40), passed: 1, total: 1, checks: [] } }),
      scored('b', { step: failed, hidden: { commit: 'd'.repeat(40), passed: 0, total: 1, checks: [] } }),
    ])
    expect(verdict[0]).toContain('两臂都没通过门槛')
    expect(verdict[1]).toContain('a 更高')
  })

  it('refuses to read anything from other than exactly two arms', () => {
    expect(deriveVerdict([scored('only')])).toEqual([])
    expect(deriveVerdict([scored('a'), scored('b'), scored('c')])).toEqual([])
  })

  it('says the checks are not correctness evidence when no hidden checks were declared', () => {
    const verdict = deriveVerdict([scored('a'), scored('b')])
    expect(verdict[1]).toContain('没有声明隐藏验收检查')
  })
})

describe('deriveNotes', () => {
  it('flags a fixed run order, naming who went first when the record knows', () => {
    const { ordering: _ordering, ...legacy } = record([arm('baseline'), arm('candidate', { roleHash: 'h2' })])
    expect(deriveNotes(legacy)).toContain('执行顺序没有随机化——provider 负载、额度消耗和时段差异会系统性地落在同一臂上。')
    const fixed = { ...legacy, ordering: { mode: 'as-given' as const }, arms: [arm('baseline', { runPosition: 2 }), arm('candidate', { roleHash: 'h2', runPosition: 1 })] }
    expect(deriveNotes(fixed)).toContain('执行顺序没有随机化，candidate 先跑——provider 负载、额度消耗和时段差异会系统性地落在同一臂上。')
    expect(renderComparisonMarkdown({ ...fixed, notes: [] })).toContain('- 执行顺序：candidate → baseline（按给定顺序）')
  })

  it('is silent for two healthy, distinct arms', () => {
    expect(deriveNotes(record([arm('baseline'), arm('candidate')]))).toEqual([])
  })

  it('flags an arm that never called a tool, changed nothing, or has no self-check', () => {
    const quiet = arm('candidate', {
      attempt: { ...arm('candidate').attempt, toolCalls: 0, evidence: { passed: true, checks: [], changedPaths: [] }, verification: undefined },
      journal: { ...arm('candidate').journal!, toolCalls: 0, verification: undefined },
    })
    const notes = deriveNotes(record([arm('baseline'), quiet]))
    expect(notes.some((note) => note.startsWith('candidate') && note.includes('tool_call'))).toBe(true)
    expect(notes.some((note) => note.startsWith('candidate') && note.includes('没有改动任何文件'))).toBe(true)
    expect(notes.some((note) => note.startsWith('candidate') && note.includes('verification'))).toBe(true)
    expect(notes.some((note) => note.startsWith('baseline'))).toBe(false)
  })

  it('says when the arms ran different project layers, and does not call role-identical arms identical when their layers differ', () => {
    const notes = deriveNotes(record([arm('v2'), arm('v3', { roleHash: arm('v2').roleHash, projectLayerHash: 'f'.repeat(64) })]))
    expect(notes.some((note) => note.startsWith('两臂的项目层不同（v2：无项目层；v3：ffffffffffff）'))).toBe(true)
    expect(notes.some((note) => note.includes('同一份角色定义'))).toBe(false)
  })

  it('flags unequal permission surfaces, unequal harnesses, identical role content, and arms that did not run', () => {
    const b = arm('baseline')
    const c = arm('candidate', {
      journal: { ...arm('candidate').journal!, spawned: { roleId: 'worker', harness: 'claude-code', policyApplied: true, at: 0 } },
    })
    const notes = deriveNotes(record([b, c]))
    expect(notes.some((note) => note.includes('policyApplied'))).toBe(true)
    expect(notes.some((note) => note.includes('harness') && note.includes('codex / claude-code'))).toBe(true)

    const same = deriveNotes(record([b, arm('candidate', { roleHash: b.roleHash })]))
    expect(same.some((note) => note.includes('角色内容哈希（及项目层）相同'))).toBe(true)

    const broken = deriveNotes(record([b, arm('candidate', { error: 'clone failed', attempt: undefined, journal: undefined })]))
    expect(broken).toEqual(['candidate: 未能运行（clone failed）——这一臂没有任何可比数据。'])
  })
})

describe('renderComparisonMarkdown', () => {
  it('lays out one column per arm with the headline metrics, the checks, the replies, and where the evidence lives', () => {
    const base = record([arm('baseline'), arm('candidate', { roleVersion: '2.0.0' })])
    const markdown = renderComparisonMarkdown({ ...base, notes: deriveNotes(base) })
    expect(markdown).toContain('# 角色对比记录：worker · T')
    expect(markdown).toContain('| 指标 | baseline | candidate |')
    expect(markdown).toContain('| 角色版本 | 1.0.0 | 2.0.0 |')
    expect(markdown).toContain('| 检查通过 | 1/1 | 1/1 |')
    expect(markdown).toContain('| 角色自检（通过/总） | 2/2 | 2/2 |')
    expect(markdown).toContain('| 耗时（attempt） | 65s | 65s |')
    expect(markdown).toContain('### test — 通过（1s）')
    expect(markdown).toContain('## 角色回复：baseline')
    expect(markdown).toContain('这是角色自己说的，不是证据')
    expect(markdown).toContain('/j/baseline.jsonl')
    expect(markdown).not.toContain('## 阅读前必看')
  })

  it('renders missing values as a dash and escapes pipes', () => {
    const bare = arm('x', { attempt: undefined, journal: undefined, step: { status: 'failed', attempts: 1, failure: { message: 'a | b' } } })
    const base = record([bare, arm('y')])
    const markdown = renderComparisonMarkdown({ ...base, notes: [] })
    expect(markdown).toContain('| 失败原因 | a \\| b | — |')
    expect(markdown).toContain('| 工具调用（journal） | — | 4 |')
  })
})
