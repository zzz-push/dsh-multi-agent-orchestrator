import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { compareRoles } from '../src/compare.js'
import { GitCli } from '@dsh/workspace-git'

import { blindingFileFor, buildEvidenceBundle, harnessContextFiles, hideVersionTokens, stripWorktreePaths } from '../src/evidence-bundle.js'
import type { TaskManifest } from '../src/task-manifest.js'
import { FakeHarnessChannel, cleanupDirs, createRoleHistoryRepo, dirs, git, roleYaml } from './fixtures.js'

afterEach(cleanupDirs)

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** Every file under `dir`, relative, sorted. */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name)
    if (entry.isDirectory()) out.push(...await listFiles(dir, relative))
    else out.push(relative)
  }
  return out.sort()
}

async function allText(dir: string): Promise<string> {
  const files = await listFiles(dir)
  return (await Promise.all(files.map((file) => readFile(path.join(dir, file), 'utf8')))).join('\n')
}

/** Run a real (fake-harness) comparison and return its record directory. */
async function recordedComparison(extra: Partial<TaskManifest> = {}, order: 'random' | 'as-given' = 'random'): Promise<{ repo: string; recordDir: string }> {
  const { repo, v1 } = await createRoleHistoryRepo()
  const recordDir = await tempDir('dsh-eval-record-')
  // A manifest on disk, with an author comment that records a result — exactly what must not reach the evaluator.
  const manifestFile = path.join(await tempDir('dsh-eval-manifest-'), 'task.yaml')
  await writeFile(manifestFile, [
    '# 已验证：两臂都会通过，candidate 更快',
    'id: touch-file',
    'title: Create created.txt',
    'role: worker',
    `base_commit: ${v1}`,
    'instructions: Create created.txt containing done.',
    'checks:',
    '  - name: file exists',
    '    command: test -f created.txt',
    'hidden_checks:',
    '  - name: contract',
    '    command: grep -q done created.txt  # secret command',
    '',
  ].join('\n'), 'utf8')
  const manifest: TaskManifest = {
    id: 'touch-file',
    title: 'Create created.txt',
    role: 'worker',
    baseCommit: v1,
    instructions: 'Create created.txt containing done.',
    checks: [{ name: 'file exists', command: 'test -f created.txt' }],
    file: manifestFile,
    ...extra,
  }
  await compareRoles({
    advertise: false,
    order,
    manifest,
    arms: [
      { label: 'baseline', source: { kind: 'git', ref: v1 } },
      { label: 'candidate', source: { kind: 'dir', dir: path.join(repo, '.dsh', 'roles') } },
    ],
    repoRoot: repo,
    outDir: recordDir,
    channels: [new FakeHarnessChannel({ toolCalls: 2, writeFile: { name: 'created.txt', content: 'done\n' } })],
    id: 'cmp-bundle',
  })
  return { repo, recordDir }
}

describe('harnessContextFiles', () => {
  it('reports the instruction files the harnesses that ran load on their own, at the base commit only', async () => {
    const { repo, v1 } = await createRoleHistoryRepo()
    const cli = new GitCli({ gitPath: 'git', timeoutMs: 30_000 })
    expect(await harnessContextFiles(cli, repo, v1, ['claude-code', 'codex'])).toEqual([])
    await writeFile(path.join(repo, 'CLAUDE.md'), '# rules\nline two\n', 'utf8')
    await writeFile(path.join(repo, 'AGENTS.md'), '# agents\n', 'utf8')
    await git(repo, 'add -A')
    await git(repo, 'commit --quiet -m context')
    const withContext = await git(repo, 'rev-parse HEAD')
    expect(await harnessContextFiles(cli, repo, withContext, ['claude-code'])).toEqual([{ harness: 'claude-code', path: 'CLAUDE.md', lines: 2 }])
    expect(await harnessContextFiles(cli, repo, withContext, ['codex'])).toEqual([{ harness: 'codex', path: 'AGENTS.md', lines: 1 }])
    expect(await harnessContextFiles(cli, repo, withContext, ['fake'])).toEqual([])
    // Only the base commit counts, not what the repository has now.
    expect(await harnessContextFiles(cli, repo, v1, ['claude-code'])).toEqual([])
  })
})

