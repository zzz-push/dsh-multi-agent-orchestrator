/**
 * Extract the role ids referenced by workflow steps.
 *
 * This is intentionally a best-effort helper. Structural validation remains the
 * responsibility of `WorkflowCompiler`; malformed workflow values simply yield
 * no ids that can be pre-resolved.
 */
export function extractStepRoleIds(rawWorkflow: unknown): string[] {
  if (!isRecord(rawWorkflow) || !isRecord(rawWorkflow.spec)) return []
  const steps = rawWorkflow.spec.steps
  if (!Array.isArray(steps)) return []

  const roleIds: string[] = []
  const seen = new Set<string>()
  for (const step of steps) {
    if (!isRecord(step) || typeof step.role !== 'string' || seen.has(step.role)) continue
    seen.add(step.role)
    roleIds.push(step.role)
  }
  return roleIds
}

/** A workflow step and the role id it references. */
export interface StepRoleAssignment {
  stepId: string
  roleId: string
}

/**
 * Extract step-to-role references without deduplicating role ids.
 *
 * This is intentionally a best-effort helper, just like
 * `extractStepRoleIds`: malformed workflow values produce no assignments and
 * never cause an exception.
 */
export function extractStepRoleAssignments(rawWorkflow: unknown): StepRoleAssignment[] {
  if (!isRecord(rawWorkflow) || !isRecord(rawWorkflow.spec)) return []
  const steps = rawWorkflow.spec.steps
  if (!Array.isArray(steps)) return []

  const assignments: StepRoleAssignment[] = []
  for (const step of steps) {
    if (
      !isRecord(step)
      || typeof step.id !== 'string'
      || typeof step.role !== 'string'
    ) continue
    assignments.push({ stepId: step.id, roleId: step.role })
  }
  return assignments
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
