import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { JournalReader, type JournalEvent } from '@dsh/agent-manager'
import { GitCli, candidateRef } from '@dsh/workspace-git'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import {
  deriveNotes,
  deriveScorecard,
  deriveVerdict,
  renderComparisonMarkdown,
  type ArmRecord,
  type ComparisonRecord,
} from './comparison.js'
import { DEFAULT_STALL_THRESHOLD_MS, SilenceClassifier, collectJournalMetrics } from './journal-metrics.js'
import { parseRoleSourceSpec, resolveRoleSource, type RoleSourceSpec } from './role-source.js'
import { randomSeed, seededShuffle } from './seeded-shuffle.js'

const execFileAsync = promisify(execFile)

/** Which evaluation phase the bundle is for. `rubric` deliberately contains no results. */
export type EvidencePhase = 'rubric' | 'grade'

export interface BuildEvidenceBundleOptions {
  /** A `comparison.json` written by `compareRoles()`, or the directory holding it. */
  record: string
  /** Bundle directory — the evaluator's cwd. Files this builder owns are replaced; anything else (feedback/, .dsh/) is kept. */
  outDir: string
  phase: EvidencePhase
  /** Replace arm labels with A/B and hide role versions. The mapping is written next to `outDir`, never inside it. */
  blind?: boolean
  /** Seed for the A/B assignment of a new mapping. Ignored when a mapping for this bundle already exists. */
  seed?: number
  gitPath?: string
  stallThresholdMs?: number
}

export interface BlindingMapping {
  recordId: string
  seed: number
  /** Real arm label → blinded label (`A` / `B` / …). */
  arms: Record<string, string>
}

export interface EvidenceBundleResult {
  outDir: string
  phase: EvidencePhase
  /** Relative paths written by this build, sorted. */
  files: string[]
  /** sha256 over every written file except README.md (which quotes it), as `path\0content\0` in path order. */
  contentHash: string
  /** Present when blinded: where the mapping lives (outside `outDir`) and what it is. */
  blinding?: { file: string; mapping: BlindingMapping }
  /** Things the builder had to reconstruct or could not find; also written into README.md. */
  caveats: string[]
}

/** Top-level entries this builder writes and therefore replaces on every build. */
const OWNED = ['README.md', 'task', 'roles', 'results']
const HIDDEN = '<hidden>'

/**
 * Assemble the evidence an evaluator is allowed to see.
 *
 * This is the mechanical half of layer 4: deciding *what* goes in front of
 * the evaluator is not a judgement call, so it is not left to whichever
 * agent happens to drive the evaluation — that agent may well have an
 * opinion about the result (it may even have written one of the
 * solutions). Two guarantees live here:
 *
 * - **Phase isolation.** A `rubric` bundle holds the task and the two role
 *   definitions and nothing else. Results arrive only in a `grade` bundle,
 *   so the scoring criteria are written before anything is known about who
 *   won.
 * - **Blinding.** With `blind`, arm labels become A/B and role versions
 *   become `<hidden>` everywhere the builder writes them; run ids and
 *   worktree paths (which embed the label) are rewritten too. The mapping is
 *   kept next to the bundle, outside the directory the evaluator can read.
 *   It weakens the "the new one should win" prior; it cannot remove it —
 *   the direction of `roles/diff.patch` still hints at which version came
 *   later.
 *
 * An older record (written before the scorecard existed) is brought up to
 * date: journal metrics, scorecard, notes and verdict are recomputed from
 * the arm journals with today's rules, and the README says so.
 */
