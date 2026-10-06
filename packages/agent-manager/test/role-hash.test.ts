import { describe, expect, it } from 'vitest'

import type { DiscoveredWorkflowSkill, RoleDefinition } from '@dsh/spec'

import { computeRoleHash } from '../src/role/role-hash.js'
import { computeSkillSnapshot } from '../src/workflow-skill/skill-snapshot.js'

function role(overrides: Partial<RoleDefinition> = {}): RoleDefinition {
  return {
    roleId: 'builder',
    name: 'Builder',
    version: '1.0.0',
    description: 'builds things',
    systemPrompt: 'You build.',
    capabilities: ['code'],
    execution: { harness: 'codex', keepAliveAfterTask: false, chatTimeoutMs: 1000 },
    verification: [{ type: 'output_structure', config: { required_sections: ['## Done'] } }],
    raw: { b: 2, a: 1 },
    ...overrides,
  }
}

describe('computeRoleHash', () => {
  it('is a sha256 hex digest and is stable across calls', () => {
    const hash = computeRoleHash(role())
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    expect(computeRoleHash(role())).toBe(hash)
  })

  it('ignores key order but not content, at every nesting level', () => {
    const base = computeRoleHash(role())
    // Same content, different insertion order at the top level and inside raw.
    const reordered = computeRoleHash({
      raw: { a: 1, b: 2 },
      verification: role().verification,
      execution: { chatTimeoutMs: 1000, keepAliveAfterTask: false, harness: 'codex' },
      capabilities: ['code'],
      systemPrompt: 'You build.',
      description: 'builds things',
      version: '1.0.0',
      name: 'Builder',
      roleId: 'builder',
    })
    expect(reordered).toBe(base)

    expect(computeRoleHash(role({ systemPrompt: 'You build carefully.' }))).not.toBe(base)
    expect(computeRoleHash(role({ verification: [] }))).not.toBe(base)
    expect(computeRoleHash(role({ execution: { ...role().execution, harness: 'claude-code' } }))).not.toBe(base)
    expect(computeRoleHash(role({ raw: { a: 1, b: 3 } }))).not.toBe(base)
  })

  it('changes when only the declared version changes — the version string is content, not identity', () => {
    // A role author bumping metadata.version without touching anything else
    // still produces a new hash; and *not* bumping it after a real edit still
    // produces a new hash (previous test). The hash is what identifies a run's
    // role, the version is a label riding along with it.
    expect(computeRoleHash(role({ version: '1.0.1' }))).not.toBe(computeRoleHash(role()))
  })

  it('agrees with computeSkillSnapshot().roleHashes for the same role', () => {
    // This is the whole point of sharing one function: a guided-mode spawn
    // (which writes computeRoleHash into agent.spawned) and a governed-pipeline
    // snapshot must give the same role content the same id, or a comparison
    // across the two paths silently compares unrelated runs.
    const builder = role()
    const reviewer = role({ roleId: 'reviewer', name: 'Reviewer', systemPrompt: 'You review.' })
    const discovered: DiscoveredWorkflowSkill = {
      workflowId: 'feature-delivery',
      name: 'Feature Delivery',
      description: 'Implement and verify a feature.',
      disableModelInvocation: false,
      version: '1.2.3',
      rawManifest: { 'dsh.kind': 'workflow', 'dsh.workflowId': 'feature-delivery' },
      packPath: '/tmp/feature-delivery',
      rawWorkflow: { kind: 'Workflow' },
    }
    const snapshot = computeSkillSnapshot({
      discovered,
      roleResolutions: [
        { roleId: 'builder', role: builder, source: 'local', shadowsGlobal: false },
        { roleId: 'reviewer', role: reviewer, source: 'global', shadowsGlobal: false },
      ],
      source: 'project',
    })
    expect(snapshot.roleHashes).toEqual({
      builder: computeRoleHash(builder),
      reviewer: computeRoleHash(reviewer),
    })
  })
})
