import type { VerificationEvidence } from '@dsh/core'

import type { HiddenContextReport } from './hidden-context.js'
import type { JournalMetrics } from './journal-metrics.js'
import type { CandidateScore } from './score-candidate.js'

/** Everything recorded about one arm (one role version) of a comparison. */
export interface ArmRecord {
  /** `baseline` or `candidate` (or any label the caller chose). */
  label: string
  roleId: string
  roleVersion: string
  roleHash: string
  /** Hash of the project layer that ran on top of the role, when the source had one. */
  projectLayerHash?: string
  /** Provenance of the role definition, e.g. `git:0123456^`. */
  roleSource: string
  roleSourceCommit?: string
  runId: string
  runStatus: string
  step: {
    status: string
    attempts: number
    failure?: { code?: string; message: string }
  }
  attempt?: {
    agentId?: string
    outcome?: string
    /** Reason the turn did not end in `succeeded` (timeout, abort, harness error). */
    error?: string
    /** Reply text, as the role returned it. Evidence of what it *said*, not of what it did. */
    summary?: string
    model?: string
    /** Tool calls the channel reported for the turn. */
    toolCalls?: number
    /** The role's own declared verification, as attached to the reply. */
    verification?: { passed: boolean; failedRules: number; totalRules: number }
    evidence?: VerificationEvidence
    resultCommit?: string
    startedAt?: number
    finishedAt?: number
    durationMs?: number
  }
  journal?: JournalMetrics
  journalFile: string
  runsDir: string
  /** The captured candidate commit, present whether the step merged or failed. */
  candidateCommit?: string
  /** What `harness_context: hide` moved out of this arm's worktree for the turn. */
  hiddenContext?: HiddenContextReport
  /** Layer 1: hidden acceptance checks run against {@link ArmRecord.candidateCommit}. */
  hidden?: CandidateScore
  /** The layered scorecard, derived from everything above. */
  scorecard?: Scorecard
  /** Set when the arm could not run at all (setup failure), with the reason. */
  error?: string
  /** 1-based position in which the arm ran (see `ComparisonRecord.ordering`). Absent in records made before arm order was randomized. */
  runPosition?: number
}

/**
 * One arm's reading, in layers. Higher layers are only meaningful when the
 * lower ones hold, which is why the verdict compares them in order rather
 * than summing them into a single score: any weighting between
 * "correctness" and "time" would be an opinion, and this record is meant to
 * hold only what was counted.
 */
export interface Scorecard {
  /** Layer 0 — the gate: the turn ended normally, every visible check passed, nothing was refused. */
  delivered: boolean
  /** Why the gate was not met, when it was not. */
  gateFailures: string[]
  /**
   * Set when the arm failed for a reason outside the role — account quota,
   * provider outage, sandbox or host setup — with the failure code. Such an
   * arm's numbers say nothing about the role, so the verdict does not
   * compare it at all.
   */
  environmentFailure?: string
  /** Layer 1 — correctness, from the hidden checks. Absent when the manifest declares none. */
  correctness?: { passed: number; total: number }
  /** Layer 2 — cost. `effectiveMs` excludes provider stalls; `stalledMs` reports them separately. */
  cost: {
    effectiveMs?: number
    wallMs?: number
    stalledMs: number
    stalls: number
    /** Quiet stretches the harness said were the model working; included in `effectiveMs`. */
    thinkingMs?: number
    /** Model requests the harness reported retrying. */
    providerRetries?: number
    /**
     * Whether the stall/thinking split rests on harness evidence. `unverified`:
     * the journal has no activity events (written in older records, or a
     * harness that reports none), so a long silence was counted as a stall
     * without knowing whether the model was thinking through it.
     */
    stallAttribution?: 'evidenced' | 'unverified'
    toolCalls?: number
    errors?: number
  }
}

