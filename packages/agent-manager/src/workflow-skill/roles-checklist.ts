import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { StepRoleAssignment } from './extract-role-ids.js'
import type {
  ResolveWorkflowRolesResult,
  RoleResolution,
  RoleResolutionFailure,
} from './role-resolver.js'

const GENERATED_BANNER = '<!-- 自动生成，请勿手改！ -->'

/**
 * Render the role references and their resolution status as Markdown.
 *
 * The checklist is derived only from the supplied assignments and resolution
 * result. It deliberately remains useful when some roles are unresolved.
 */
export function formatRolesChecklist(
  assignments: readonly StepRoleAssignment[],
  resolution: ResolveWorkflowRolesResult,
): string {
  const stepsByRole = new Map<string, string[]>()
  for (const assignment of assignments) {
    const steps = stepsByRole.get(assignment.roleId) ?? []
    if (!steps.includes(assignment.stepId)) steps.push(assignment.stepId)
    stepsByRole.set(assignment.roleId, steps)
  }

  const resolutionsByRole = new Map(resolution.resolutions.map((item) => [item.roleId, item]))
  const failuresByRole = new Map(resolution.failures.map((item) => [item.roleId, item]))
  const roleIds = orderedRoleIds(assignments, resolution.resolutions, resolution.failures)

  const lines = [
    GENERATED_BANNER,
    '',
    '# 角色解析清单',
    '',
  ]

  if (roleIds.length === 0) {
    lines.push('无角色引用。', '')
    return lines.join('\n')
  }

  lines.push(
    '| 角色 ID | 解析来源 | 命中的 step | 备注 |',
    '| --- | --- | --- | --- |',
  )

  for (const roleId of roleIds) {
    const resolved = resolutionsByRole.get(roleId)
    const failure = failuresByRole.get(roleId)
    lines.push(formatRoleRow(roleId, stepsByRole.get(roleId) ?? [], resolved, failure))
  }
  lines.push('')
  return lines.join('\n')
}

/** Write a freshly rendered checklist, replacing any previous contents. */
export async function writeRolesChecklist(
  packPath: string,
  assignments: readonly StepRoleAssignment[],
  resolution: ResolveWorkflowRolesResult,
): Promise<string> {
  const generatedDirectory = path.join(packPath, 'dsh', 'generated')
  const checklistPath = path.join(generatedDirectory, 'roles.md')
  await mkdir(generatedDirectory, { recursive: true })
  await writeFile(checklistPath, formatRolesChecklist(assignments, resolution), 'utf8')
  return checklistPath
}

function orderedRoleIds(
  assignments: readonly StepRoleAssignment[],
  resolutions: readonly RoleResolution[],
  failures: readonly RoleResolutionFailure[],
): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const roleId of [
    ...assignments.map((assignment) => assignment.roleId),
    ...resolutions.map((item) => item.roleId),
    ...failures.map((item) => item.roleId),
  ]) {
    if (seen.has(roleId)) continue
    seen.add(roleId)
    ids.push(roleId)
  }
  return ids
}

function formatRoleRow(
  roleId: string,
  stepIds: readonly string[],
  resolved: RoleResolution | undefined,
  failure: RoleResolutionFailure | undefined,
): string {
  let source = '未解析'
  let note = failure?.reason ?? '未解析'
  if (resolved !== undefined) {
    source = resolved.source === 'local' ? '本地 (dsh/roles/)' : '全局角色库'
    note = resolved.shadowsGlobal ? `遮蔽了同名全局角色 ${roleId}` : ''
  }

  return `| ${markdownCell(roleId)} | ${markdownCell(source)} | ${markdownCell(stepIds.length > 0 ? stepIds.join(', ') : '（无）')} | ${markdownCell(note)} |`
}

function markdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ')
}
