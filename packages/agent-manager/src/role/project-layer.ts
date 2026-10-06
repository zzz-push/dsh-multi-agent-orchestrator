import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { stableSerialize } from '@dsh/core'
import { parse as parseYaml } from 'yaml'

import { RoleSchemaError, validateScenarios } from './schema-validator.js'
import type { ProjectLayer, RoleDefinition, RoleScenario, VerificationRule } from './types.js'

/**
 * A project's layer on top of one generic role (a product decision):
 * `.dsh/project-layer/<roleId>.yaml`, next to `.dsh/roles/`.
 *
 * ```yaml
 * api_version: dsh.orchestrator/v1alpha1
 * kind: ProjectLayer
 * metadata:
 *   role_id: example-builder
 * context: |            # optional; appended to the role's system prompt
 *   ...
 * scenarios:            # optional; same shape as a role's scenarios
 *   - name: maintenance
 *     when: ...
 *     guidance: ...
 * verification:         # optional; same shape as a role's, run after the role's own
 *   - type: content_policy
 *     config: { deny_patterns: [...] }
 * ```
 *
 * The layer is for what the harness does not already load: CLAUDE.md /
 * AGENTS.md reach the agent on their own, so repeating them here only makes
 * two copies to keep in step.
 */
export const PROJECT_LAYER_KIND = 'ProjectLayer'

/** Heading the project context is appended under. */
export const PROJECT_CONTEXT_HEADING = '## 本项目补充说明'

/** Parse and validate a project layer document. */
export function parseProjectLayerDocument(raw: unknown, source: string): ProjectLayer {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RoleSchemaError('项目层文件必须是对象', source)
  }
  const doc = raw as Record<string, unknown>
  if (doc.kind !== PROJECT_LAYER_KIND) {
    throw new RoleSchemaError(`期望 kind: ${PROJECT_LAYER_KIND}，实际: ${String(doc.kind)}`, source)
  }
  const metadata = doc.metadata
  const roleId = typeof metadata === 'object' && metadata !== null ? (metadata as Record<string, unknown>).role_id : undefined
  if (typeof roleId !== 'string' || roleId === '') {
    throw new RoleSchemaError('metadata.role_id 必须是非空字符串', source)
  }
  if (doc.context !== undefined && (typeof doc.context !== 'string' || doc.context.trim() === '')) {
    throw new RoleSchemaError('context 必须是非空字符串', source)
  }
  const context = doc.context as string | undefined
  const scenarios = validateScenarios(doc.scenarios, source, 'scenarios') ?? []
  const verification = validateVerificationRules(doc.verification, source)
  const content = {
    roleId,
    ...(context === undefined ? {} : { context }),
    scenarios,
    ...(verification === undefined ? {} : { verification }),
  }
  return { ...content, hash: computeProjectLayerHash(content), source }
}

const VERIFICATION_TYPES = new Set(['output_structure', 'content_policy', 'artifact_exists'])

/** Same rule shape a role's `verification` uses; the verifier interprets `config`. */
function validateVerificationRules(value: unknown, source: string): VerificationRule[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new RoleSchemaError('verification 必须是列表', source)
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new RoleSchemaError(`verification[${index}] 必须是对象`, source)
    }
    const rule = entry as Record<string, unknown>
    if (typeof rule.type !== 'string' || !VERIFICATION_TYPES.has(rule.type)) {
      throw new RoleSchemaError(`verification[${index}].type 必须是 ${[...VERIFICATION_TYPES].join(' / ')} 之一`, source)
    }
    if (rule.config !== undefined && (typeof rule.config !== 'object' || rule.config === null || Array.isArray(rule.config))) {
      throw new RoleSchemaError(`verification[${index}].config 必须是对象`, source)
    }
    return rule as unknown as VerificationRule
  })
}

/** Read one project layer file. */
export async function loadProjectLayer(file: string): Promise<ProjectLayer> {
  let raw: unknown
  try {
    raw = parseYaml(await readFile(file, 'utf8'))
  } catch (error) {
    if (error instanceof RoleSchemaError) throw error
    throw new RoleSchemaError(`项目层文件读取或解析失败: ${String(error)}`, file)
  }
  return parseProjectLayerDocument(raw, file)
}

/**
 * Content hash of a project layer: what it adds (role id, context,
 * scenarios), not where it was read from — the same layer copied to another
 * checkout hashes the same.
 */
export function computeProjectLayerHash(layer: Pick<ProjectLayer, 'roleId' | 'context' | 'scenarios' | 'verification'>): string {
  const content = { roleId: layer.roleId, context: layer.context, scenarios: layer.scenarios, verification: layer.verification }
  return createHash('sha256').update(stableSerialize(content)).digest('hex')
}

/** The system prompt the agent actually gets: the role's, plus the project's context when there is one. */
export function composeSystemPrompt(role: RoleDefinition): string {
  const context = role.projectLayer?.context
  if (context === undefined) return role.systemPrompt
  return `${role.systemPrompt.trimEnd()}\n\n${PROJECT_CONTEXT_HEADING}\n\n${context.trim()}\n`
}

/** Where a scenario comes from. */
export type ScenarioSource = 'role' | 'project'

/** Every scenario available for a role: its own, then the project's; a project scenario replaces a role one of the same name. */
export function listScenarios(role: RoleDefinition): Array<RoleScenario & { source: ScenarioSource }> {
  const merged = new Map<string, RoleScenario & { source: ScenarioSource }>()
  for (const scenario of role.scenarios ?? []) merged.set(scenario.name, { ...scenario, source: 'role' })
  for (const scenario of role.projectLayer?.scenarios ?? []) merged.set(scenario.name, { ...scenario, source: 'project' })
  return [...merged.values()]
}

/** Raised when a caller selects a scenario the role and its project layer do not define. */
export class UnknownScenarioError extends Error {
  constructor(readonly roleId: string, readonly scenario: string, readonly available: string[]) {
    super(`Role "${roleId}" has no scenario "${scenario}"${available.length === 0 ? ' (it defines none)' : `; available: ${available.join(', ')}`}`)
    this.name = 'UnknownScenarioError'
  }
}

/** Find a scenario by name, or throw {@link UnknownScenarioError}. */
export function findScenario(role: RoleDefinition, name: string): RoleScenario & { source: ScenarioSource } {
  const all = listScenarios(role)
  const found = all.find((scenario) => scenario.name === name)
  if (found === undefined) throw new UnknownScenarioError(role.roleId, name, all.map((scenario) => scenario.name))
  return found
}

/**
 * The task text with the selected scenario's guidance in front of it. Only
 * the chosen scenario travels with the task; the others never enter the
 * agent's context.
 */
export function composeScenarioTask(scenario: RoleScenario & { source?: ScenarioSource }, task: string): string {
  const lines = [
    `[场景：${scenario.title ?? scenario.name}]${scenario.source === 'project' ? '（本项目）' : ''}`,
    `适用情况：${scenario.when.trim()}`,
    '',
    '做法：',
    scenario.guidance.trim(),
  ]
  if (scenario.doneWhen !== undefined) lines.push('', `完成标准：${scenario.doneWhen.trim()}`)
  lines.push('', '---', '', task)
  return lines.join('\n')
}