export interface ComparisonRecord {
  schemaVersion: 1
  id: string
  createdAt: number
  task: {
    id: string
    title: string
    role: string
    baseCommit: string
    /** Names of the controller-side setup commands run in every worktree before the agent, if any. */
    setup?: string[]
    /** Names of the hidden acceptance checks, if any. */
    hiddenChecks?: string[]
    checks: string[]
    /** Sandbox mode the manifest imposed on every arm, if any. */
    sandbox?: string
    /** Harness the manifest (or the CLI) imposed on every arm, if any. */
    harness?: string
    /** Whether the project's harness instructions were in the worktree during the turn. Absent: `keep` (records in older records). */
    harnessContext?: 'keep' | 'hide'
    manifestFile?: string
  }
  repoRoot: string
  /** Per-arm private repositories (base commit only); kept only with `keepClone`, and may be gone by the time this is read. */
  cloneRoots?: string[]
  arms: ArmRecord[]
  /**
   * How the order the arms ran in was chosen (comparison guidance: randomize, so provider
   * load, quota and time of day do not always land on the same arm). `arms`
   * itself stays in the order given; each arm's `runPosition` says when it
   * ran. Absent in records made before arm order was randomized, which
   * always ran in the order given.
   */
  ordering?: { mode: 'random' | 'as-given'; seed?: number }
  /** Machine-generated caveats a reader must see before trusting the numbers. */
  notes: string[]
  /**
   * The machine-written reading: the arms compared layer by layer, in
   * order, stopping at the first layer that separates them. Empty when
   * there are not exactly two arms.
   */
  verdict?: string[]
}

/** Failure codes that describe the environment the arm ran in, not the role. */
const ENVIRONMENT_FAILURES = new Set([
  'provider_unavailable',
  'provider_rate_limited',
  'provider_auth_failed',
  'sandbox_unavailable',
  'host_io_failed',
])

/** Build one arm's scorecard. Pure. */
export function deriveScorecard(arm: ArmRecord): Scorecard {
  const gateFailures: string[] = []
  if (arm.error !== undefined) gateFailures.push(`未能运行：${arm.error}`)
  if (arm.attempt?.outcome !== undefined && arm.attempt.outcome !== 'succeeded') {
    gateFailures.push(`回合未正常结束（${arm.attempt.outcome}）`)
  }
  if (arm.step.status !== 'merged' && arm.step.status !== 'succeeded') {
    gateFailures.push(`step ${arm.step.status}${arm.step.failure === undefined ? '' : `（${arm.step.failure.code ?? 'failure'}）`}`)
  }
  const violations = arm.journal?.policyViolations
  if (violations !== undefined && violations > 0) gateFailures.push(`${violations} 次策略拒绝`)
  const code = arm.step.failure?.code
  const environmentFailure = arm.error !== undefined
    ? 'setup'
    : code !== undefined && ENVIRONMENT_FAILURES.has(code) ? code : undefined
  return {
    delivered: gateFailures.length === 0,
    gateFailures,
    ...(environmentFailure === undefined ? {} : { environmentFailure }),
    ...(arm.hidden === undefined ? {} : { correctness: { passed: arm.hidden.passed, total: arm.hidden.total } }),
    cost: {
      ...(arm.journal?.effectiveMs === undefined ? {} : { effectiveMs: arm.journal.effectiveMs }),
      ...(arm.journal?.wallMs === undefined ? {} : { wallMs: arm.journal.wallMs }),
      stalledMs: arm.journal?.stalledMs ?? 0,
      stalls: arm.journal?.stalls.length ?? 0,
      ...(arm.journal?.thinkingMs === undefined ? {} : { thinkingMs: arm.journal.thinkingMs }),
      ...(arm.journal?.providerRetries === undefined ? {} : { providerRetries: arm.journal.providerRetries }),
      ...(arm.journal === undefined ? {} : { stallAttribution: (arm.journal.activityEvents ?? 0) > 0 ? 'evidenced' as const : 'unverified' as const }),
      ...(arm.journal?.toolCalls === undefined ? {} : { toolCalls: arm.journal.toolCalls }),
      ...(arm.journal?.errors === undefined ? {} : { errors: arm.journal.errors }),
    },
  }
}

/**
 * Compare two arms layer by layer and say what separates them.
 *
 * Lexicographic, never a weighted sum: delivery, then correctness, then
 * cost. The first layer that differs is the reading, and the rest is
 * reported as context. "No measurable difference" is a legitimate — and
 * common — outcome, and saying so is the point of the tool.
 */
