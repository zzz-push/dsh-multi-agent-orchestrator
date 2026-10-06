import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { InvalidRoleError } from '../errors.js'
import { listScenarios, loadProjectLayer } from './project-layer.js'
import {
  type ProjectLayer,
  type RoleDefinition,
  type RoleProvider,
  type RoleSummary,
} from './types.js'
import { RoleSchemaError, validateRoleDocument } from './schema-validator.js'

/**
 * // TODO: 临时实现 —— 角色定义目前直接扫描 `.dsh/roles/*.yaml`。
 * 架构决策（公开设计说明
 * 要求角色库实现为 Role Pack Skill，通过 `ctx.skills.get()` 渐进披露加载
 * （目录布局 `.dsh/skills/dsh-role-pack/{SKILL.md,roles/*.yaml}`），而非扫盘。
 * Harness skill 包接口在本地尚不可用时，用 `RoleProvider` 接口隔离来源，
 * 届时新增 `SkillRoleProvider` 并切换默认实现即可，调用方不受影响。
 * 详见宿主项目自己的维护记录。
 */
export interface FileRoleProviderOptions {
  /** Directory scanned for `*.yaml` / `*.yml` role files. */
  rolesDir: string
  /**
   * Directory of project layers (`kind: ProjectLayer`, one per role, matched
   * by `metadata.role_id`). Default: `project-layer` next to `rolesDir`
   * (`.dsh/roles` → `.dsh/project-layer`). `false` loads roles without any
   * project layer.
   */
  projectLayerDir?: string | false
  /** Optional logger; defaults to silent. */
  logger?: {
    warn(message: string): void
  }
}

/**
 * Role provider that reads `.dsh/roles/*.yaml` files from disk.
 *
 * Every `get`/`list` re-reads the directory: role files are small and few
 * (the trigger condition is > 10 roles), so caching is not worth
 * its invalidation complexity yet.
 */
export class FileRoleProvider implements RoleProvider {
  private readonly rolesDir: string
  private readonly projectLayerDir: string | undefined
  private readonly logger?: { warn(message: string): void }

  constructor(options: FileRoleProviderOptions) {
    this.rolesDir = path.resolve(options.rolesDir)
    this.projectLayerDir = options.projectLayerDir === false
      ? undefined
      : path.resolve(options.projectLayerDir ?? path.join(path.dirname(this.rolesDir), 'project-layer'))
    this.logger = options.logger
  }

  async get(roleId: string): Promise<RoleDefinition | undefined> {
    for (const file of await yamlFiles(this.rolesDir)) {
      const role = await this.tryLoad(file)
      if (role !== undefined && role.roleId === roleId) {
        const projectLayer = await this.layerFor(roleId)
        return projectLayer === undefined ? role : { ...role, projectLayer }
      }
    }
    return undefined
  }

  async list(): Promise<RoleSummary[]> {
    const summaries: RoleSummary[] = []
    for (const file of await yamlFiles(this.rolesDir)) {
      const role = await this.tryLoad(file)
      if (role === undefined) continue
      const projectLayer = await this.layerFor(role.roleId)
      summaries.push(toSummary(projectLayer === undefined ? role : { ...role, projectLayer }))
    }
    summaries.sort((a, b) => a.roleId.localeCompare(b.roleId))
    return summaries
  }

  /** The project layer for `roleId`, if the project has one. Two layers for one role is an error. */
  private async layerFor(roleId: string): Promise<ProjectLayer | undefined> {
    if (this.projectLayerDir === undefined) return undefined
    let found: ProjectLayer | undefined
    for (const file of await yamlFiles(this.projectLayerDir)) {
      const layer = await loadProjectLayer(file)
      if (layer.roleId !== roleId) continue
      if (found !== undefined) {
        throw new RoleSchemaError(`角色 ${roleId} 有两个项目层文件：${found.source} 与 ${file}`, file)
      }
      found = layer
    }
    return found
  }

  /**
   * Load and validate one role file. Returns `undefined` when the file
   * cannot be read (logged); throws a schema error for files that exist but
   * do not conform to either supported role format.
   */
  private async tryLoad(file: string): Promise<RoleDefinition | undefined> {
    let source: string
    try {
      source = await readFile(file, 'utf8')
    } catch (error) {
      this.logger?.warn(`Skipping unreadable role file "${file}": ${String(error)}`)
      return undefined
    }

    let raw: unknown
    try {
      raw = parseYaml(source)
    } catch (error) {
      throw new InvalidRoleError(file, `YAML parse failed: ${String(error)}`)
    }
    try {
      return validateRoleDocument(raw, file)
    } catch (error) {
      if (error instanceof RoleSchemaError) throw error
      throw new InvalidRoleError(file, String(error))
    }
  }
}

/** Sorted `*.yaml` / `*.yml` files in `dir`; `[]` when it does not exist. */
async function yamlFiles(dir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'))
    .sort()
    .map((entry) => path.join(dir, entry))
}

function toSummary(role: RoleDefinition): RoleSummary {
  const scenarios = listScenarios(role).map((scenario) => scenario.name)
  return {
    roleId: role.roleId,
    name: role.name,
    version: role.version,
    harness: role.execution.harness,
    keepAliveAfterTask: role.execution.keepAliveAfterTask,
    ...(scenarios.length === 0 ? {} : { scenarios }),
  }
}
