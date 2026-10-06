import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FileLiveAgentRegistry, requestControl } from '@dsh/agent-manager'
import { FileRunRepository } from '@dsh/core'

import { compareRoles, planArmOrder } from '../src/compare.js'
import type { ArmRecord } from '../src/comparison.js'
import type { TaskManifest } from '../src/task-manifest.js'
import { FakeHarnessChannel, cleanupDirs, createRoleHistoryRepo, dirs, git } from './fixtures.js'

afterEach(cleanupDirs)

async function outsideRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-role-eval-out-'))
  dirs.push(dir)
  return dir
}

function manifest(baseCommit: string, overrides: Partial<TaskManifest> = {}): TaskManifest {
  return {
    id: 'touch-file',
    title: 'Create created.txt',
    role: 'worker',
    baseCommit,
    instructions: 'Create a file named created.txt containing "done".',
    checks: [
      { name: 'file exists', command: 'test -f created.txt' },
      { name: 'readme intact', command: 'grep -q fixture README.md' },
    ],
    ...overrides,
  }
}

describe('planArmOrder', () => {
  const arms = [
    { label: 'baseline', source: { kind: 'dir' as const, dir: '/a' } },
    { label: 'candidate', source: { kind: 'dir' as const, dir: '/b' } },
  ]
  it('shuffles by default, reproducibly from the seed, and keeps the given order on request', () => {
    const labels = (plan: ReturnType<typeof planArmOrder>) => plan.run.map((arm) => arm.label)
    expect(labels(planArmOrder({ arms, orderSeed: 7 }))).toEqual(['candidate', 'baseline'])
    expect(labels(planArmOrder({ arms, orderSeed: 1 }))).toEqual(['baseline', 'candidate'])
    expect(planArmOrder({ arms, orderSeed: 7 })).toMatchObject({ mode: 'random', seed: 7 })
    const drawn = planArmOrder({ arms })
    expect(drawn.mode).toBe('random')
    expect(labels(planArmOrder({ arms, orderSeed: drawn.seed! }))).toEqual(labels(drawn))
    expect(planArmOrder({ arms, order: 'as-given', orderSeed: 7 })).toEqual({ mode: 'as-given', run: arms })
  })
})