export async function buildEvidenceBundle(options: BuildEvidenceBundleOptions): Promise<EvidenceBundleResult> {
  const recordFile = await resolveRecordFile(options.record)
  const recorded = JSON.parse(await readFile(recordFile, 'utf8')) as ComparisonRecord
  if (recorded.arms.length < 2) throw new Error(`${recordFile}: a comparison record needs at least two arms`)
  const outDir = path.resolve(options.outDir)
  const cli = new GitCli({ gitPath: options.gitPath ?? 'git', timeoutMs: 120_000 })
  const caveats: string[] = []

  const mapping = options.blind === true ? await loadOrCreateMapping(outDir, recorded, options.seed) : undefined
  const name = (label: string): string => mapping?.arms[label] ?? label
  // A record lists the baseline first. Blinded, every list and diff in the
  // bundle follows the letters instead (A before B), or the position alone
  // would say which letter is the baseline whatever the shuffle drew.
  const original: ComparisonRecord = mapping === undefined
    ? recorded
    : { ...recorded, arms: [...recorded.arms].sort((x, y) => name(x.label).localeCompare(name(y.label))) }

  // Journals are the source of truth for metrics; recompute so old records get today's scorecard.
  const arms: ArmRecord[] = []
  for (const arm of original.arms) {
    const agentId = arm.attempt?.agentId ?? arm.journal?.agentId
    let refreshed: ArmRecord = arm
    if (agentId !== undefined && await exists(arm.journalFile)) {
      refreshed = { ...arm, journal: await collectJournalMetrics(arm.journalFile, agentId, { stallThresholdMs: options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS }) }
    } else if (agentId !== undefined) {
      caveats.push(`${name(arm.label)}：journal 文件不存在（${mapping === undefined ? arm.journalFile : '路径已隐藏'}），时间线与代价指标缺失。`)
    }
    if (refreshed.candidateCommit === undefined && arm.step.attempts > 0) {
      const commit = await cli.execLine(['rev-parse', '--verify', `${candidateRef(arm.runId, original.task.id, arm.step.attempts)}^{commit}`], original.repoRoot).catch(() => undefined)
      if (commit !== undefined) refreshed = { ...refreshed, candidateCommit: commit }
    }
    arms.push(refreshed)
  }
  if (original.arms.some((arm) => arm.scorecard === undefined)) {
    caveats.push('这份对比记录生成于记分卡上线之前：scorecard、notes、verdict 由本工具按当前规则从各臂 journal 重新计算，原始记录未改动。')
  }
  if (mapping !== undefined && original.ordering?.mode !== 'random') {
    caveats.push('这次对比没有随机化执行顺序，各臂按固定顺序先后运行：各臂的开始时间可能透露哪一臂是基线版本，盲评在这一点上不完整。')
  }
  if (original.task.hiddenChecks === undefined) {
    caveats.push('这次运行没有隐藏验收检查：第 1 层（正确性）没有数据，可见检查里的 `pnpm test` 跑的是角色自己写的测试。')
  }

  const harnessesRun = [...new Set(arms.map((arm) => original.task.harness ?? arm.journal?.spawned?.harness).filter((value): value is string => value !== undefined))]
  const contextFiles = await harnessContextFiles(cli, original.repoRoot, original.task.baseCommit, harnessesRun)

  await clearOwned(outDir)
  const files = new Map<string, string>()
  const put = (relative: string, content: string): void => { files.set(relative, content) }

  // ── task/ ────────────────────────────────────────────────────────────
  if (original.task.manifestFile !== undefined && await exists(original.task.manifestFile)) {
    const declared = parseYaml(await readFile(original.task.manifestFile, 'utf8')) as Record<string, unknown> | undefined
    put('task/manifest.yaml', renderManifest(declared ?? {}))
    caveats.push('task/manifest.yaml 是重新序列化的：manifest 作者的注释已剥离（注释里可能写着运行结果），隐藏检查只保留名字。')
    const declaredHidden = ((declared?.hidden_checks ?? []) as Array<{ name?: string }>).map((check) => check.name ?? '')
    const recordedHidden = original.task.hiddenChecks ?? []
    if (declaredHidden.join('\n') !== recordedHidden.join('\n')) {
      caveats.push(`task/manifest.yaml 是当前版本，与这次运行时不完全一致：现在声明的隐藏检查为 [${declaredHidden.join(', ')}]，运行时为 [${recordedHidden.join(', ')}]。以 results/comparison.json 的 task 字段为准。`)
    }
  } else {
    caveats.push('找不到任务 manifest 文件，task/ 只有 README 中的摘要。')
  }

  // ── roles/ ───────────────────────────────────────────────────────────
  const versions = [...new Set(original.arms.map((arm) => arm.roleVersion))]
  const hideVersions = (text: string): string => mapping === undefined ? text : hideVersionTokens(text, versions)
  const roleFiles: Array<{ label: string; file: string; layerFile?: string }> = []
  for (const arm of original.arms) {
    const { role: text, layer } = await loadRoleText(arm, original, options.gitPath)
    const relative = `roles/${name(arm.label)}.yaml`
    put(relative, hideVersions(text))
    const layerFile = layer === undefined ? undefined : `roles/${name(arm.label)}.project-layer.yaml`
    if (layerFile !== undefined) put(layerFile, hideVersions(layer!))
    roleFiles.push({ label: name(arm.label), file: relative, ...(layerFile === undefined ? {} : { layerFile }) })
  }
  if (roleFiles.length === 2) {
    put('roles/diff.patch', await unifiedDiff(files.get(roleFiles[0]!.file)!, files.get(roleFiles[1]!.file)!, roleFiles[0]!.file, roleFiles[1]!.file))
    if (roleFiles.some((entry) => entry.layerFile !== undefined)) {
      // What each arm ran is role + project layer; diff that whole, too.
      const whole = (entry: typeof roleFiles[number]): string => `${files.get(entry.file)!}${entry.layerFile === undefined ? '\n# （无项目层）\n' : `\n# ── 项目层 ──\n${files.get(entry.layerFile)!}`}`
      put('roles/with-project-layer.diff.patch', await unifiedDiff(whole(roleFiles[0]!), whole(roleFiles[1]!), `${roleFiles[0]!.file}+project-layer`, `${roleFiles[1]!.file}+project-layer`))
    }
  }

  // ── results/ (grade only) ────────────────────────────────────────────
  const scrub = (text: string): string => {
    let result = stripWorktreePaths(text)
    if (mapping !== undefined) {
      for (const arm of original.arms) result = result.split(arm.runId).join(`run-${name(arm.label)}`)
    }
    return result
  }
  if (options.phase === 'grade') {
    const shown = arms.map((arm) => presentArm(arm, name, mapping !== undefined, scrub))
    const partial: Omit<ComparisonRecord, 'notes'> = {
      ...original,
      repoRoot: mapping === undefined ? original.repoRoot : '<repo>',
      task: mapping === undefined ? original.task : { ...original.task, manifestFile: 'task/manifest.yaml' },
      arms: shown.map((arm) => ({ ...arm, scorecard: deriveScorecard(arm) })),
    }
    delete (partial as { cloneRoots?: unknown }).cloneRoots
    // The seed plus the arms' start times would tell which letter ran first,
    // and with the given order (baseline first) which version it is.
    if (mapping !== undefined && partial.ordering !== undefined) partial.ordering = { mode: partial.ordering.mode }
    const record: ComparisonRecord = { ...partial, notes: deriveNotes(partial), verdict: deriveVerdict(partial.arms) }
    put('results/comparison.json', `${JSON.stringify(record, null, 2)}\n`)
    put('results/comparison.md', scrub(renderComparisonMarkdown(record)))

    for (const arm of arms) {
      const base = `results/${name(arm.label)}/run-1`
      if (arm.candidateCommit !== undefined) {
        const diff = await cli.exec(['diff', '--no-color', original.task.baseCommit, arm.candidateCommit], original.repoRoot)
        put(`${base}/diff.patch`, scrub(diff.stdout))
      } else {
        put(`${base}/diff.patch`, '（没有捕获到候选提交：这一臂没有产生可比较的改动。）\n')
      }
      const agentId = arm.attempt?.agentId ?? arm.journal?.agentId
      const events = agentId !== undefined && await exists(arm.journalFile) ? await readAgentEvents(arm.journalFile, agentId) : []
      put(`${base}/final-reply.md`, scrub(renderFinalReply(name(arm.label), events)))
      put(`${base}/timeline.md`, scrub(renderTimeline(name(arm.label), events, options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS)))
    }
  }

  const ordered = [...files.keys()].sort()
  const contentHash = hashFiles(ordered.map((relative) => [relative, files.get(relative)!]))
  put('README.md', renderReadme({ original, phase: options.phase, name, blinded: mapping !== undefined, files: ordered, contentHash, caveats, arms, contextFiles }))

  for (const [relative, content] of files) {
    const target = path.join(outDir, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }

  return {
    outDir,
    phase: options.phase,
    files: [...files.keys()].sort(),
    contentHash,
    ...(mapping === undefined ? {} : { blinding: { file: blindingFileFor(outDir), mapping } }),
    caveats,
  }
}

/**
 * The manifest as the evaluator may see it: what the arms were asked to do and
 * how they were checked. Author comments are dropped — in practice they record
 * results ("verified: both arms pass") — and hidden checks keep only their
 * names; their commands and staged files are the scorer's business.
 */
function renderManifest(doc: Record<string, unknown>): string {
  const pick = (key: string): Record<string, unknown> => (doc[key] === undefined ? {} : { [key]: doc[key] })
  const hidden = Array.isArray(doc.hidden_checks)
    ? { hidden_checks: (doc.hidden_checks as Array<{ name?: string }>).map((check) => ({ name: check.name ?? '' })) }
    : {}
  return stringifyYaml({
    ...pick('id'), ...pick('title'), ...pick('role'), ...pick('base_commit'), ...pick('timeout_ms'), ...pick('sandbox'),
    ...pick('instructions'), ...pick('setup'), ...pick('checks'), ...hidden,
  }, { lineWidth: 0 })
}

/** Where the A/B mapping for a bundle lives: a sibling file, outside the evaluator's cwd. */
export function blindingFileFor(outDir: string): string {
  return `${path.resolve(outDir)}.blinding.json`
}

// ── helpers ──────────────────────────────────────────────────────────────

/** A project instruction file a harness loads into every session on its own. */
export interface HarnessContextFile {
  harness: string
  path: string
  lines: number
}

/**
 * Instruction files present at the base commit that the harnesses which ran
 * load automatically: `CLAUDE.md` for claude-code, `AGENTS.md` for codex.
 * They reach both arms outside the role prompt, so a comparison of role
 * prompts is really a comparison of "prompt + this file". For example, when the
 * base commit's CLAUDE.md restates most of a role's project-context
 * section, a claude-code arm running the older role gets that context too. Stated as a fact in the bundle; whether to strip
 * such files from the arms is a methodology decision, not made here.
 */
export async function harnessContextFiles(cli: GitCli, repoRoot: string, baseCommit: string, harnesses: readonly string[]): Promise<HarnessContextFile[]> {
  const candidates: Array<{ harness: string; path: string }> = []
  if (harnesses.includes('claude-code')) candidates.push({ harness: 'claude-code', path: 'CLAUDE.md' })
  if (harnesses.includes('codex')) candidates.push({ harness: 'codex', path: 'AGENTS.md' })
  const found: HarnessContextFile[] = []
  for (const candidate of candidates) {
    const text = await cli.exec(['show', `${baseCommit}:${candidate.path}`], repoRoot).then((result) => result.stdout, () => undefined)
    if (text !== undefined) found.push({ ...candidate, lines: text.split('\n').filter((_, index, all) => index < all.length - 1 || all[index] !== '').length })
  }
  return found
}

async function resolveRecordFile(input: string): Promise<string> {
  const absolute = path.resolve(input)
  const info = await stat(absolute)
  return info.isDirectory() ? path.join(absolute, 'comparison.json') : absolute
}

async function loadOrCreateMapping(outDir: string, record: ComparisonRecord, seed: number | undefined): Promise<BlindingMapping> {
  const file = blindingFileFor(outDir)
  if (await exists(file)) {
    const existing = JSON.parse(await readFile(file, 'utf8')) as BlindingMapping
    if (existing.recordId !== record.id) {
      throw new Error(`${file} belongs to record ${existing.recordId}, not ${record.id}; use a different --out`)
    }
    return existing
  }
  const effectiveSeed = seed ?? randomSeed()
  const letters = record.arms.map((_, index) => String.fromCharCode(65 + index))
  const shuffled = seededShuffle(letters, effectiveSeed)
  const mapping: BlindingMapping = {
    recordId: record.id,
    seed: effectiveSeed,
    arms: Object.fromEntries(record.arms.map((arm, index) => [arm.label, shuffled[index]!])),
  }
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(mapping, null, 2)}\n`, 'utf8')
  return mapping
}

/** First line of every README this builder writes (see `renderReadme`). */
const README_HEADING = '# 证据包\n'

/**
 * Empty the entries a rebuild replaces — only in a directory that holds a
 * bundle already, or none of them. `--out` is any path: pointed at a project
 * root, a blind `rm -rf` of `README.md`, `task/`, `roles/` and `results/` would
 * take the project's own files with it.
 */
async function clearOwned(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true })
  const present = (await readdir(outDir)).filter((entry) => OWNED.includes(entry))
  if (present.length > 0) {
    const readme = await readFile(path.join(outDir, 'README.md'), 'utf8').catch(() => '')
    if (!readme.startsWith(README_HEADING)) {
      throw new Error(`${outDir} is not an evidence bundle but has ${present.join(', ')}, which building one would replace; choose an empty or new --out`)
    }
  }
  await Promise.all(OWNED.map((entry) => rm(path.join(outDir, entry), { recursive: true, force: true })))
}

/**
 * Rewrite absolute attempt-worktree paths
 * (`…/dsh-orchestrator/worktrees/<repoKey>/<runId>/<stepId>/<attempt>/`) to
 * `./`. Only path characters are consumed: an earlier version matched any
 * run of non-space characters and swallowed text glued to the path, such
 * as the tool name in `` `fileChange`：改动文件：/private/var/… ``.
 */
export function stripWorktreePaths(text: string): string {
  return text.replace(/(?:\/[^\s/"'`,:：()]+)*\/dsh-orchestrator\/worktrees\/[^/\s]+\/[^/\s]+\/[^/\s]+\/\d+\//g, './')
}

