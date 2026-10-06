import { FileRoleProvider } from '../role/file-provider.js'
import type { RoleDefinition, RoleProvider } from '../role/types.js'

/** Details of a successfully resolved workflow role. */
export interface RoleResolution {
  /** Role id requested by the workflow. */
  roleId: string
  /** Fully validated role definition selected for the workflow. */
  role: RoleDefinition
  /** Whether the selected definition came from the Pack or the global library. */
  source: 'local' | 'global'
  /** Whether a global definition with the same id was hidden by the local one. */
  shadowsGlobal: boolean
}

/** Details of a role reference that could not be resolved. */
export interface RoleResolutionFailure {
  /** Role id requested by the workflow. */
  roleId: string
  /** Human-readable explanation suitable for compiler-facing diagnostics. */
  reason: string
}

/** Inputs required to resolve all role references in one workflow Pack. */
export interface ResolveWorkflowRolesOptions {
  /** `DiscoveredWorkflowSkill.localRolesDir`, when the Pack has local roles. */
  localRolesDir?: string
  /** Role ids referenced by the workflow steps. */
  requiredRoleIds: readonly string[]
  /** Global role source, such as a FileRoleProvider over `.dsh/roles/`. */
  globalRoles: RoleProvider
}

/** Resolved role map plus per-reference diagnostics. */
export interface ResolveWorkflowRolesResult {
  /** Map ready to pass to `WorkflowCompiler.compile()`. */
  roles: Map<string, RoleDefinition>
  /** Successful resolutions in required-role order. */
  resolutions: RoleResolution[]
  /** Unresolved references in required-role order. */
  failures: RoleResolutionFailure[]
}

/**
 * Resolve workflow role references with fixed local-first precedence.
 *
 * Local role files are parsed by FileRoleProvider so they have exactly the same
 * schema and role-id semantics as the global role source. Missing roles are
 * collected as failures; provider and schema errors are intentionally allowed
 * to propagate unchanged.
 */
export async function resolveWorkflowRoles(
  options: ResolveWorkflowRolesOptions,
): Promise<ResolveWorkflowRolesResult> {
  const roles = new Map<string, RoleDefinition>()
  const resolutions: RoleResolution[] = []
  const failures: RoleResolutionFailure[] = []
  const localRoles = options.localRolesDir
    ? new FileRoleProvider({ rolesDir: options.localRolesDir })
    : undefined

  for (const roleId of options.requiredRoleIds) {
    const localRole = localRoles ? await localRoles.get(roleId) : undefined
    if (localRole !== undefined) {
      const globalRole = await options.globalRoles.get(roleId)
      roles.set(roleId, localRole)
      resolutions.push({
        roleId,
        role: localRole,
        source: 'local',
        shadowsGlobal: globalRole !== undefined,
      })
      continue
    }

    const globalRole = await options.globalRoles.get(roleId)
    if (globalRole !== undefined) {
      roles.set(roleId, globalRole)
      resolutions.push({
        roleId,
        role: globalRole,
        source: 'global',
        shadowsGlobal: false,
      })
      continue
    }

    failures.push({
      roleId,
      reason: `角色 "${roleId}" 在本地和全局角色库中均未找到`,
    })
  }

  return { roles, resolutions, failures }
}
