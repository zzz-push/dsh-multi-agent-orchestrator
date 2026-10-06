import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import {
  loadProjectPolicy,
  getDefaultDevelopmentPolicy,
  getStrictProductionPolicy,
} from '../src/policy/project-policy.js'

describe('loadProjectPolicy', () => {
  const dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('loads and normalizes .dsh/policy.yaml when present', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'dsh-project-policy-'))
    dirs.push(projectRoot)
    await mkdir(path.join(projectRoot, '.dsh'), { recursive: true })
    await writeFile(
      path.join(projectRoot, '.dsh/policy.yaml'),
      [
        'allowedHarnesses: [codex]',
        'allowedFileOperations: [read]',
        'defaults:',
        '  harness: codex',
        '  chatTimeoutMs: 123456',
        '  interactionMode: headless',
        '',
      ].join('\n'),
    )

    // Not this machine's ~/.dsh/mcp-servers.yaml: the test must not depend on the host.
    const policy = await loadProjectPolicy(projectRoot, { mcpServersFile: false })

    expect(policy.allowedHarnesses).toEqual(['codex'])
    expect(policy.allowedFileOperations).toEqual(['read'])
    expect(policy.allowedMcpServers).toBeUndefined()
    expect(policy.defaults).toEqual({
      harness: 'codex',
      chatTimeoutMs: 123456,
      interactionMode: 'headless',
    })
  })

  it('applies a default interactionMode, but no chatTimeoutMs the project did not write, when defaults is partial', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'dsh-project-policy-'))
    dirs.push(projectRoot)
    await mkdir(path.join(projectRoot, '.dsh'), { recursive: true })
    await writeFile(path.join(projectRoot, '.dsh/policy.yaml'), 'allowedHarnesses: [codex]\n')

    // Not this machine's ~/.dsh/mcp-servers.yaml: the test must not depend on the host.
    const policy = await loadProjectPolicy(projectRoot, { mcpServersFile: false })

    expect(policy.defaults).toEqual({
      harness: undefined,
      chatTimeoutMs: undefined,
      interactionMode: 'headless',
    })
  })

  it('falls back to dsh-policy.yaml when .dsh/policy.yaml is absent', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'dsh-project-policy-'))
    dirs.push(projectRoot)
    await writeFile(path.join(projectRoot, 'dsh-policy.yaml'), 'allowedHarnesses: [claude-code]\n')

    // Not this machine's ~/.dsh/mcp-servers.yaml: the test must not depend on the host.
    const policy = await loadProjectPolicy(projectRoot, { mcpServersFile: false })

    expect(policy.allowedHarnesses).toEqual(['claude-code'])
  })

  it('falls back to the default development policy when no policy file exists', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'dsh-project-policy-'))
    dirs.push(projectRoot)

    // Not this machine's ~/.dsh/mcp-servers.yaml: the test must not depend on the host.
    const policy = await loadProjectPolicy(projectRoot, { mcpServersFile: false })

    expect(policy).toEqual(getDefaultDevelopmentPolicy())
  })
})

describe('getStrictProductionPolicy', () => {
  it('returns a fully locked-down example policy', () => {
    const policy = getStrictProductionPolicy()

    expect(policy.allowedHarnesses).toEqual(['codex', 'claude-code'])
    expect(policy.allowedFileOperations).toEqual(['read', 'list'])
    expect(policy.allowedSandboxModes).toEqual(['read-only'])
    expect(policy.defaults.interactionMode).toBe('headless')
  })
})
