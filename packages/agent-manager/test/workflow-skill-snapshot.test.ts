import { describe, expect, it } from 'vitest'

import type { DiscoveredWorkflowSkill, RoleDefinition } from '@dsh/spec'

import {
  computeSkillSnapshot,
  type ComputeSkillSnapshotOptions,
} from '../src/workflow-skill/skill-snapshot.js'

describe('computeSkillSnapshot', () => {
  it('computes a complete snapshot with sha256 hashes', () => {
    const snapshot = computeSkillSnapshot(baseOptions())

    expect(snapshot).toMatchObject({
      name: 'Feature Delivery',
      version: '1.2.3',
      workflowHash: 'workflow-hash',
      source: 'project',
    })
    expect(snapshot.skillHash).toMatch(/^[a-f0-9]{64}$/)
    expect(snapshot.manifestHash).toMatch(/^[a-f0-9]{64}$/)
    expect(snapshot.roleHashes).toEqual({
      builder: expect.stringMatching(/^[a-f0-9]{64}$/),
      reviewer: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
  })

  it('is deterministic for repeated and differently ordered equivalent inputs', () => {
    const first = computeSkillSnapshot(baseOptions())
    const second = computeSkillSnapshot(baseOptions())
    const reordered = computeSkillSnapshot({
      ...baseOptions(),
      discovered: {
        ...baseOptions().discovered,
        rawManifest: {
          'dsh.workflowId': 'feature-delivery',
          'dsh.kind': 'workflow',
          'dsh.version': '1.2.3',
          'dsh.entry': 'dsh/workflow.yaml',
          'dsh.apiVersion': 'dsh.orchestrator/v1alpha1',
        },
      },
    })

    expect(second).toEqual(first)
    expect(reordered.manifestHash).toBe(first.manifestHash)
  })

  it('hashes Skill frontmatter independently from the manifest', () => {
    const base = computeSkillSnapshot(baseOptions())
    const changedDescription = computeSkillSnapshot({
      ...baseOptions(),
      discovered: { ...baseOptions().discovered, description: 'A different description.' },
    })

    expect(changedDescription.skillHash).not.toBe(base.skillHash)
    expect(changedDescription.manifestHash).toBe(base.manifestHash)
  })

  it('hashes the complete manifest independently from Skill frontmatter', () => {
    const base = computeSkillSnapshot(baseOptions())
    const changedManifest = computeSkillSnapshot({
      ...baseOptions(),
      discovered: {
        ...baseOptions().discovered,
        rawManifest: { ...baseOptions().discovered.rawManifest, 'dsh.version': '2.0.0' },
      },
    })

    expect(changedManifest.manifestHash).not.toBe(base.manifestHash)
    expect(changedManifest.skillHash).toBe(base.skillHash)
  })

  it('keys role hashes by role id and isolates role content changes', () => {
    const base = computeSkillSnapshot(baseOptions())
    const changedRole = computeSkillSnapshot({
      ...baseOptions(),
      roleResolutions: baseOptions().roleResolutions.map((resolution) => (
        resolution.roleId === 'builder'
          ? { ...resolution, role: { ...resolution.role, systemPrompt: 'Changed prompt.' } }
          : resolution
      )),
    })

    expect(changedRole.roleHashes.builder).not.toBe(base.roleHashes.builder)
    expect(changedRole.roleHashes.reviewer).toBe(base.roleHashes.reviewer)
  })

  it('returns an empty role hash object when no roles were resolved', () => {
    const snapshot = computeSkillSnapshot({ ...baseOptions(), roleResolutions: [] })

    expect(snapshot.roleHashes).toEqual({})
  })
})

function baseOptions(): ComputeSkillSnapshotOptions {
  return {
    discovered: {
      workflowId: 'feature-delivery',
      name: 'Feature Delivery',
      description: 'Implement and verify a feature.',
      disableModelInvocation: false,
      version: '1.2.3',
      rawManifest: {
        'dsh.kind': 'workflow',
        'dsh.apiVersion': 'dsh.orchestrator/v1alpha1',
        'dsh.entry': 'dsh/workflow.yaml',
        'dsh.workflowId': 'feature-delivery',
        'dsh.version': '1.2.3',
      },
      packPath: '/tmp/feature-delivery',
      rawWorkflow: { kind: 'Workflow' },
    },
    workflowHash: 'workflow-hash',
    roleResolutions: [
      resolution('builder', 'Build the feature.'),
      resolution('reviewer', 'Review the feature.'),
    ],
    source: 'project',
  }
}

function resolution(roleId: string, systemPrompt: string) {
  return {
    roleId,
    role: role(roleId, systemPrompt),
    source: 'global' as const,
    shadowsGlobal: false,
  }
}

function role(roleId: string, systemPrompt: string): RoleDefinition {
  return {
    roleId,
    name: roleId,
    version: '1.0.0',
    description: `${roleId} role`,
    systemPrompt,
    capabilities: [],
    execution: {
      harness: 'codex',
      keepAliveAfterTask: false,
      chatTimeoutMs: 60_000,
    },
    raw: {},
  }
}