export function deriveVerdict(arms: readonly ArmRecord[]): string[] {
  if (arms.length !== 2) return []
  const [a, b] = arms as [ArmRecord, ArmRecord]
  const sa = a.scorecard ?? deriveScorecard(a)
  const sb = b.scorecard ?? deriveScorecard(b)
  const lines: string[] = []

  const broken = [[a, sa], [b, sb]].filter(([, card]) => (card as Scorecard).environmentFailure !== undefined) as Array<[ArmRecord, Scorecard]>
  if (broken.length > 0) {
    // An arm stopped by its environment has no numbers about the role. Ranking
    // it anyway produced "correctness: baseline higher (1/1 vs 0/1)" for an
    // arm the account quota refused after 3 seconds.
    lines.push(`交付：${broken.map(([arm, card]) => `${arm.label} 因环境原因没能完成（${card.environmentFailure}：${arm.step.failure?.message ?? arm.error ?? ''}）`).join('；')}——这一轮的差异不反映角色，不做比较。`)
    lines.push(`仅供参考（不比较）：${[[a, sa], [b, sb]].map(([arm, card]) => {
      const c = (card as Scorecard)
      return `${(arm as ArmRecord).label} 隐藏检查 ${c.correctness === undefined ? '—' : `${c.correctness.passed}/${c.correctness.total}`}、有效耗时 ${c.cost.effectiveMs === undefined ? '—' : `${Math.round(c.cost.effectiveMs / 1000)}s`}`
    }).join('；')}。`)
    lines.push('处理：排除环境问题后重跑这一轮。')
    return lines
  }

  if (sa.delivered !== sb.delivered) {
    const [won, lost] = sa.delivered ? [a, b] : [b, a]
    const lostCard = sa.delivered ? sb : sa
    lines.push(`交付：只有 ${won.label} 通过门槛；${lost.label} ${lostCard.gateFailures.join('、')}。`)
  } else if (!sa.delivered) {
    lines.push(`交付：两臂都没通过门槛（${a.label}：${sa.gateFailures.join('、')}；${b.label}：${sb.gateFailures.join('、')}）——这道题这一轮没有可比的结论。`)
  } else {
    lines.push('交付：两臂都通过门槛。')
  }

  if (sa.correctness === undefined || sb.correctness === undefined) {
    lines.push('正确性：manifest 没有声明隐藏验收检查——"检查通过"只说明角色自己写的测试没红，不构成正确性证据。')
  } else if (sa.correctness.passed !== sb.correctness.passed) {
    const [better, worse] = sa.correctness.passed > sb.correctness.passed ? [a, b] : [b, a]
    const bs = sa.correctness.passed > sb.correctness.passed ? sa : sb
    const ws = sa.correctness.passed > sb.correctness.passed ? sb : sa
    lines.push(`正确性：${better.label} 更高（隐藏检查 ${bs.correctness!.passed}/${bs.correctness!.total} vs ${worse.label} ${ws.correctness!.passed}/${ws.correctness!.total}）。`)
  } else {
    lines.push(`正确性：相同（两臂隐藏检查均 ${sa.correctness.passed}/${sa.correctness.total}）。`)
  }

  const ea = sa.cost.effectiveMs
  const eb = sb.cost.effectiveMs
  if (ea === undefined || eb === undefined || ea <= 0 || eb <= 0) {
    lines.push('代价：有效耗时不可用（journal 缺少 spawn 或结束事件）。')
  } else {
    const ratio = ea > eb ? ea / eb : eb / ea
    const slower = ea > eb ? a : b
    lines.push(ratio < 1.2
      ? `代价：有效耗时相当（${Math.round(ea / 1000)}s vs ${Math.round(eb / 1000)}s，差距 <20%）。`
      : `代价：${slower.label} 有效耗时是另一臂的 ${ratio.toFixed(1)}×（${Math.round(ea / 1000)}s vs ${Math.round(eb / 1000)}s）。`)
  }
  const troubled = [a, b].filter((arm) => {
    const cost = (arm.scorecard ?? deriveScorecard(arm)).cost
    return cost.stalls > 0 || (cost.providerRetries ?? 0) > 0
  })
  if (troubled.length > 0) {
    lines.push(`环境：${troubled.map((arm) => {
      const cost = (arm.scorecard ?? deriveScorecard(arm)).cost
      const parts: string[] = []
      if (cost.stalls > 0) parts.push(`${cost.stalls} 次停顿共 ${Math.round(cost.stalledMs / 1000)}s${cost.stallAttribution === 'unverified' ? '（journal 没有活动心跳，归因未经验证，可能含模型思考）' : ''}`)
      if ((cost.providerRetries ?? 0) > 0) parts.push(`provider 重试 ${cost.providerRetries} 次`)
      return `${arm.label} ${parts.join('、')}`
    }).join('；')}——停顿已从有效耗时中剔除，但会挤占回合预算，是这一轮能不能交付的真实因素。`)
  }
  const thinkers = [a, b].filter((arm) => ((arm.scorecard ?? deriveScorecard(arm)).cost.thinkingMs ?? 0) > 0)
  if (thinkers.length > 0) {
    lines.push(`思考：${thinkers.map((arm) => `${arm.label} ${Math.round(((arm.scorecard ?? deriveScorecard(arm)).cost.thinkingMs ?? 0) / 1000)}s`).join('；')}——长时间没有可见动作、但 harness 报告模型在推理的时段，算角色自己的耗时，已计入有效耗时。`)
  }
  lines.push('本条为按层依次比较（交付 → 正确性 → 代价）的机械输出，不做加权总分；N=1，不构成统计结论。')
  return lines
}

