import type { RoleDefinition } from '@dsh/spec'
import type {
  ContractCheckResult,
  ContractError,
  ContractWarning,
  WorkflowStepDef,
} from './types.js'

/**
 * Checks whether role input contracts can be fulfilled: by upstream steps'
 * output contracts, or by what the step itself is given (workflow inputs,
 * its own instructions — see `WorkflowStepDef.provided`).
 */
export class ContractChecker {
  /**
   * Check every workflow step against the output contracts of its dependencies.
   *
   * The role map is keyed by workflow step id. This lets one role be used by
   * more than one step without losing the step identity in diagnostics.
   */
  checkWorkflow(
    steps: WorkflowStepDef[],
    roles: Map<string, RoleDefinition>,
  ): ContractCheckResult {
    const errors: ContractError[] = []
    const warnings: ContractWarning[] = []

    for (const step of steps) {
      const role = roles.get(step.id)
      if (!role) {
        errors.push({
          stepId: step.id,
          field: 'role',
          message: `找不到角色定义: ${step.roleId}`,
        })
        continue
      }

      const requiredFields = role.contract?.input?.required ?? []
      if (requiredFields.length === 0) {
        continue
      }

      for (const field of requiredFields) {
        if (step.provided?.includes(field) === true) continue
        if (!this.checkFieldProvided(field, step.dependsOn, roles)) {
          errors.push({
            stepId: step.id,
            field,
            message: `步骤 "${step.id}" 需要输入字段 "${field}"，但没有上游步骤能够提供`,
          })
        }
      }

      if (step.dependsOn.length === 0 && requiredFields.some((field) => step.provided?.includes(field) !== true)) {
        warnings.push({
          stepId: step.id,
          message: `步骤需要输入 ${requiredFields.join(', ')}，但没有声明依赖`,
        })
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    }
  }

  /** Check one upstream/downstream role pair for required input fields. */
  checkStepPair(
    upstream: RoleDefinition,
    downstream: RoleDefinition,
  ): ContractCheckResult {
    const errors: ContractError[] = []
    const warnings: ContractWarning[] = []
    const requiredFields = downstream.contract?.input?.required ?? []

    if (requiredFields.length === 0) {
      return { valid: true, errors, warnings }
    }

    const output = upstream.contract?.output
    const handoffFields = upstream.collaboration?.handoff?.provides
    if (!output && !handoffFields?.length) {
      warnings.push({
        stepId: downstream.roleId,
        message: `上游角色 "${upstream.roleId}" 没有定义输出契约，无法验证兼容性`,
      })
      return { valid: true, errors, warnings }
    }

    for (const field of requiredFields) {
      if (!this.canProvideField(upstream, field)) {
        errors.push({
          stepId: downstream.roleId,
          upstreamStepId: upstream.roleId,
          field,
          message: `下游需要 "${field}"，但上游角色 "${upstream.roleId}" 未提供`,
        })
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    }
  }

  /** Render a check result as a concise human-readable report. */
  formatReport(result: ContractCheckResult): string {
    const lines: string[] = []

    if (result.valid) {
      lines.push('✅ 所有步骤的契约检查通过')
    } else {
      lines.push(`❌ 契约检查失败，发现 ${result.errors.length} 个错误`)
    }

    if (result.errors.length > 0) {
      lines.push('\n错误:')
      for (const error of result.errors) {
        if (error.upstreamStepId) {
          lines.push(
            `  - [${error.stepId}] ${error.message} (字段: ${error.field}, 上游: ${error.upstreamStepId})`,
          )
        } else {
          lines.push(`  - [${error.stepId}] ${error.message} (字段: ${error.field})`)
        }
      }
    }

    if (result.warnings.length > 0) {
      lines.push('\n警告:')
      for (const warning of result.warnings) {
        lines.push(`  - [${warning.stepId}] ${warning.message}`)
      }
    }

    return lines.join('\n')
  }

  /** Return true when any dependency declares the requested output field. */
  private checkFieldProvided(
    field: string,
    upstreamStepIds: string[],
    roles: Map<string, RoleDefinition>,
  ): boolean {
    for (const upstreamId of upstreamStepIds) {
      const upstreamRole = roles.get(upstreamId)
      if (upstreamRole && this.canProvideField(upstreamRole, field)) {
        return true
      }
    }
    return false
  }

  /** Check output.schema.properties and handoff.provides declarations. */
  private canProvideField(role: RoleDefinition, field: string): boolean {
    const schema = role.contract?.output?.schema
    if (isRecord(schema) && isRecord(schema.properties) && field in schema.properties) {
      return true
    }

    return role.collaboration?.handoff?.provides?.some((provided) => provided.name === field) ?? false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