describe('stripWorktreePaths', () => {
  it('rewrites the worktree prefix to ./ and leaves text glued to the path alone', () => {
    const root = '/tmp/dsh-orchestrator/worktrees/abc123/run-candidate-1/task/1/'
    expect(stripWorktreePaths(`工具调用 \`fileChange\`：改动文件：${root}docs/maintenance.md, ${root}src/a.ts`))
      .toBe('工具调用 `fileChange`：改动文件：./docs/maintenance.md, ./src/a.ts')
    expect(stripWorktreePaths(`> build ${root.slice(0, -1)}/\n"path":"${root}x.ts"`)).toBe('> build ./\n"path":"./x.ts"')
    expect(stripWorktreePaths('/Users/me/repo/src/a.ts')).toBe('/Users/me/repo/src/a.ts')
  })
})

describe('hideVersionTokens', () => {
  it('hides bare and v-prefixed versions, and leaves longer versions and identifiers alone', () => {
    const text = [
      'version: 2.0.0',
      'dsh.upgraded_from: v1.0.0 (旧格式)',
      'node 11.0.0, pnpm 1.0.0-rc, x1.0.0, 1.0.0.1',
      '"version": "1.0.0"',
    ].join('\n')
    expect(hideVersionTokens(text, ['1.0.0', '2.0.0'])).toBe([
      'version: <hidden>',
      'dsh.upgraded_from: <hidden> (旧格式)',
      'node 11.0.0, pnpm 1.0.0-rc, x1.0.0, 1.0.0.1',
      '"version": "<hidden>"',
    ].join('\n'))
  })
})