/**
 * Replace every standalone occurrence of the given versions — bare (`1.0.0`)
 * or `v`-prefixed (`v1.0.0`) — with `<hidden>`. Standalone means not part of
 * a longer version or identifier: `11.0.0` and `1.0.0-rc` are left alone.
 */
export function hideVersionTokens(text: string, versions: readonly string[]): string {
  return versions.reduce((acc, version) => {
    const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return acc.replace(new RegExp(`(?<![\\w.])v?${escaped}(?![\\w.-])`, 'g'), HIDDEN)
  }, text)
}

/**
 * The exact YAML text the arm ran with, verified against the recorded content
 * hash — a `dir:` source reads today's working tree, which may have moved on.
 */
async function loadRoleText(arm: ArmRecord, record: ComparisonRecord, gitPath: string | undefined): Promise<{ role: string; layer?: string }> {
  const parsed = toSpec(arm.roleSource, record.repoRoot)
  // Pin a git source to the commit it resolved to at run time, not whatever the ref means today.
  const spec: RoleSourceSpec = parsed.kind === 'git' && arm.roleSourceCommit !== undefined ? { ...parsed, ref: arm.roleSourceCommit } : parsed
  const source = await resolveRoleSource({ spec, roleId: arm.roleId, repoRoot: record.repoRoot, ...(gitPath === undefined ? {} : { gitPath }) })
  try {
    if (source.roleHash !== arm.roleHash) {
      throw new Error(`${arm.label}: role source ${arm.roleSource} now resolves to hash ${source.roleHash.slice(0, 12)}, but the run recorded ${arm.roleHash.slice(0, 12)} — the role changed since the comparison ran; evidence would not match`)
    }
    if (source.projectLayerHash !== arm.projectLayerHash) {
      throw new Error(`${arm.label}: role source ${arm.roleSource} now has project layer ${source.projectLayerHash?.slice(0, 12) ?? 'none'}, but the run recorded ${arm.projectLayerHash?.slice(0, 12) ?? 'none'} — the project layer changed since the comparison ran; evidence would not match`)
    }
    const role = await findRoleFile(source.rolesDir, arm.roleId)
    if (role === undefined) throw new Error(`${arm.label}: no YAML file for role ${arm.roleId} in ${arm.roleSource}`)
    const layerSource = source.role.projectLayer?.source
    return layerSource === undefined ? { role } : { role, layer: await readFile(layerSource, 'utf8') }
  } finally {
    await source.cleanup()
  }
}

