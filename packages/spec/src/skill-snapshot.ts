/** A content snapshot of a discovered workflow Skill Pack and its roles. */
export interface SkillSnapshot {
  name: string
  version?: string
  skillHash: string
  manifestHash: string
  workflowHash?: string
  roleHashes: Record<string, string>
  source: 'project' | 'user' | 'bundled' | 'remote'
}
