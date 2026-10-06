import { createHash } from 'node:crypto'

import { stableSerialize } from '@dsh/core'
import type { DiscoveredWorkflowSkill, SkillSnapshot } from '@dsh/spec'

import { computeRoleHash } from '../role/role-hash.js'
import type { RoleResolution } from './role-resolver.js'

/** Inputs required to compute a content snapshot for one discovered workflow Pack. */
export interface ComputeSkillSnapshotOptions {
  discovered: DiscoveredWorkflowSkill
  /** Hash returned by a successful WorkflowCompiler.compile() call, when available. */
  workflowHash?: string
  /** Successful role resolutions returned by resolveWorkflowRoles(). */
  roleResolutions: readonly RoleResolution[]
  source: SkillSnapshot['source']
}

/** Compute deterministic SHA-256 hashes for the Skill, manifest, and resolved roles. */
export function computeSkillSnapshot(options: ComputeSkillSnapshotOptions): SkillSnapshot {
  const { discovered } = options
  const skillHash = sha256(stableSerialize({
    name: discovered.name,
    description: discovered.description,
    disableModelInvocation: discovered.disableModelInvocation,
  }))
  const manifestHash = sha256(stableSerialize(discovered.rawManifest))
  const roleHashes: Record<string, string> = {}
  for (const resolution of options.roleResolutions) {
    roleHashes[resolution.roleId] = computeRoleHash(resolution.role)
  }

  return {
    name: discovered.name,
    version: discovered.version,
    skillHash,
    manifestHash,
    workflowHash: options.workflowHash,
    roleHashes,
    source: options.source,
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