describe('compareRoles (end to end, fake harness, real git)', () => {
  it('runs both role versions from the same base commit in isolated worktrees and records everything that can be counted', async () => {
    const { repo, v1, v2 } = await createRoleHistoryRepo()
    const outDir = await outsideRepo()
    const channel = new FakeHarnessChannel({ toolCalls: 3, writeFile: { name: 'created.txt', content: 'done\n' } })
    let tick = 1_000
    const seen: string[] = []

    const { record, recordFile, markdownFile } = await compareRoles({ advertise: false,
      // Random order is the default; seed 7 happens to put the candidate first.
      orderSeed: 7,
      manifest: manifest(v2, {
        sandbox: 'workspace-write',
        // Setup runs before the agent; its untracked output is part of what the agent starts from.
        setup: [{ name: 'prepare', command: 'echo prepared > prepared.txt' }],
        checks: [
          { name: 'file exists', command: 'test -f created.txt' },
          { name: 'readme intact', command: 'grep -q fixture README.md' },
          { name: 'setup ran first', command: 'test -f prepared.txt' },
        ],
      }),
      arms: [
        { label: 'baseline', source: { kind: 'git', ref: v1 } },
        { label: 'candidate', source: { kind: 'dir', dir: path.join(repo, '.dsh', 'roles') } },
      ],
      repoRoot: repo,
      outDir,
      channels: [channel],
      id: 'cmp-1',
      now: () => (tick += 1),
      onArm: (arm) => seen.push(arm.label),
    })

    // Ran candidate first, as the seed decided; listed as given, with when each ran.
    expect(seen).toEqual(['candidate', 'baseline'])
    expect(record.ordering).toEqual({ mode: 'random', seed: 7 })
    expect(record.arms.map((arm) => [arm.label, arm.runPosition])).toEqual([['baseline', 2], ['candidate', 1]])
    expect(record.id).toBe('cmp-1')
    expect(record.task.baseCommit).toBe(v2)
    const [baseline, candidate] = record.arms
    expect(baseline!.roleVersion).toBe('1.0.0')
    expect(candidate!.roleVersion).toBe('2.0.0')
    expect(baseline!.roleHash).not.toBe(candidate!.roleHash)
    expect(baseline!.roleSourceCommit).toBe(v1)

    for (const arm of record.arms) {
      expect(arm.error).toBeUndefined()
      expect(arm.runStatus).toBe('delivery_ready')
      expect(arm.step.status).toBe('merged')
      // Controller checks: all ran, all passed, in the arm's own worktree.
      expect(arm.attempt?.evidence?.checks?.map((check) => [check.name, check.exitCode])).toEqual([['file exists', 0], ['readme intact', 0], ['setup ran first', 0]])
      expect(arm.attempt?.evidence?.passed).toBe(true)
      // Capture evidence survived the merge with the checks (Scheduler mergeEvidence).
      // Setup output the fixture's (absent) .gitignore does not cover is captured like any other
      // worktree change — real manifests keep setup to ignored artefacts such as node_modules/.
      expect(arm.attempt?.evidence?.changedPaths).toEqual(['created.txt', 'prepared.txt'])
      expect(arm.attempt?.evidence?.diffHash).toMatch(/^[0-9a-f]{64}$/)
      expect(arm.attempt?.resultCommit).toMatch(/^[0-9a-f]{40}$/)
      // The reply's own facts.
      expect(arm.attempt?.toolCalls).toBe(3)
      expect(arm.attempt?.model).toBe('fake-1')
      expect(arm.attempt?.summary).toContain('did the task')
      // Journal counts agree with the channel.
      expect(arm.journal?.toolCalls).toBe(3)
      expect(arm.journal?.toolResults).toBe(3)
      expect(arm.journal?.assistantMessages).toBe(1)
      // The load-bearing invariant: the run record and the journal name the same role content.
      expect(arm.journal?.spawned?.roleHash).toBe(arm.roleHash)
      expect(arm.journal?.spawned?.roleVersion).toBe(arm.roleVersion)
      expect(arm.journal?.spawned?.harness).toBe('fake')
      expect(arm.attempt?.agentId).toBe(arm.journal?.agentId)
    }

    // Each arm's prompt came from its own role version, not the other's.
    expect(channel.opened.map((options) => options.systemPrompt)).toEqual(['You are v2, more careful.\n', 'You are v1.\n'])
    // The manifest's sandbox reached both harness sessions, and the record says so.
    expect(channel.opened.map((options) => options.sandbox)).toEqual(['workspace-write', 'workspace-write'])
    expect(record.task.sandbox).toBe('workspace-write')

    // Candidate commits were fetched back into the real repo under pinned refs.
    for (const arm of record.arms) {
      const ref = `refs/dsh-orchestrator/runs/${arm.runId}/candidates/touch-file/1`
      expect(await git(repo, `rev-parse ${ref}`)).toBe(arm.attempt!.resultCommit)
      expect(await git(repo, `show ${arm.attempt!.resultCommit}:created.txt`)).toBe('done')
    }
    // And the real repo's working tree was never touched.
    expect(await git(repo, 'status --porcelain')).toBe('')
    expect(await git(repo, 'rev-parse HEAD')).toBe(v2)

    // Outputs.
    expect(JSON.parse(await readFile(recordFile, 'utf8'))).toEqual(record)
    const markdown = await readFile(markdownFile, 'utf8')
    expect(markdown).toContain('| 指标 | baseline | candidate |')
    expect(markdown).toContain('| 角色版本 | 1.0.0 | 2.0.0 |')
    expect(markdown).toContain('沙箱（manifest 统一指定）：`workspace-write`')
    expect(markdown).toContain('| 检查通过 | 3/3 | 3/3 |')
    expect(markdown).toContain('准备步骤（agent 进场前、控制端执行）：`prepare`')
    expect(record.task.setup).toEqual(['prepare'])
    expect(markdown).toContain('| 工具调用（journal） | 3 | 3 |')
    expect(markdown).toContain('执行顺序：candidate → baseline（随机，种子 7）')
    expect(record.notes.some((note) => note.includes('执行顺序'))).toBe(false)
    // Per-arm journals and run documents exist where the record says.
    for (const arm of record.arms) {
      await expect(stat(arm.journalFile)).resolves.toBeTruthy()
      await expect(new FileRunRepository({ dir: arm.runsDir }).get(arm.runId)).resolves.toMatchObject({ id: arm.runId })
    }
    // No private repositories left behind.
    expect(record.cloneRoots).toBeUndefined()
    // Neither arm declared verification rules, and the note says so instead of implying "passed".
    expect(record.notes.filter((note) => note.includes('verification'))).toHaveLength(2)
  }, 60_000)

  it('records a failed check as a failed step, flags an arm that never called a tool, and still writes the record', async () => {
    const { repo, v1, v2 } = await createRoleHistoryRepo()
    const outDir = await outsideRepo()
    // Intent-only harness: says it will do it, touches nothing (earlier behavior shape).
    const channel = new FakeHarnessChannel({ toolCalls: 0, replyText: '我先完整读取文档，随后会创建文件。' })

    const { record } = await compareRoles({ advertise: false, order: 'as-given',
      manifest: manifest(v2, { checks: [{ name: 'file exists', command: 'test -f created.txt' }] }),
      arms: [
        { label: 'baseline', source: { kind: 'git', ref: v1 } },
        { label: 'candidate', source: { kind: 'git', ref: v2 } },
      ],
      repoRoot: repo,
      outDir,
      channels: [channel],
      id: 'cmp-2',
    })

    for (const arm of record.arms) {
      // A failed step parks the run in waiting_action (a human decides: retry or cancel).
      expect(arm.runStatus).toBe('waiting_action')
      expect(arm.step.status).toBe('failed')
      expect(arm.step.failure?.message).toBe('Check "file exists" exited with code 1')
      expect(arm.journal?.toolCalls).toBe(0)
      // A failed verification stops before capture, so there is no candidate commit to cite.
      expect(arm.attempt?.resultCommit).toBeUndefined()
    }
    expect(record.notes.some((note) => note.includes('baseline') && note.includes('tool_call'))).toBe(true)
    expect(record.notes.some((note) => note.includes('candidate') && note.includes('tool_call'))).toBe(true)
    // A fixed order is recorded as such, and flagged.
    expect(record.ordering).toEqual({ mode: 'as-given' })
    expect(record.arms.map((arm) => arm.runPosition)).toEqual([1, 2])
    expect(record.notes).toContain('执行顺序没有随机化，baseline 先跑——provider 负载、额度消耗和时段差异会系统性地落在同一臂上。')
    const markdown = await readFile(path.join(outDir, 'comparison.md'), 'utf8')
    expect(markdown).toContain('## 阅读前必看')
    expect(markdown).toContain('执行顺序：baseline → candidate（按给定顺序）')
  }, 60_000)

  it('scores the captured candidate against hidden checks the agent never saw — including an arm that never delivered', async () => {
    const { repo, v1, v2 } = await createRoleHistoryRepo()
    const outDir = await outsideRepo()
    // The hidden test asserts the contract ("created.txt says done"), staged only at scoring time.
    const hidden = await mkdtemp(path.join(tmpdir(), 'dsh-hidden-'))
    dirs.push(hidden)
    await writeFile(path.join(hidden, 'contract.sh'), 'grep -q done created.txt\n', 'utf8')

    // Both arms do the same work; only the v2 arm never ends its turn.
    const channel = new FakeHarnessChannel({ toolCalls: 1, writeFile: { name: 'created.txt', content: 'done\n' }, hangFor: 'You are v2' })

    const { record, markdownFile } = await compareRoles({ advertise: false, order: 'as-given',
      manifest: manifest(v2, {
        timeoutMs: 300,
        hiddenFilesDir: hidden,
        hiddenChecks: [
          { name: 'contract', command: 'sh contract.sh' },
          { name: 'not staged in the agent worktree', command: 'test ! -f contract.sh.orig' },
        ],
      }),
      arms: [
        { label: 'finishes', source: { kind: 'git', ref: v1 } },
        { label: 'stalls', source: { kind: 'git', ref: v2 } },
      ],
      repoRoot: repo,
      outDir,
      channels: [channel],
      id: 'cmp-6',
    })

    const [done, cut] = record.arms as [ArmRecord, ArmRecord]
    // Layer 0 separates them; layer 1 says they were equally correct.
    expect(done.scorecard?.delivered).toBe(true)
    expect(cut.scorecard?.delivered).toBe(false)
    expect(done.hidden).toMatchObject({ passed: 2, total: 2 })
    expect(cut.hidden).toMatchObject({ passed: 2, total: 2 })
    expect(cut.candidateCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(record.verdict?.[0]).toContain('只有 finishes 通过门槛')
    expect(record.verdict?.[1]).toContain('正确性：相同（两臂隐藏检查均 2/2）')

    // The hidden files never entered either candidate commit.
    for (const arm of record.arms) {
      const tree = await git(repo, `ls-tree -r --name-only ${arm.candidateCommit}`)
      expect(tree.split('\n')).not.toContain('contract.sh')
    }
    const markdown = await readFile(markdownFile, 'utf8')
    expect(markdown).toContain('## 读数')
    expect(markdown).toContain('| 1 · 正确性（隐藏检查） | 2/2 | 2/2 |')
  }, 90_000)

  it('runs every controller-side command with a pinned locale, whatever the host has', async () => {
    const { repo, v1, v2 } = await createRoleHistoryRepo()
    const outDir = await outsideRepo()
    const hidden = await mkdtemp(path.join(tmpdir(), 'dsh-hidden-'))
    dirs.push(hidden)
    const previous = process.env.LC_ALL
    process.env.LC_ALL = 'zh_CN.UTF-8'
    try {
      const { record } = await compareRoles({ advertise: false, order: 'as-given',
        manifest: manifest(v2, {
          setup: [{ name: 'setup locale', command: 'test "$LC_ALL" = C' }],
          checks: [{ name: 'check locale', command: 'test "$LC_ALL" = C' }],
          hiddenChecks: [{ name: 'hidden locale', command: 'test "$LC_ALL" = C' }],
          hiddenFilesDir: hidden,
        }),
        arms: [
          { label: 'baseline', source: { kind: 'git', ref: v1 } },
          { label: 'candidate', source: { kind: 'git', ref: v2 } },
        ],
        repoRoot: repo,
        outDir,
        channels: [new FakeHarnessChannel({ toolCalls: 1, writeFile: { name: 'created.txt', content: 'done\n' } })],
        id: 'cmp-7',
      })
      for (const arm of record.arms) {
        expect(arm.step.status).toBe('merged')
        expect(arm.hidden).toMatchObject({ passed: 1, total: 1 })
      }
    } finally {
      if (previous === undefined) delete process.env.LC_ALL
      else process.env.LC_ALL = previous
    }
  }, 60_000)

  it('advertises each running arm to DSH with its evaluation context, observe-only for every other process', async () => {
    const { repo, v1, v2 } = await createRoleHistoryRepo()
    const outDir = await outsideRepo()
    const registryDir = await mkdtemp(path.join(tmpdir(), 'dsh-reg-'))
    const controlSocketDir = await mkdtemp(path.join(tmpdir(), 'dsh-c-'))
    dirs.push(registryDir, controlSocketDir)
    const seen: Array<{ arm?: string; taskId?: string; comparisonId?: string; workspace?: string; cwdOutsideRepo: boolean; refusal: string }> = []
    const channel = new FakeHarnessChannel({
      toolCalls: 1,
      writeFile: { name: 'created.txt', content: 'done\n' },
      inspect: async (cwd) => {
        // Look at the arm the way a DSH page in another process would. The
        // advertisement is written asynchronously after spawn; a page polls.
        const registry = new FileLiveAgentRegistry({ dir: registryDir })
        let entry: Awaited<ReturnType<typeof registry.list>>[number] | undefined
        await vi.waitFor(async () => {
          entry = (await registry.list())[0]
          expect(entry).toBeDefined()
        }, { timeout: 5_000 })
        const refusal = await requestControl(entry!.controlSocketPath, { method: 'sendChat', agentId: entry!.agentId, text: 'nudge', timeoutMs: 5_000 }, { timeoutMs: 5_000 })
          .then(() => 'accepted', (error: unknown) => (error as { code?: string }).code ?? String(error))
        seen.push({ ...entry!.evaluation, cwdOutsideRepo: !cwd.startsWith(repo), refusal })
      },
    })

    await compareRoles({
      order: 'as-given',
      advertise: { registryDir, controlSocketDir },
      manifest: manifest(v2),
      arms: [
        { label: 'baseline', source: { kind: 'git', ref: v1 } },
        { label: 'candidate', source: { kind: 'git', ref: v2 } },
      ],
      repoRoot: repo,
      outDir,
      channels: [channel],
      id: 'cmp-live',
    })

    expect(seen).toEqual([
      { comparisonId: 'cmp-live', taskId: 'touch-file', arm: 'baseline', workspace: repo, cwdOutsideRepo: true, refusal: 'observe-only' },
      { comparisonId: 'cmp-live', taskId: 'touch-file', arm: 'candidate', workspace: repo, cwdOutsideRepo: true, refusal: 'observe-only' },
    ])
    // Withdrawn once the arms are done.
    expect(await new FileLiveAgentRegistry({ dir: registryDir }).list()).toEqual([])
  }, 60_000)

  it('harness_context: hide keeps the project instructions away from the agent only, and records what was hidden', async () => {
    const { repo } = await createRoleHistoryRepo()
    await writeFile(path.join(repo, 'CLAUDE.md'), '# project instructions\n', 'utf8')
    await git(repo, 'add -A')
    await git(repo, 'commit --quiet -m "add CLAUDE.md"')
    const base = await git(repo, 'rev-parse HEAD')
    const outDir = await outsideRepo()
    const sawInstructions: boolean[] = []
    const channel = new FakeHarnessChannel({
      toolCalls: 1,
      writeFile: { name: 'created.txt', content: 'done\n' },
      inspect: async (cwd) => { sawInstructions.push((await stat(path.join(cwd, 'CLAUDE.md')).then(() => true, () => false))) },
    })

    const { record, markdownFile } = await compareRoles({ advertise: false, order: 'as-given',
      manifest: manifest(base, {
        harnessContext: 'hide',
        // Checks run after the turn, with the instructions back in place.
        checks: [{ name: 'file exists', command: 'test -f created.txt' }, { name: 'instructions back', command: 'test -f CLAUDE.md' }],
      }),
      arms: [
        { label: 'baseline', source: { kind: 'dir', dir: path.join(repo, '.dsh', 'roles') } },
        { label: 'candidate', source: { kind: 'dir', dir: path.join(repo, '.dsh', 'roles') } },
      ],
      repoRoot: repo,
      outDir,
      channels: [channel],
      id: 'cmp-hide',
    })

    expect(sawInstructions).toEqual([false, false])
    expect(record.task.harnessContext).toBe('hide')
    for (const arm of record.arms) {
      expect(arm.step.status).toBe('merged')
      expect(arm.hiddenContext).toEqual({ hidden: ['CLAUDE.md'] })
      // The candidate does not record the instructions as deleted.
      expect(arm.attempt?.evidence?.changedPaths).toEqual(['created.txt'])
    }
    expect(record.notes.some((note) => note.startsWith('harness_context: hide——角色回合期间，起点的 1 个 harness 说明文件被移出了 worktree（CLAUDE.md）'))).toBe(true)
    expect(await readFile(markdownFile, 'utf8')).toContain('项目说明文件（CLAUDE.md / AGENTS.md 等）：**隐藏**')
  })

  it('shows each arm only the base commit: no later history (the answer key) and no other arm\'s candidate refs', async () => {
    const { repo, v1, v2 } = await createRoleHistoryRepo()
    const outDir = await outsideRepo()
    const seen: Array<{ log: string; laterVisible: boolean; foreignRefs: string }> = []
    const channel = new FakeHarnessChannel({
      toolCalls: 1,
      writeFile: { name: 'created.txt', content: 'done\n' },
      inspect: async (cwd) => {
        const log = await git(cwd, 'log --all --oneline')
        const laterVisible = await git(cwd, `cat-file -e ${v2}^{commit}`).then(() => true, () => false)
        const foreignRefs = await git(cwd, 'for-each-ref refs/dsh-orchestrator')
        seen.push({ log, laterVisible, foreignRefs })
      },
    })

    // The task is posed at v1; v2 (which "solves" it by changing the role) exists in the real repo.
    const { record } = await compareRoles({ advertise: false, order: 'as-given',
      manifest: manifest(v1),
      arms: [
        { label: 'baseline', source: { kind: 'git', ref: v1 } },
        { label: 'candidate', source: { kind: 'git', ref: v2 } },
      ],
      repoRoot: repo,
      outDir,
      channels: [channel],
      id: 'cmp-5',
    })

    expect(seen).toHaveLength(2)
    for (const view of seen) {
      expect(view.log.split('\n')).toEqual([`${v1.slice(0, 7)} roles v1`])
      expect(view.laterVisible).toBe(false)
      // The second arm ran after the first had already produced a candidate; it still saw none.
      expect(view.foreignRefs).toBe('')
    }
    // Both arms still delivered, and their candidates came home to the real repo.
    for (const arm of record.arms) {
      expect(arm.step.status).toBe('merged')
      expect(await git(repo, `rev-parse refs/dsh-orchestrator/runs/${arm.runId}/candidates/touch-file/1`)).toBe(arm.attempt!.resultCommit)
    }
    // Role prompts came from the requested sources, not from the arm's own (history-limited) checkout.
    expect(channel.opened.map((options) => options.systemPrompt)).toEqual(['You are v1.\n', 'You are v2, more careful.\n'])
  }, 60_000)

  it('fails a cut-off turn as step_timeout under the manifest budget, skips the checks, and keeps the partial worktree as evidence', async () => {
    const { repo, v1, v2 } = await createRoleHistoryRepo()
    const outDir = await outsideRepo()
    // Does the work, then never ends its turn — a stalled provider, seen in real use.
    const channel = new FakeHarnessChannel({ toolCalls: 2, writeFile: { name: 'created.txt', content: 'half\n' }, hang: true })

    const { record, markdownFile } = await compareRoles({ advertise: false, order: 'as-given',
      manifest: manifest(v2, { timeoutMs: 300 }),
      arms: [
        { label: 'baseline', source: { kind: 'git', ref: v1 } },
        { label: 'candidate', source: { kind: 'git', ref: v2 } },
      ],
      repoRoot: repo,
      outDir,
      channels: [channel],
      id: 'cmp-4',
    })

    for (const arm of record.arms) {
      expect(arm.runStatus).toBe('waiting_action')
      expect(arm.step.status).toBe('failed')
      expect(arm.step.failure?.code).toBe('step_timeout')
      expect(arm.attempt?.outcome).toBe('failed')
      expect(arm.attempt?.error).toContain('timed out after 300 ms')
      // The checks were never run; the capture still says what the agent left behind.
      expect(arm.attempt?.evidence?.checks).toBeUndefined()
      expect(arm.attempt?.evidence?.passed).toBe(false)
      expect(arm.attempt?.evidence?.changedPaths).toEqual(['created.txt'])
      expect(arm.attempt?.resultCommit).toBeUndefined()
      expect(arm.journal?.toolCalls).toBe(2)
      expect(arm.journal?.errors).toBe(1)
    }
    expect(record.notes.filter((note) => note.includes('回合没有正常结束'))).toHaveLength(2)
    const markdown = await readFile(markdownFile, 'utf8')
    expect(markdown).toContain('| 回合结束方式 | failed | failed |')
    expect(markdown).toContain('| 失败原因 | step_timeout: sendChat on agent')
  }, 60_000)

  it('fails an arm whose setup command fails, before any agent is spawned, and leaves no worktree behind', async () => {
    const { repo, v1, v2 } = await createRoleHistoryRepo()
    const outDir = await outsideRepo()
    const channel = new FakeHarnessChannel({ toolCalls: 1, writeFile: { name: 'created.txt', content: 'done\n' } })

    const { record } = await compareRoles({ advertise: false, order: 'as-given',
      manifest: manifest(v2, { setup: [{ name: 'install', command: 'echo "store unreachable" >&2; exit 3' }] }),
      arms: [
        { label: 'baseline', source: { kind: 'git', ref: v1 } },
        { label: 'candidate', source: { kind: 'git', ref: v2 } },
      ],
      repoRoot: repo,
      outDir,
      channels: [channel],
      id: 'cmp-3',
    })

    expect(channel.opened).toHaveLength(0)
    for (const arm of record.arms) {
      expect(arm.step.status).toBe('failed')
      expect(arm.step.failure?.code).toBe('host_io_failed')
      expect(arm.step.failure?.message).toBe('workspace setup failed: Check "install" exited with code 3')
      expect(arm.attempt?.agentId).toBeUndefined()
    }
    expect(record.notes.some((note) => note.includes('baseline') && note.includes('未能运行'))).toBe(false)
    // The failed arm's worktree was removed by the driver itself (the Scheduler never learned its id).
    const worktrees = await git(repo, 'worktree list --porcelain')
    expect(worktrees.split('\n').filter((line) => line.startsWith('worktree '))).toHaveLength(1)
  }, 60_000)

  it('rejects fewer than two arms or duplicate labels before doing any work', async () => {
    const { repo, v1 } = await createRoleHistoryRepo()
    await expect(compareRoles({ advertise: false, manifest: manifest(v1), arms: [{ label: 'only', source: { kind: 'git', ref: v1 } }], repoRoot: repo, channels: [] }))
      .rejects.toThrow('at least two arms')
    await expect(compareRoles({ advertise: false, order: 'as-given',
      manifest: manifest(v1),
      arms: [{ label: 'a', source: { kind: 'git', ref: v1 } }, { label: 'a', source: { kind: 'git', ref: v1 } }],
      repoRoot: repo,
      channels: [],
    })).rejects.toThrow('unique')
    expect(dirs.length).toBe(1)
  })
})
