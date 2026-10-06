import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { computeRoleHash } from '@dsh/agent-manager'

import { parseRoleSourceSpec, resolveRoleSource } from '../src/role-source.js'
import { cleanupDirs, createRoleHistoryRepo, git, roleYaml } from './fixtures.js'

afterEach(cleanupDirs)

describe('parseRoleSourceSpec', () => {
  it('reads the CLI shorthand', () => {
    expect(parseRoleSourceSpec('.dsh/roles')).toEqual({ kind: 'dir', dir: '.dsh/roles' })
    expect(parseRoleSourceSpec('git:0123456^')).toEqual({ kind: 'git', ref: '0123456^' })
    expect(parseRoleSourceSpec('git:v1.0.0:packs/roles')).toEqual({ kind: 'git', ref: 'v1.0.0', rolesPath: 'packs/roles' })
  })
})

describe('resolveRoleSource', () => {
  it('materialises the roles directory as it was at a commit, and cleans up after itself', async () => {
    const { repo, v1, v2 } = await createRoleHistoryRepo()
    const source = await resolveRoleSource({ spec: { kind: 'git', ref: v1 }, roleId: 'worker', repoRoot: repo })
    expect(source.commit).toBe(v1)
    expect(source.label).toBe(`git:${v1}`)
    expect(source.role.version).toBe('1.0.0')
    expect(source.role.systemPrompt).toBe('You are v1.\n')
    expect(source.roleHash).toBe(computeRoleHash(source.role))
    expect(source.rolesDir).not.toContain(repo)
    await expect(stat(path.join(source.rolesDir, 'worker.yaml'))).resolves.toBeTruthy()

    // The current working tree is v2 and is untouched by extracting v1.
    const current = await resolveRoleSource({ spec: { kind: 'dir', dir: path.join(repo, '.dsh', 'roles') }, roleId: 'worker' })
    expect(current.role.version).toBe('2.0.0')
    expect(current.roleHash).not.toBe(source.roleHash)
    expect(await git(repo, 'rev-parse HEAD')).toBe(v2)

    await source.cleanup()
    await expect(stat(source.rolesDir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(source.cleanup()).resolves.toBeUndefined()
  })

  it('resolves symbolic refs and picks up every role file at that commit, not just the one asked for', async () => {
    const { repo, v1 } = await createRoleHistoryRepo()
    await writeFile(path.join(repo, '.dsh', 'roles', 'reviewer.yaml'), roleYaml('1.0.0', 'Review.').replace('role_id: worker', 'role_id: reviewer'), 'utf8')
    await git(repo, 'add -A')
    await git(repo, 'commit --quiet -m "add reviewer"')
    const source = await resolveRoleSource({ spec: { kind: 'git', ref: 'HEAD' }, roleId: 'worker', repoRoot: repo })
    expect(source.commit).not.toBe(v1)
    await expect(stat(path.join(source.rolesDir, 'reviewer.yaml'))).resolves.toBeTruthy()
    await source.cleanup()
  })

  it('brings the project layer from the same commit, and hashes it apart from the role', async () => {
    const { repo, v2 } = await createRoleHistoryRepo()
    await mkdir(path.join(repo, '.dsh', 'project-layer'), { recursive: true })
    await writeFile(path.join(repo, '.dsh', 'project-layer', 'worker.yaml'), [
      'kind: ProjectLayer',
      'metadata:',
      '  role_id: worker',
      'context: This project uses pnpm.',
      '',
    ].join('\n'), 'utf8')
    await git(repo, 'add -A')
    await git(repo, 'commit --quiet -m "add project layer"')
    const withLayer = await git(repo, 'rev-parse HEAD')

    const before = await resolveRoleSource({ spec: { kind: 'git', ref: v2 }, roleId: 'worker', repoRoot: repo })
    const after = await resolveRoleSource({ spec: { kind: 'git', ref: withLayer }, roleId: 'worker', repoRoot: repo })
    const dir = await resolveRoleSource({ spec: { kind: 'dir', dir: path.join(repo, '.dsh', 'roles') }, roleId: 'worker' })
    try {
      expect(before.projectLayerHash).toBeUndefined()
      expect(after.projectLayerHash).toMatch(/^[0-9a-f]{64}$/)
      expect(after.role.projectLayer?.context).toBe('This project uses pnpm.')
      // Same role file at both commits: same role hash, whatever the layer.
      expect(after.roleHash).toBe(before.roleHash)
      expect(dir.projectLayerHash).toBe(after.projectLayerHash)
    } finally {
      await Promise.all([before.cleanup(), after.cleanup(), dir.cleanup()])
    }
  })

  it('extracts role files with non-ASCII names verbatim (git would otherwise octal-escape them)', async () => {
    const { repo } = await createRoleHistoryRepo()
    await writeFile(path.join(repo, '.dsh', 'roles', '构建示例角色.yaml'), roleYaml('1.0.0', '实现。').replace('role_id: worker', 'role_id: example-builder'), 'utf8')
    await git(repo, 'add -A')
    await git(repo, 'commit --quiet -m "add chinese-named role"')
    const source = await resolveRoleSource({ spec: { kind: 'git', ref: 'HEAD' }, roleId: 'example-builder', repoRoot: repo })
    expect(source.role.name).toBe('Worker')
    expect(source.role.systemPrompt).toBe('实现。\n')
    await expect(stat(path.join(source.rolesDir, '构建示例角色.yaml'))).resolves.toBeTruthy()
    await source.cleanup()
  })

  it('fails loudly for an unknown ref, a missing role, an empty roles path, or a git source without repoRoot', async () => {
    const { repo, v1 } = await createRoleHistoryRepo()
    await expect(resolveRoleSource({ spec: { kind: 'git', ref: 'no-such-ref' }, roleId: 'worker', repoRoot: repo })).rejects.toThrow()
    await expect(resolveRoleSource({ spec: { kind: 'git', ref: v1 }, roleId: 'ghost', repoRoot: repo })).rejects.toThrow('"ghost" not found')
    await expect(resolveRoleSource({ spec: { kind: 'git', ref: v1, rolesPath: 'nowhere' }, roleId: 'worker', repoRoot: repo })).rejects.toThrow('no role files under nowhere')
    await expect(resolveRoleSource({ spec: { kind: 'git', ref: v1 }, roleId: 'worker' })).rejects.toThrow('needs a repoRoot')
    await expect(resolveRoleSource({ spec: { kind: 'dir', dir: path.join(repo, '.dsh', 'roles') }, roleId: 'ghost' })).rejects.toThrow('"ghost" not found')
  })
})