/** Generate the caveats. Pure; safe to call on any record. */
export function deriveNotes(record: Omit<ComparisonRecord, 'notes'>): string[] {
  const notes: string[] = []
  const arms = record.arms
  for (const arm of arms) {
    if (arm.error !== undefined) {
      notes.push(`${arm.label}: 未能运行（${arm.error}）——这一臂没有任何可比数据。`)
      continue
    }
    const environmentCode = arm.step.failure?.code
    if (environmentCode !== undefined && ENVIRONMENT_FAILURES.has(environmentCode)) {
      notes.push(`${arm.label}: 因环境原因失败（${environmentCode}）——账号额度、provider 或宿主环境的问题，这一臂的数字不反映角色，本轮不应据此下结论。`)
    }
    if (arm.attempt?.outcome !== undefined && arm.attempt.outcome !== 'succeeded') {
      notes.push(`${arm.label}: 角色的回合没有正常结束（${arm.attempt.outcome}${arm.attempt.error === undefined ? '' : `：${arm.attempt.error}`}）——检查没有运行，改动文件数/diff 是截止那一刻 worktree 的状态，不是完成态。`)
    }
    const toolCalls = arm.journal?.toolCalls ?? arm.attempt?.toolCalls
    if (toolCalls === 0) {
      notes.push(`${arm.label}: journal 里没有任何 tool_call——角色可能只声明了意图没有动手，"通过检查"不能当成"完成了任务"。`)
    }
    const changed = arm.attempt?.evidence?.changedPaths
    if (changed !== undefined && changed.length === 0) {
      notes.push(`${arm.label}: 候选 commit 没有改动任何文件。`)
    }
    if (arm.journal !== undefined && arm.journal.stalls.length > 0 && (arm.journal.activityEvents ?? 0) === 0) {
      notes.push(`${arm.label}: journal 里有 ${arm.journal.stalls.length} 段长时间静默，但没有任何活动心跳（旧记录，或 harness 不报告进度）——这些静默按"环境停顿"从有效耗时中剔除了，但其中可能有模型在思考，有效耗时可能偏低。`)
    }
    if (arm.attempt?.verification === undefined && arm.journal?.verification === undefined) {
      notes.push(`${arm.label}: 角色没有声明 verification 规则（或规则没有运行），"角色自检"一栏为空不代表通过。`)
    }
  }
  if (record.task.harnessContext === 'hide') {
    const hidden = [...new Set(arms.flatMap((arm) => arm.hiddenContext?.hidden ?? []))]
    notes.push(hidden.length === 0
      ? 'harness_context: hide，但起点 commit 里没有任何 harness 说明文件，这次运行与 keep 等价。'
      : `harness_context: hide——角色回合期间，起点的 ${hidden.length} 个 harness 说明文件被移出了 worktree（${hidden.join('、')}）：这次比较的是角色本身，不是日常使用条件。用户级说明文件（~/.claude/CLAUDE.md、~/.codex/AGENTS.md）不受影响，两臂同样读到。`)
    for (const arm of arms) {
      if (arm.hiddenContext?.keptAgentVersion !== undefined) {
        notes.push(`${arm.label}: 角色在回合中重新创建了被隐藏的 ${arm.hiddenContext.keptAgentVersion.join('、')}，候选提交保留的是它写的版本。`)
      }
    }
  }
  const policies = new Set(arms.filter((arm) => arm.error === undefined).map((arm) => String(arm.journal?.spawned?.policyApplied ?? 'unknown')))
  if (policies.size > 1) {
    notes.push('两臂的策略解析结果不同（policyApplied 不一致）——一个版本声明了 tool_request 而另一个没有，权限面不同，不是纯粹的提示词对比。')
  }
  const harnesses = new Set(arms.map((arm) => arm.journal?.spawned?.harness).filter((value): value is string => value !== undefined))
  if (harnesses.size > 1) {
    notes.push(`两臂使用了不同的 harness（${[...harnesses].join(' / ')}），模型/工具面不同。`)
  }
  const layers = new Set(arms.map((arm) => arm.projectLayerHash ?? 'none'))
  if (layers.size > 1) {
    notes.push(`两臂的项目层不同（${arms.map((arm) => `${arm.label}：${arm.projectLayerHash === undefined ? '无项目层' : arm.projectLayerHash.slice(0, 12)}`).join('；')}）——差异可能来自角色本体，也可能来自项目层，这一轮分不开两者。`)
  }
  if (record.ordering?.mode !== 'random' && arms.length > 1) {
    const first = arms.find((arm) => arm.runPosition === 1)
    notes.push(`执行顺序没有随机化${first === undefined ? '' : `，${first.label} 先跑`}——provider 负载、额度消耗和时段差异会系统性地落在同一臂上。`)
  }
  const contents = new Set(arms.map((arm) => `${arm.roleHash}+${arm.projectLayerHash ?? ''}`))
  if (contents.size < arms.length) {
    notes.push('至少两臂的角色内容哈希（及项目层）相同——它们跑的是同一份角色定义，差异只能来自模型的随机性。')
  }
  return notes
}

