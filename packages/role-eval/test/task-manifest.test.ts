import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { loadTaskManifest, parseTaskManifest } from '../src/task-manifest.js'
import { cleanupDirs, dirs } from './fixtures.js'

afterEach(cleanupDirs)

const good = `
id: example-task
title: Fix a reproducible issue
role: example-builder
base_commit: 0123456789abcdef0123456789abcdef01234567
instructions: |
  把 computeSkillSnapshot 接进 spawn()。
checks:
  - name: build
    command: pnpm build
  - name: test
    command: pnpm test
    timeout_ms: 900000
timeout_ms: 1800000
`

describe('parseTaskManifest', () => {
  it('parses a complete manifest', () => {
    const manifest = parseTaskManifest(good, '/tasks/example-task.yaml')
    expect(manifest).toEqual({
      id: 'example-task',
      title: 'Fix a reproducible issue',
      role: 'example-builder',
      baseCommit: '0123456789abcdef0123456789abcdef01234567',
      instructions: '把 computeSkillSnapshot 接进 spawn()。\n',
      checks: [
        { name: 'build', command: 'pnpm build' },
        { name: 'test', command: 'pnpm test', timeoutMs: 900000 },
      ],
      timeoutMs: 1800000,
      file: '/tasks/example-task.yaml',
    })
  })

  it('parses an optional setup list with the same shape as checks', () => {
    expect(parseTaskManifest(good).setup).toBeUndefined()
    const withSetup = parseTaskManifest(good + 'setup:\n  - name: install\n    command: pnpm install --offline\n    timeout_ms: 5\n')
    expect(withSetup.setup).toEqual([{ name: 'install', command: 'pnpm install --offline', timeoutMs: 5 }])
    expect(parseTaskManifest(good + 'setup: []\n').setup).toEqual([])
    expect(() => parseTaskManifest(good + 'setup: install\n')).toThrow('setup must be a list')
    expect(() => parseTaskManifest(good + 'setup:\n  - name: install\n')).toThrow('setup[0].command must be a non-empty string')
  })

  it('carries an optional harness override', () => {
    expect(parseTaskManifest(good).harness).toBeUndefined()
    expect(parseTaskManifest(good + 'harness: claude-code\n').harness).toBe('claude-code')
    expect(() => parseTaskManifest(good + 'harness: ""\n')).toThrow('harness must be a non-empty string when present')
  })

  it('carries an optional sandbox and rejects an empty one', () => {
    expect(parseTaskManifest(good).sandbox).toBeUndefined()
    expect(parseTaskManifest(good + 'sandbox: workspace-write\n').sandbox).toBe('workspace-write')
    expect(() => parseTaskManifest(good + 'sandbox: ""\n')).toThrow('sandbox must be a non-empty string when present')
  })

  it('names the offending field on every defect', () => {
    expect(() => parseTaskManifest('- a\n')).toThrow('top level must be a mapping')
    expect(() => parseTaskManifest(good.replace('id: example-task', 'id: "../x"'))).toThrow('not a safe name')
    expect(() => parseTaskManifest(good.replace('title: Fix a reproducible issue', 'title: ""'))).toThrow('title must be a non-empty string')
    expect(() => parseTaskManifest(good.replace(/checks:[\s\S]*?timeout_ms: 1800000/, 'checks: []\ntimeout_ms: 1800000'))).toThrow('checks must be a non-empty list')
    expect(() => parseTaskManifest(good.replace('command: pnpm build', 'command: 3'))).toThrow('checks[0].command must be a non-empty string')
    expect(() => parseTaskManifest(good.replace('timeout_ms: 900000', 'timeout_ms: -1'))).toThrow('checks[1].timeout_ms must be a positive integer')
    expect(() => parseTaskManifest(good.replace('timeout_ms: 1800000', 'timeout_ms: soon'))).toThrow('timeout_ms must be a positive integer')
    expect(() => parseTaskManifest('id: x\n', '/f.yaml')).toThrow('(/f.yaml)')
  })

  it('loads from disk with the absolute path recorded', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-manifest-'))
    dirs.push(dir)
    const file = path.join(dir, 'task.yaml')
    await writeFile(file, good, 'utf8')
    const manifest = await loadTaskManifest(file)
    expect(manifest.file).toBe(file)
    expect(manifest.id).toBe('example-task')
  })
})
