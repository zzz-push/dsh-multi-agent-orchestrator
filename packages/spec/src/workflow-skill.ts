/** Compact metadata exposed while discovering workflow Skill Packs. */
export interface WorkflowSkillSummary {
  /** Stable workflow identifier declared by `dsh.workflowId`. */
  workflowId: string
  /** Human-facing Skill name declared by the `SKILL.md` frontmatter. */
  name: string
  /** Human-facing discovery description declared by `SKILL.md`. */
  description: string
  /** Whether a model is prohibited from invoking the workflow autonomously. */
  disableModelInvocation: boolean
  /** Optional Pack version declared by `dsh.version`. */
  version?: string
}

/** A workflow Skill Pack loaded from its on-disk representation. */
export interface DiscoveredWorkflowSkill extends WorkflowSkillSummary {
  /** Parsed dsh/pack.yaml content, kept for hashing and diagnostics. */
  rawManifest: Record<string, unknown>
  /** Absolute path to the Skill Pack root directory. */
  packPath: string
  /** Parsed, uncompiled entry document accepted by `WorkflowCompiler.compile()`. */
  rawWorkflow: unknown
  /** Absolute path to `dsh/roles/` when that local role directory exists. */
  localRolesDir?: string
}

/** Source used to discover and load workflow Skill Packs. */
export interface WorkflowSkillProvider {
  /** List valid workflow Packs as compact, human-facing summaries. */
  list(): Promise<WorkflowSkillSummary[]>
  /** Load one workflow Pack, or return `undefined` when it is not declared. */
  get(workflowId: string): Promise<DiscoveredWorkflowSkill | undefined>
}