/** Render the record as a Markdown page: one row per metric, one column per arm. */
export function renderComparisonMarkdown(record: ComparisonRecord): string {
  const arms = record.arms
  const card = (arm: ArmRecord): Scorecard => arm.scorecard ?? deriveScorecard(arm)
  const ms = (value: number | undefined): string | undefined => value === undefined ? undefined : `${Math.round(value / 1000)}s`
  const header = `| 指标 | ${arms.map((arm) => arm.label).join(' | ')} |`
  const divider = `|---|${arms.map(() => '---').join('|')}|`
  const row = (name: string, pick: (arm: ArmRecord) => string | number | boolean | undefined): string =>
    `| ${name} | ${arms.map((arm) => fmt(pick(arm))).join(' | ')} |`

  const lines: string[] = []
  lines.push(`# 角色对比记录：${record.task.role} · ${record.task.title}`)
  lines.push('')
  lines.push(`- 记录 id：\`${record.id}\``)
  lines.push(`- 生成时间：${new Date(record.createdAt).toISOString()}`)
  lines.push(`- 任务：\`${record.task.id}\`${record.task.manifestFile === undefined ? '' : `（${record.task.manifestFile}）`}`)
  lines.push(`- 起点 commit：\`${record.task.baseCommit}\``)
  if (record.task.setup !== undefined && record.task.setup.length > 0) lines.push(`- 准备步骤（agent 进场前、控制端执行）：${record.task.setup.map((name) => `\`${name}\``).join('、')}`)
  if (record.task.sandbox !== undefined) lines.push(`- 沙箱（manifest 统一指定）：\`${record.task.sandbox}\``)
  if (record.task.harness !== undefined) lines.push(`- harness（统一指定，覆盖角色声明）：\`${record.task.harness}\``)
  lines.push(`- 项目说明文件（CLAUDE.md / AGENTS.md 等）：${record.task.harnessContext === 'hide' ? '**隐藏**（角色回合期间移出 worktree，比较的是角色本身）' : '保留（与日常使用一致，比较的是角色 + 项目说明）'}`)
  lines.push(`- 可见检查（门槛，角色能读到）：${record.task.checks.map((name) => `\`${name}\``).join('、')}`)
  if (record.task.hiddenChecks !== undefined && record.task.hiddenChecks.length > 0) {
    lines.push(`- 隐藏检查（正确性，角色看不到，跑在候选提交上）：${record.task.hiddenChecks.map((name) => `\`${name}\``).join('、')}`)
  }
  lines.push(`- 仓库：\`${record.repoRoot}\``)
  const ran = [...arms].filter((arm) => arm.runPosition !== undefined).sort((a, b) => a.runPosition! - b.runPosition!)
  if (ran.length > 0) {
    const how = record.ordering?.mode === 'random' ? `随机，种子 ${record.ordering.seed ?? '?'}` : '按给定顺序'
    lines.push(`- 执行顺序：${ran.map((arm) => arm.label).join(' → ')}（${how}）`)
  }
  lines.push('')
  if (record.verdict !== undefined && record.verdict.length > 0) {
    lines.push('## 读数')
    lines.push('')
    for (const line of record.verdict) lines.push(`- ${line}`)
    lines.push('')
  }
  lines.push('## 记分卡')
  lines.push('')
  lines.push(header)
  lines.push(divider)
  lines.push(row('0 · 交付（门槛）', (arm) => card(arm).delivered ? '通过' : `未通过：${card(arm).gateFailures.join('、')}`))
  lines.push(row('1 · 正确性（隐藏检查）', (arm) => {
    const correctness = card(arm).correctness
    if (correctness === undefined) return undefined
    return `${correctness.passed}/${correctness.total}${arm.hidden?.error === undefined ? '' : `（${arm.hidden.error}）`}`
  }))
  lines.push(row('2 · 有效耗时（剔除停顿）', (arm) => ms(card(arm).cost.effectiveMs)))
  lines.push(row('2 · 停顿（环境）', (arm) => {
    const cost = card(arm).cost
    const stalls = cost.stalls === 0 ? '无' : `${cost.stalls} 次 / ${ms(cost.stalledMs)}${cost.stallAttribution === 'unverified' ? '（未经验证）' : ''}`
    return (cost.providerRetries ?? 0) > 0 ? `${stalls}；provider 重试 ${cost.providerRetries} 次` : stalls
  }))
  lines.push(row('2 · 思考（计入有效耗时）', (arm) => {
    const thinking = card(arm).cost.thinkingMs
    return thinking === undefined || thinking === 0 ? '—' : ms(thinking)
  }))
  lines.push('')
  lines.push('## 结果')
  lines.push('')
  lines.push(header)
  lines.push(divider)
  lines.push(row('角色版本', (arm) => arm.roleVersion))
  lines.push(row('角色内容哈希', (arm) => short(arm.roleHash)))
  lines.push(row('项目层哈希', (arm) => arm.projectLayerHash === undefined ? '无' : short(arm.projectLayerHash)))
  lines.push(row('角色来源', (arm) => arm.roleSourceCommit === undefined ? arm.roleSource : `${arm.roleSource} (${short(arm.roleSourceCommit)})`))
  lines.push(row('Run 状态', (arm) => arm.error === undefined ? arm.runStatus : `error: ${arm.error}`))
  lines.push(row('Step 状态', (arm) => arm.step.status))
  lines.push(row('回合结束方式', (arm) => arm.attempt?.outcome))
  lines.push(row('失败原因', (arm) => arm.step.failure === undefined ? undefined : arm.step.failure.code === undefined ? arm.step.failure.message : `${arm.step.failure.code}: ${arm.step.failure.message}`))
  lines.push(row('检查通过', (arm) => checksSummary(arm.attempt?.evidence)))
  lines.push(row('改动文件数', (arm) => arm.attempt?.evidence?.changedPaths?.length))
  lines.push(row('diff 哈希', (arm) => short(arm.attempt?.evidence?.diffHash)))
  lines.push(row('候选 commit', (arm) => short(arm.attempt?.resultCommit)))
  lines.push(row('工具调用（journal）', (arm) => arm.journal?.toolCalls))
  lines.push(row('工具调用（channel 上报）', (arm) => arm.attempt?.toolCalls))
  lines.push(row('assistant 消息数', (arm) => arm.journal?.assistantMessages))
  lines.push(row('错误事件', (arm) => arm.journal?.errors))
  lines.push(row('策略拒绝', (arm) => arm.journal?.policyViolations))
  lines.push(row('角色自检（通过/总）', (arm) => selfCheck(arm)))
  lines.push(row('耗时（attempt）', (arm) => arm.attempt?.durationMs === undefined ? undefined : `${Math.round(arm.attempt.durationMs / 1000)}s`))
  lines.push(row('耗时（journal，含停顿）', (arm) => ms(arm.journal?.wallMs)))
  lines.push(row('候选 commit（含未交付臂）', (arm) => short(arm.candidateCommit)))
  lines.push(row('模型', (arm) => arm.attempt?.model))
  lines.push(row('harness', (arm) => arm.journal?.spawned?.harness))
  lines.push(row('策略已调整', (arm) => arm.journal?.spawned?.policyApplied))
  lines.push(row('agentId', (arm) => arm.attempt?.agentId))
  lines.push(row('runId', (arm) => arm.runId))
  lines.push('')
  if (record.notes.length > 0) {
    lines.push('## 阅读前必看')
    lines.push('')
    for (const note of record.notes) lines.push(`- ${note}`)
    lines.push('')
  }
  for (const arm of arms) {
    const checks = arm.hidden?.checks
    if (checks === undefined || checks.length === 0) continue
    lines.push(`## 隐藏检查输出：${arm.label}`)
    lines.push('')
    for (const check of checks) {
      const status = check.exitCode === 0 ? '通过' : check.signal ? `被 ${check.signal} 终止` : `退出码 ${check.exitCode ?? '?'}`
      lines.push(`### ${check.name} — ${status}${check.durationMs === undefined ? '' : `（${Math.round(check.durationMs / 1000)}s）`}`)
      lines.push('')
      lines.push('```')
      lines.push(check.outputSummary ?? '')
      lines.push('```')
      lines.push('')
    }
  }
  for (const arm of arms) {
    const checks = arm.attempt?.evidence?.checks
    if (checks === undefined || checks.length === 0) continue
    lines.push(`## 可见检查输出：${arm.label}`)
    lines.push('')
    for (const check of checks) {
      const status = check.exitCode === 0 ? '通过' : check.signal ? `被 ${check.signal} 终止` : `退出码 ${check.exitCode ?? '?'}`
      lines.push(`### ${check.name} — ${status}${check.durationMs === undefined ? '' : `（${Math.round(check.durationMs / 1000)}s）`}`)
      lines.push('')
      lines.push('```')
      lines.push(check.outputSummary ?? '')
      lines.push('```')
      lines.push('')
    }
  }
  for (const arm of arms) {
    if (arm.attempt?.summary === undefined) continue
    lines.push(`## 角色回复：${arm.label}`)
    lines.push('')
    lines.push('> 这是角色自己说的，不是证据。证据在上面的检查输出和 journal 计数里。')
    lines.push('')
    lines.push(arm.attempt.summary.trim())
    lines.push('')
  }
  lines.push('## 证据位置')
  lines.push('')
  for (const arm of arms) {
    lines.push(`- ${arm.label}：journal \`${arm.journalFile}\`，run 记录 \`${arm.runsDir}/${arm.runId}/\`（每个修订一个 JSON，编号最大的是最终状态）`)
  }
  lines.push('')
  return lines.join('\n')
}

function checksSummary(evidence: VerificationEvidence | undefined): string | undefined {
  const checks = evidence?.checks
  if (checks === undefined) return evidence === undefined ? undefined : (evidence.passed ? '通过（无检查项）' : '未通过')
  const passed = checks.filter((check) => check.exitCode === 0).length
  return `${passed}/${checks.length}${evidence?.passed ? '' : ' ✗'}`
}

function selfCheck(arm: ArmRecord): string | undefined {
  const journal = arm.journal?.verification
  if (journal !== undefined) return `${journal.passed}/${journal.totalRules}${journal.failed > 0 ? ' ✗' : ''}`
  const reply = arm.attempt?.verification
  if (reply !== undefined) return `${reply.totalRules - reply.failedRules}/${reply.totalRules}${reply.failedRules > 0 ? ' ✗' : ''}`
  return undefined
}

function short(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.slice(0, 12)
}

function fmt(value: string | number | boolean | undefined): string {
  if (value === undefined) return '—'
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ')
}
