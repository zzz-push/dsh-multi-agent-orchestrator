import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileRoleProvider } from '../src/role/file-provider.js'

const dirs: string[] = []
afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('FileRoleProvider', () => {
  it('loads and lists role definitions from the configured directory', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-roles-'))
    dirs.push(dir)
    await writeFile(path.join(dir, 'example.yaml'), [
      'api_version: dsh.orchestrator/v1alpha1',
      'kind: Role',
      'metadata:',
      '  role_id: example-role',
      '  name: Example Role',
      '  version: 1.0.0',
      '  description: A reusable example role',
      'system_prompt: Complete a task and report evidence.',
      'execution:',
      '  harness: codex',
      '  keep_alive_after_task: false',
    ].join('\n'))
    const provider = new FileRoleProvider({ rolesDir: dir })
    const roles = await provider.list()
    expect(roles.map((role) => role.roleId)).toEqual(['example-role'])
    expect(await provider.get('example-role')).toMatchObject({
      name: 'Example Role',
      execution: { harness: 'codex', keepAliveAfterTask: false },
    })
  })

  it('validates malformed files and ignores non-YAML entries', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-roles-'))
    dirs.push(dir)
    await mkdir(path.join(dir, 'nested'))
    await writeFile(path.join(dir, 'README.txt'), 'ignore')
    await writeFile(path.join(dir, 'bad.yaml'), 'role_id: [broken')
    const provider = new FileRoleProvider({ rolesDir: dir })
    await expect(provider.list()).rejects.toThrow('Invalid role file')
  })

  it('returns an empty list for a missing directory and applies defaults', async () => {
    const dir = path.join(await mkdtemp(path.join(tmpdir(), 'dsh-roles-')), 'missing')
    dirs.push(path.dirname(dir))
    const provider = new FileRoleProvider({ rolesDir: dir })
    expect(await provider.list()).toEqual([])
    await mkdir(dir)
    const roleFile = path.join(dir, 'minimal.yaml')
    await writeFile(roleFile, [
      'role_id: minimal',
      'name: Minimal',
      'execution:',
      '  harness: claude-code',
    ].join('\n'))
    expect((await provider.get('minimal'))?.execution.chatTimeoutMs).toBe(600_000)
  })

  it('skips a role file that cannot be read, without failing the whole list', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-roles-'))
    dirs.push(dir)
    // A directory named *.yaml passes the extension filter in roleFiles() but
    // fails readFile() with EISDIR, exercising the "unreadable file" branch.
    await mkdir(path.join(dir, 'not-actually-a-file.yaml'))
    const warnings: string[] = []
    const provider = new FileRoleProvider({ rolesDir: dir, logger: { warn: (message) => warnings.push(message) } })

    expect(await provider.list()).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Skipping unreadable role file')
  })
})