async function findRoleFile(rolesDir: string, roleId: string): Promise<string | undefined> {
  for (const entry of await readdir(rolesDir)) {
    if (!/\.ya?ml$/.test(entry)) continue
    const text = await readFile(path.join(rolesDir, entry), 'utf8')
    const doc = parseYaml(text) as { role_id?: string; metadata?: { role_id?: string } } | undefined
    if ((doc?.metadata?.role_id ?? doc?.role_id) === roleId) return text
  }
  return undefined
}

function toSpec(label: string, repoRoot: string): RoleSourceSpec {
  if (label.startsWith('dir:')) return { kind: 'dir', dir: path.resolve(repoRoot, label.slice('dir:'.length)) }
  return parseRoleSourceSpec(label)
}

async function unifiedDiff(left: string, right: string, leftName: string, rightName: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-eval-diff-'))
  try {
    const a = path.join(dir, 'a.yaml')
    const b = path.join(dir, 'b.yaml')
    await writeFile(a, left, 'utf8')
    await writeFile(b, right, 'utf8')
    const { stdout } = await execFileAsync('git', ['diff', '--no-index', '--no-color', a, b], { maxBuffer: 64 * 1024 * 1024 })
      .catch((error: { code?: number; stdout?: string }) => {
        // `git diff --no-index` exits 1 when the files differ — that is the normal case here.
        if (error.code === 1 && typeof error.stdout === 'string') return { stdout: error.stdout }
        throw error
      })
    return stdout.split(`${dir}/a.yaml`).join(leftName).split(`${dir}/b.yaml`).join(rightName)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The arm as the evaluator sees it: blinded labels and paths, nothing that names the version. */
function presentArm(arm: ArmRecord, name: (label: string) => string, blinded: boolean, scrub: (text: string) => string): ArmRecord {
  const shown: ArmRecord = JSON.parse(scrub(JSON.stringify(arm))) as ArmRecord
  shown.journalFile = `results/${name(arm.label)}/run-1/timeline.md`
  shown.runsDir = '<runs>'
  if (!blinded) return shown
  shown.label = name(arm.label)
  // With the order's seed hidden too (see buildEvidenceBundle), when an arm
  // ran says nothing about which version it is.
  delete shown.runPosition
  shown.roleVersion = HIDDEN
  shown.roleSource = HIDDEN
  delete shown.roleSourceCommit
  if (shown.journal?.spawned !== undefined) shown.journal.spawned.roleVersion = HIDDEN
  return shown
}

async function readAgentEvents(journalFile: string, agentId: string): Promise<JournalEvent[]> {
  const reader = new JournalReader({ file: journalFile, maxPageSize: 500 })
  const events: JournalEvent[] = []
  let after: string | undefined
  for (;;) {
    const page = await reader.readConversation({ agentId, after, limit: 500 })
    events.push(...page.items)
    if (page.nextCursor === undefined) break
    after = page.nextCursor
  }
  return events
}

function textOf(event: JournalEvent): string {
  const payload = event.payload as Record<string, unknown> | null
  return typeof payload?.text === 'string' ? payload.text : ''
}

function renderFinalReply(label: string, events: readonly JournalEvent[]): string {
  const replied = [...events].reverse().find((event) => event.kind === 'chat.replied')
  if (replied !== undefined) {
    return `# ${label} 的完成报告（chat.replied 原文）\n\n> 这是该臂对自己工作的**自述**，要与 diff.patch、检查输出对照，不能当作证据。\n\n${textOf(replied)}\n`
  }
  const last = events.filter((event) => event.kind === 'message' && event.role === 'assistant').slice(-3)
  return [
    `# ${label}：没有完成报告`,
    '',
    '> 这一臂的回合没有正常结束（见 results/comparison.json 的 attempt.outcome），没有提交完成报告。',
    '> 以下是它最后的几条 assistant 消息，仅用于了解它停在了哪里。',
    '',
    ...last.map((event) => `---\n\n${textOf(event)}\n`),
  ].join('\n')
}

function renderTimeline(label: string, events: readonly JournalEvent[], stallThresholdMs: number): string {
  if (events.length === 0) return `# ${label} 时间线\n\n（journal 中没有这一臂的事件。）\n`
  const start = events[0]!.timestamp
  const lines = [
    `# ${label} 时间线（run-1）`,
    '',
    `从 journal 逐条摘录；输入与输出已截断。超过 ${Math.round(stallThresholdMs / 60_000)} 分钟没有可见动作的间隔会单独标出：harness 报告模型在推理的标为「思考」（算角色自己的耗时）；连心跳都没有的标为「停顿」（provider 或环境）。没有活动心跳的旧记录里，停顿里可能含有思考。`,
    '',
  ]
  const silences = new SilenceClassifier(stallThresholdMs)
  for (const event of events) {
    const stallsBefore = silences.stalls.length
    const thinkingBefore = silences.thinking.length
    silences.observe(event)
    for (const stall of silences.stalls.slice(stallsBefore)) lines.push(`- **⏸ 停顿 ${clock(stall.ms)}**（此间没有任何事件）`)
    for (const span of silences.thinking.slice(thinkingBefore)) {
      lines.push(`- **💭 思考 ${clock(span.ms)}**（${span.evidence === 'reasoning' ? 'harness 报告模型在推理' : 'harness 持续发出思考心跳'}，没有可见动作）`)
    }
    if (event.kind === 'agent.activity') continue
    const at = `[+${clock(event.timestamp - start)}]`
    const payload = (event.payload ?? {}) as Record<string, unknown>
    switch (event.kind) {
      case 'tool_call': {
        const input = payload.input
        const detail = typeof input === 'string'
          ? input
          : Array.isArray((input as { changes?: unknown } | undefined)?.changes)
            ? `改动文件：${((input as { changes: Array<{ path?: string }> }).changes).map((change) => change.path ?? '?').join(', ')}`
            : JSON.stringify(input ?? {})
        lines.push(`- ${at} 工具调用 \`${String(payload.name ?? '?')}\`：${truncate(detail, 300)}`)
        break
      }
      case 'tool_result': {
        const content = typeof payload.content === 'string' ? payload.content : JSON.stringify(payload.content ?? '')
        lines.push(`  - 结果${payload.isError === true ? '（错误）' : ''}：${truncate(content, 200)}`)
        break
      }
      case 'message':
        if (event.role === 'assistant') lines.push(`- ${at} 角色说：${truncate(textOf(event), 400)}`)
        break
      case 'chat.replied':
        lines.push(`- ${at} 提交完成报告（全文见 final-reply.md）`)
        break
      case 'agent.spawned':
        lines.push(`- ${at} 启动（harness=${String(payload.harness ?? '?')}）`)
        break
      case 'agent.provider_retry':
        lines.push(`- ${at} 🔁 provider 请求失败并重试：${truncate(String(payload.message ?? ''), 200)}`)
        break
      case 'error':
        lines.push(`- ${at} **错误**：${truncate(String(payload.message ?? ''), 300)}`)
        break
      case 'policy.violation':
        lines.push(`- ${at} **策略拒绝**：${truncate(JSON.stringify(payload.violations ?? payload), 300)}`)
        break
      case 'verification.completed':
        lines.push(`- ${at} 角色自检：通过 ${String(payload.passed ?? '?')}/${String(payload.totalRules ?? '?')}`)
        break
      case 'agent.exited':
        lines.push(`- ${at} 进程退出`)
        break
      default:
        break
    }
  }
  return `${lines.join('\n')}\n`
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…（截断，原长 ${flat.length}）`
}

function clock(ms: number): string {
  const seconds = Math.round(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  return minutes === 0 ? `${seconds}s` : `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
}

function hashFiles(entries: ReadonlyArray<[string, string]>): string {
  const hash = createHash('sha256')
  for (const [relative, content] of entries) hash.update(relative).update('\0').update(content).update('\0')
  return hash.digest('hex')
}

function renderReadme(input: {
  original: ComparisonRecord
  phase: EvidencePhase
  name: (label: string) => string
  blinded: boolean
  files: string[]
  contentHash: string
  caveats: string[]
  arms: ArmRecord[]
  contextFiles: HarnessContextFile[]
}): string {
  const { original, phase, name, blinded } = input
  const lines = [
    README_HEADING.trimEnd(),
    '',
    `- 阶段：**${phase === 'rubric' ? '定标准（rubric）——本包刻意不含任何结果' : '评分（grade）'}**`,
    `- 对比记录：\`${original.id}\``,
    `- 任务：\`${original.task.id}\` —— ${original.task.title}`,
    `- 被评角色：\`${original.task.role}\``,
    `- 起点 commit：\`${original.task.baseCommit}\``,
    `- 盲化：${blinded ? '是——臂名为 A/B，版本号替换为 `<hidden>`，映射不在本目录中' : '否'}`,
    `- 内容哈希（除本文件外全部文件）：\`${input.contentHash}\``,
    '',
    '## 这道题的运行条件',
    '',
    ...(original.task.harness === undefined
      ? []
      : [`- **两臂实际都跑在 \`${original.task.harness}\` 上**，这是本次运行统一指定的，覆盖了角色文件里 \`execution.harness\` 的声明。角色定义里针对原 harness 的说明（沙箱、工具名等）在这次运行中不一定适用。`]),
    ...(original.task.sandbox === undefined ? [] : [`- 沙箱：\`${original.task.sandbox}\`（两臂统一）。`]),
    ...input.contextFiles.map((file) => input.original.task.harnessContext === 'hide'
      ? `- **起点 commit 含 \`${file.path}\`（${file.lines} 行），但这次对比设置了 \`harness_context: hide\`**：角色回合期间它被移出了 worktree，两臂都没有自动加载它。比较的是角色本身，不是日常使用条件（日常使用时 ${file.harness} 会自动加载它）。`
      : `- **起点 commit 含 \`${file.path}\`（${file.lines} 行）**：${file.harness} 会把它自动加载进每一臂的上下文。两臂在各自的角色提示词之外，都读到了这份项目说明——角色提示词里与它重合的部分，在这次运行中对两臂的差异贡献会变小。`),
    '- manifest 的 `timeout_ms` 是两臂**统一的回合预算**，覆盖各角色自己声明的 `chat_timeout_ms`；`sandbox` 同样对两臂统一生效，覆盖角色声明。',
    '- `setup` 由控制端在 agent 进场前、在沙箱外执行；可见检查（`checks`）在 agent 离场后由控制端在沙箱外执行，与 agent 自己在沙箱里跑的命令无关。控制端命令的 locale 固定为 `LC_ALL=C`；agent 自己的环境继承宿主机（两臂相同），所以 agent 在沙箱里看到的失败项可能比控制端多。',
    '- 两臂各自在只含起点 commit 历史的私有仓库里工作，看不到仓库后来的提交，也看不到另一臂的产出。',
    '',
    '## 各臂',
    '',
    ...input.arms.map((arm) => `- **${name(arm.label)}**：角色内容哈希 \`${arm.roleHash.slice(0, 12)}\`${arm.projectLayerHash === undefined ? '，无项目层' : `，项目层哈希 \`${arm.projectLayerHash.slice(0, 12)}\`（roles/${name(arm.label)}.project-layer.yaml，运行时追加在角色之后）`}${phase === 'grade' && arm.candidateCommit !== undefined ? `，候选提交 \`${arm.candidateCommit.slice(0, 12)}\`` : ''}`),
    '',
    '## 文件',
    '',
    ...input.files.map((file) => `- \`${file}\``),
  ]
  if (input.caveats.length > 0) {
    lines.push('', '## 注意', '', ...input.caveats.map((caveat) => `- ${caveat}`))
  }
  if (blinded) {
    lines.push('', '> 盲化的局限：只替换了臂名、版本号和运行标识。角色定义本身不改——它就是被评估的证据——所以定义的格式、`upgraded_from` 之类的注解、`roles/diff.patch` 的增删方向都可能透露哪一版更晚。盲化削弱"新版理应更好"的先入之见，但不能消除它。')
  }
  return `${lines.join('\n')}\n`
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false)
}
