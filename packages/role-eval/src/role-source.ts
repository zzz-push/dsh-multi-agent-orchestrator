import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { FileRoleProvider, computeRoleHash } from '@dsh/agent-manager'
import type { RoleDefinition } from '@dsh/spec'
import { GitCli } from '@dsh/workspace-git'

/**
 * Where one arm's role definitions come from.
 *
 * - `dir`: a roles directory on disk, used as-is (typically the working
 *   tree's `.dsh/roles` — "the current version").
 * - `git`: the roles directory as it existed at a commit, extracted into a
 *   temp directory. This is how "v1.0.0" is materialised: the file at that
 *   ref, not a copy someone kept around.
 */
export type RoleSourceSpec =
  | { kind: 'dir'; dir: string }
  | { kind: 'git'; ref: string; rolesPath?: string }

/** A materialised role source: a directory `FileRoleProvider` can read, plus provenance. */
export interface ResolvedRoleSource {
  spec: RoleSourceSpec
  /** Human label for reports, e.g. `git:0123456^` or `dir:.dsh/roles`. */
  label: string
  rolesDir: string
  /** Full sha when `spec.kind === 'git'`. */
  commit?: string
  /** The role this comparison is about, loaded from `rolesDir`, with its content hash. */
  role: RoleDefinition
  roleHash: string
  /**
   * Hash of the project layer that came with the role from the same source
   * (`project-layer/` next to the roles directory), when there is one. Not
   * part of `roleHash`; a comparison between a monolithic role and a generic
   * role plus project layer differs in both.
   */
  projectLayerHash?: string
  /** Remove any temp directory this source created. Idempotent. */
  cleanup(): Promise<void>
}

export interface ResolveRoleSourceOptions {
  spec: RoleSourceSpec
  /** Role id to load and hash from the source. */
  roleId: string
  /** Repository to read git refs from. Required for `kind: 'git'`. */
  repoRoot?: string
  gitPath?: string
}

/**
 * Parse the CLI shorthand: `git:<ref>[:<rolesPath>]` or a plain directory path.
 */
export function parseRoleSourceSpec(text: string): RoleSourceSpec {
  if (text.startsWith('git:')) {
    const rest = text.slice('git:'.length)
    const separator = rest.indexOf(':')
    if (separator === -1) return { kind: 'git', ref: rest }
    return { kind: 'git', ref: rest.slice(0, separator), rolesPath: rest.slice(separator + 1) }
  }
  return { kind: 'dir', dir: text }
}

/** Materialise a role source and load the role under comparison from it. */
export async function resolveRoleSource(options: ResolveRoleSourceOptions): Promise<ResolvedRoleSource> {
  const { spec, roleId } = options
  if (spec.kind === 'dir') {
    const rolesDir = path.resolve(spec.dir)
    const role = await loadRole(rolesDir, roleId)
    return {
      spec,
      label: `dir:${spec.dir}`,
      rolesDir,
      role,
      roleHash: computeRoleHash(role),
      ...(role.projectLayer === undefined ? {} : { projectLayerHash: role.projectLayer.hash }),
      cleanup: async () => undefined,
    }
  }

  if (options.repoRoot === undefined) throw new Error(`role source git:${spec.ref} needs a repoRoot`)
  const cli = new GitCli({ gitPath: options.gitPath ?? 'git', timeoutMs: 30_000 })
  const rolesPath = spec.rolesPath ?? '.dsh/roles'
  const commit = await cli.execLine(['rev-parse', '--verify', `${spec.ref}^{commit}`], options.repoRoot)
  // `-z`: git quotes non-ASCII paths as octal escapes by default
  // (core.quotePath), which would turn a name like `角色.yaml` into one that
  // exists nowhere. NUL-separated output is verbatim.
  const listing = await cli.exec(['ls-tree', '-r', '--name-only', '-z', commit, '--', rolesPath], options.repoRoot)
  const files = listing.stdout.split('\0').filter((line) => line.endsWith('.yaml') || line.endsWith('.yml'))
  if (files.length === 0) {
    throw new Error(`role source git:${spec.ref}: no role files under ${rolesPath} at ${commit.slice(0, 12)}`)
  }
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'dsh-role-src-'))
  const rolesDir = path.join(tempRoot, 'roles')
  await mkdir(rolesDir, { recursive: true })
  let cleaned = false
  const cleanup = async (): Promise<void> => {
    if (cleaned) return
    cleaned = true
    await rm(tempRoot, { recursive: true, force: true })
  }
  try {
    for (const file of files) {
      const content = await cli.exec(['show', `${commit}:${file}`], options.repoRoot)
      await writeFile(path.join(rolesDir, path.basename(file)), content.stdout, 'utf8')
    }
    // The project layer travels with the roles: same commit, sibling directory
    // (`.dsh/roles` → `.dsh/project-layer`), materialised next to `rolesDir`
    // where `FileRoleProvider` looks for it by default.
    const layerPath = path.posix.join(path.posix.dirname(rolesPath), 'project-layer')
    const layerListing = await cli.exec(['ls-tree', '-r', '--name-only', '-z', commit, '--', layerPath], options.repoRoot)
    const layerFiles = layerListing.stdout.split('\0').filter((line) => line.endsWith('.yaml') || line.endsWith('.yml'))
    if (layerFiles.length > 0) {
      const layerDir = path.join(tempRoot, 'project-layer')
      await mkdir(layerDir, { recursive: true })
      for (const file of layerFiles) {
        const content = await cli.exec(['show', `${commit}:${file}`], options.repoRoot)
        await writeFile(path.join(layerDir, path.basename(file)), content.stdout, 'utf8')
      }
    }
    const role = await loadRole(rolesDir, roleId)
    return {
      spec,
      label: `git:${spec.ref}`,
      rolesDir,
      commit,
      role,
      roleHash: computeRoleHash(role),
      ...(role.projectLayer === undefined ? {} : { projectLayerHash: role.projectLayer.hash }),
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

async function loadRole(rolesDir: string, roleId: string): Promise<RoleDefinition> {
  const role = await new FileRoleProvider({ rolesDir }).get(roleId)
  if (role === undefined) throw new Error(`role ${JSON.stringify(roleId)} not found in ${rolesDir}`)
  return role
}
