import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { HarnessContextHider } from '../src/hidden-context.js'
import { cleanupDirs, dirs, git } from './fixtures.js'

afterEach(cleanupDirs)

async function repoWithContext(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), 'dsh-hidden-ctx-'))
  dirs.push(repo)
  await git(repo, 'init --quiet')
  await git(repo, 'config user.name "Test User"')
  await git(repo, 'config user.email "test@example.com"')
  const files: Record<string, string> = {
    'README.md': '# fixture\n',
    'CLAUDE.md': '# project instructions\n',
    'packages/x/AGENTS.md': '# nested codex instructions\n',
    '.claude/skills/helper/SKILL.md': '---\nname: helper\n---\n',
    '.claude/settings.json': '{"permissions":{}}\n',
    'docs/CLAUDE.md.bak': 'not an instruction file\n',
  }
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, relative)), { recursive: true })
    await writeFile(path.join(repo, relative), content, 'utf8')
  }
  await git(repo, 'add -A')
  await git(repo, 'commit --quiet -m base')
  return repo
}

describe('HarnessContextHider', () => {
  it('moves the harness instructions out, keeps git status clean, and puts them back', async () => {
    const repo = await repoWithContext()
    const hider = new HarnessContextHider()

    const hidden = await hider.hide(repo)
    expect(hidden).toEqual(['.claude/skills/helper/SKILL.md', 'CLAUDE.md', 'packages/x/AGENTS.md'])
    for (const relative of hidden) expect(existsSync(path.join(repo, relative))).toBe(false)
    // Settings are how tools behave, not what the model knows: they stay.
    expect(existsSync(path.join(repo, '.claude/settings.json'))).toBe(true)
    expect(existsSync(path.join(repo, 'docs/CLAUDE.md.bak'))).toBe(true)
    // No trail of deleted instruction files for the agent to notice.
    expect(await git(repo, 'status --porcelain')).toBe('')

    const report = await hider.restore(repo)
    expect(report).toEqual({ hidden })
    expect(await readFile(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe('# project instructions\n')
    expect(await git(repo, 'status --porcelain')).toBe('')
    // Idempotent: a second restore reports the same thing and changes nothing.
    expect(await hider.restore(repo)).toEqual({ hidden })
  })

  it('keeps a hidden file the agent recreated during its turn, and says so', async () => {
    const repo = await repoWithContext()
    const hider = new HarnessContextHider()
    await hider.hide(repo)
    await writeFile(path.join(repo, 'CLAUDE.md'), '# written by the agent\n', 'utf8')

    const report = await hider.restore(repo)

    expect(report?.keptAgentVersion).toEqual(['CLAUDE.md'])
    expect(await readFile(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe('# written by the agent\n')
    expect(await git(repo, 'status --porcelain')).toBe('M CLAUDE.md')
    expect(existsSync(path.join(repo, 'packages/x/AGENTS.md'))).toBe(true)
  })

  it('reports nothing for a worktree it never touched', async () => {
    expect(await new HarnessContextHider().restore('/nowhere')).toBeUndefined()
  })
})