describe('buildEvidenceBundle', () => {
  it('gives the rubric phase the task and both role definitions, and no results at all', async () => {
    const { recordDir } = await recordedComparison()
    const out = path.join(await tempDir('dsh-eval-out-'), 'bundle')

    const result = await buildEvidenceBundle({ record: recordDir, outDir: out, phase: 'rubric' })

    expect(await listFiles(out)).toEqual(['README.md', 'roles/baseline.yaml', 'roles/candidate.yaml', 'roles/diff.patch', 'task/manifest.yaml'])
    expect(result.files).toEqual(await listFiles(out))
    // The hash covers everything but the README that quotes it.
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(await readFile(path.join(out, 'README.md'), 'utf8')).toContain(result.contentHash)
    expect(await readFile(path.join(out, 'roles/baseline.yaml'), 'utf8')).toBe(roleYaml('1.0.0', 'You are v1.'))
    const diff = await readFile(path.join(out, 'roles/diff.patch'), 'utf8')
    expect(diff).toContain('-  You are v1.')
    expect(diff).toContain('+  You are v2, more careful.')
    expect(diff).toContain('roles/baseline.yaml')
    // No harness override in this run, so no such line.
    expect(await readFile(path.join(out, 'README.md'), 'utf8')).not.toContain('两臂实际都跑在')
    // Nothing about outcomes leaks through the README either.
    const readme = await readFile(path.join(out, 'README.md'), 'utf8')
    expect(readme).toContain('本包刻意不含任何结果')
    expect(readme).not.toMatch(/候选提交|merged|delivered|verdict/)
  }, 60_000)

  it('tells the evaluator when every arm ran on a harness other than the one the roles declare', async () => {
    const { recordDir } = await recordedComparison({ harness: 'fake', sandbox: 'workspace-write' })
    const out = path.join(await tempDir('dsh-eval-out-'), 'bundle')
    await buildEvidenceBundle({ record: recordDir, outDir: out, phase: 'rubric' })
    const readme = await readFile(path.join(out, 'README.md'), 'utf8')
    expect(readme).toContain('两臂实际都跑在 `fake` 上')
    expect(readme).toContain('沙箱：`workspace-write`')
  }, 60_000)

  it('strips manifest author comments and hidden-check commands, keeping only what the arms were asked and how they were checked', async () => {
    const { recordDir } = await recordedComparison()
    const out = path.join(await tempDir('dsh-eval-out-'), 'bundle')
    await buildEvidenceBundle({ record: recordDir, outDir: out, phase: 'rubric' })

    const manifest = await readFile(path.join(out, 'task/manifest.yaml'), 'utf8')
    expect(manifest).toContain('Create created.txt containing done.')
    expect(manifest).toContain('file exists')
    expect(manifest).toContain('contract')
    expect(manifest).not.toContain('已验证')
    expect(manifest).not.toContain('secret command')
    expect(manifest).not.toContain('grep -q done')
  }, 60_000)

  it('adds results in the grade phase: re-derived record, per-arm diff, final reply and timeline', async () => {
    const { recordDir } = await recordedComparison()
    const out = path.join(await tempDir('dsh-eval-out-'), 'bundle')
    await buildEvidenceBundle({ record: recordDir, outDir: out, phase: 'grade' })

    const files = await listFiles(out)
    for (const arm of ['baseline', 'candidate']) {
      expect(files).toContain(`results/${arm}/run-1/diff.patch`)
      expect(files).toContain(`results/${arm}/run-1/final-reply.md`)
      expect(files).toContain(`results/${arm}/run-1/timeline.md`)
      expect(await readFile(path.join(out, `results/${arm}/run-1/diff.patch`), 'utf8')).toContain('+done')
      const timeline = await readFile(path.join(out, `results/${arm}/run-1/timeline.md`), 'utf8')
      expect(timeline).toContain('工具调用 `write_file`')
      expect(timeline).toContain('提交完成报告')
      expect(await readFile(path.join(out, `results/${arm}/run-1/final-reply.md`), 'utf8')).toContain('**自述**')
    }
    const record = JSON.parse(await readFile(path.join(out, 'results/comparison.json'), 'utf8')) as { verdict?: string[]; arms: Array<{ scorecard?: unknown; journalFile: string }> }
    expect(record.verdict?.[0]).toContain('交付')
    expect(record.arms.every((arm) => arm.scorecard !== undefined)).toBe(true)
    // Paths point into the bundle, not at the controller's disk.
    expect(record.arms.map((arm) => arm.journalFile)).toEqual(['results/baseline/run-1/timeline.md', 'results/candidate/run-1/timeline.md'])
  }, 60_000)

  it('blinds: no label, version or run id survives anywhere in the bundle, and the mapping lives outside it', async () => {
    const { recordDir } = await recordedComparison()
    const recorded = JSON.parse(await readFile(path.join(recordDir, 'comparison.json'), 'utf8')) as { arms: Array<{ runId: string }> }
    const out = path.join(await tempDir('dsh-eval-out-'), 'bundle')

    const rubric = await buildEvidenceBundle({ record: recordDir, outDir: out, phase: 'rubric', blind: true, seed: 7 })
    const grade = await buildEvidenceBundle({ record: recordDir, outDir: out, phase: 'grade', blind: true, seed: 999 })

    // The second build reuses the first mapping, whatever seed it was given.
    expect(grade.blinding?.mapping).toEqual(rubric.blinding?.mapping)
    expect(Object.values(rubric.blinding!.mapping.arms).sort()).toEqual(['A', 'B'])
    expect(rubric.blinding?.file).toBe(blindingFileFor(out))
    expect(path.dirname(rubric.blinding!.file)).toBe(path.dirname(out))
    await expect(stat(rubric.blinding!.file)).resolves.toBeTruthy()

    const text = await allText(out)
    expect(text).not.toMatch(/\bbaseline\b/)
    expect(text).not.toMatch(/\bcandidate\b/)
    expect(text).not.toMatch(/(?<![\w.])[12]\.0\.0(?![\w.])/)
    for (const arm of recorded.arms) expect(text).not.toContain(arm.runId)
    expect(text).toContain('<hidden>')
    expect(await listFiles(out)).toEqual(expect.arrayContaining(['roles/A.yaml', 'roles/B.yaml', 'results/A/run-1/timeline.md', 'results/B/run-1/timeline.md']))

    // When each arm ran is no clue either: the order's seed and the run positions stay out.
    const shown = JSON.parse(await readFile(path.join(out, 'results/comparison.json'), 'utf8')) as { ordering?: unknown; arms: Array<{ runPosition?: number }> }
    expect(shown.ordering).toEqual({ mode: 'random' })
    expect(shown.arms.every((arm) => arm.runPosition === undefined)).toBe(true)
    expect(text).not.toContain('执行顺序没有随机化')
  }, 60_000)

  it('warns a blinded evaluator when the arms ran in the given order, since start times then give the baseline away', async () => {
    const { recordDir } = await recordedComparison({}, 'as-given')
    const out = path.join(await tempDir('dsh-eval-out-'), 'bundle')
    await buildEvidenceBundle({ record: recordDir, outDir: out, phase: 'grade', blind: true, seed: 3 })
    const text = await allText(out)
    expect(text).toContain('这次对比没有随机化执行顺序')
    expect(text).toContain('执行顺序没有随机化——')
    expect(text).not.toMatch(/\bbaseline\b/)
    expect(text).not.toMatch(/\bcandidate\b/)
  }, 60_000)

  it('lists and diffs the arms in letter order, so the baseline is not simply whichever comes first', async () => {
    const { recordDir } = await recordedComparison()
    const recorded = JSON.parse(await readFile(path.join(recordDir, 'comparison.json'), 'utf8')) as { id: string; arms: Array<{ label: string }> }
    expect(recorded.arms.map((arm) => arm.label)).toEqual(['baseline', 'candidate'])
    const out = path.join(await tempDir('dsh-eval-out-'), 'bundle')
    // The draw that used to give it away: the baseline, listed first, got B.
    await writeFile(blindingFileFor(out), `${JSON.stringify({ recordId: recorded.id, seed: 0, arms: { baseline: 'B', candidate: 'A' } })}\n`)

    await buildEvidenceBundle({ record: recordDir, outDir: out, phase: 'grade', blind: true })

    const shown = JSON.parse(await readFile(path.join(out, 'results/comparison.json'), 'utf8')) as { arms: Array<{ label: string }> }
    expect(shown.arms.map((arm) => arm.label)).toEqual(['A', 'B'])
    const diff = await readFile(path.join(out, 'roles/diff.patch'), 'utf8')
    expect(diff.indexOf('roles/A.yaml')).toBeGreaterThanOrEqual(0)
    expect(diff.indexOf('roles/A.yaml')).toBeLessThan(diff.indexOf('roles/B.yaml'))
    const readme = await readFile(path.join(out, 'README.md'), 'utf8')
    expect(readme.indexOf('- **A**')).toBeLessThan(readme.indexOf('- **B**'))
  }, 60_000)

  it('assigns A/B deterministically from the seed for a new bundle', async () => {
    const { recordDir } = await recordedComparison()
    const base = await tempDir('dsh-eval-out-')
    const first = await buildEvidenceBundle({ record: recordDir, outDir: path.join(base, 'one'), phase: 'rubric', blind: true, seed: 42 })
    const second = await buildEvidenceBundle({ record: recordDir, outDir: path.join(base, 'two'), phase: 'rubric', blind: true, seed: 42 })
    expect(second.blinding?.mapping.arms).toEqual(first.blinding?.mapping.arms)
  }, 60_000)

  it('keeps files it does not own (feedback, the evaluator journal) across rebuilds', async () => {
    const { recordDir } = await recordedComparison()
    const out = path.join(await tempDir('dsh-eval-out-'), 'bundle')
    await buildEvidenceBundle({ record: recordDir, outDir: out, phase: 'rubric' })
    await writeFile(path.join(out, 'kept.txt'), 'x', 'utf8')
    await buildEvidenceBundle({ record: recordDir, outDir: out, phase: 'grade' })
    expect(await readFile(path.join(out, 'kept.txt'), 'utf8')).toBe('x')
  }, 60_000)

  it('refuses an --out that holds files of its own where the bundle would go, and deletes nothing', async () => {
    const { recordDir } = await recordedComparison()
    const project = await tempDir('dsh-eval-out-')
    await writeFile(path.join(project, 'README.md'), '# My project\n', 'utf8')
    await mkdir(path.join(project, 'roles'))
    await writeFile(path.join(project, 'roles', 'mine.yaml'), 'x', 'utf8')

    await expect(buildEvidenceBundle({ record: recordDir, outDir: project, phase: 'rubric' })).rejects.toThrow('is not an evidence bundle')
    expect(await readFile(path.join(project, 'README.md'), 'utf8')).toBe('# My project\n')
    expect(await readFile(path.join(project, 'roles', 'mine.yaml'), 'utf8')).toBe('x')
  }, 60_000)

  it('refuses to build when a role source no longer matches the hash the run recorded', async () => {
    const { repo, recordDir } = await recordedComparison()
    // The candidate arm read the working tree's roles; someone edits the role afterwards.
    await writeFile(path.join(repo, '.dsh', 'roles', 'worker.yaml'), roleYaml('2.0.1', 'You are v2, edited later.'), 'utf8')
    const out = path.join(await tempDir('dsh-eval-out-'), 'bundle')
    await expect(buildEvidenceBundle({ record: recordDir, outDir: out, phase: 'rubric' })).rejects.toThrow('the role changed since the comparison ran')
  }, 60_000)
})
