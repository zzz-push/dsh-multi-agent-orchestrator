import { createHash } from 'node:crypto'

import { stableSerialize } from '@dsh/core'

import type { RoleDefinition } from './types.js'

/**
 * Content hash of one resolved role definition.
 *
 * This is the single definition of "which version of a role ran": the value
 * `AgentManager.spawn()` writes into `agent.spawned`, and the value
 * `computeSkillSnapshot()` puts into `SkillSnapshot.roleHashes`. Both paths
 * must go through this function — if guided-mode spawns and governed-pipeline
 * snapshots ever hashed a role differently, the same role content would get
 * two ids and any "did v2 beat v1" comparison across the two paths would
 * silently compare unrelated runs.
 *
 * Hashes the whole normalized `RoleDefinition` (including `raw`) through
 * `stableSerialize`, so key order in the source YAML does not matter but any
 * content change — prompt, contract, verification rules, execution policy —
 * does. `metadata.version` is deliberately *not* trusted on its own: a role
 * author can edit content without bumping it, and the hash is what catches
 * that.
 *
 * A project layer attached by the provider (`role.projectLayer`) is not part
 * of the hash — see the body.
 */
export function computeRoleHash(role: RoleDefinition): string {
  // The project layer is the project's, not the role's: leaving it out keeps
  // one role's hash identical in every project that uses it. The layer has a
  // hash of its own (`computeProjectLayerHash`), recorded alongside.
  const { projectLayer: _projectLayer, ...content } = role
  return createHash('sha256').update(stableSerialize(content)).digest('hex')
}
