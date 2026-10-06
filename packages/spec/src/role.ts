/** Harness name requested by a role definition. */
export type RoleHarness = 'claude-code' | 'codex' | (string & {})

/** Execution environment requested by a role. */
export interface RoleExecution {
  /** Harness adapter that should execute the role. */
  harness: string
  /** Whether the harness process should remain available after a task turn. */
  keepAliveAfterTask: boolean
  /** Default chat timeout in milliseconds. */
  chatTimeoutMs: number
  /** Whether execution is background-only or may use an interactive window. */
  interactionMode?: 'headless' | 'interactive'
  /** Whether an interactive execution should show its window. */
  showWindow?: boolean
  /** Tool request interpreted by the runtime policy layer. */
  tools?: unknown
  /** Sandbox request interpreted by the runtime policy layer. */
  sandbox?: unknown
}

/** Canonical on-disk structure for a versioned role document. */
export interface RoleDocument {
  api_version: string
  kind: 'Role'
  metadata: RoleMetadata
  system_prompt: string
  capabilities?: string[]
  execution: RoleExecution
  contract?: RoleContract
  verification?: VerificationRule[]
  collaboration?: RoleCollaboration
  /** Situations this role knows how to handle, each with its own guidance (see {@link RoleScenario}). */
  scenarios?: RoleScenarioDocument[]
}

/** On-disk form of one scenario (snake_case, like the rest of the document). */
export interface RoleScenarioDocument {
  name: string
  title?: string
  when: string
  guidance: string
  done_when?: string
}

/**
 * One situation a role handles, with guidance specific to it — "fix one
 * registered tech-debt item", "review a pull request" — so a single-role
 * scenario needs no separate workflow skill
 * (design rationale).
 *
 * Scenarios are selected per task, not loaded into every call: the chosen
 * one's guidance is put in front of that task only. A generic role carries
 * generic scenarios; a project adds its own through its project layer.
 */
export interface RoleScenario {
  /** Stable id used to select the scenario (`--scenario maintenance`). Lowercase, digits, `-`. */
  name: string
  /** Human title; defaults to `name`. */
  title?: string
  /** When this scenario applies — what a caller reads to decide whether to pick it. */
  when: string
  /** How to handle it. */
  guidance: string
  /** What "done" means here, if the scenario defines it. */
  doneWhen?: string
}

/**
 * The project's layer on top of one generic role: what this project adds
 * for it — project context the harness does not already load (CLAUDE.md /
 * AGENTS.md cover most of that), and project-specific scenarios.
 *
 * Kept apart from the role on purpose (a product decision: roles
 * are generic, projects add a layer). The role's content hash does not
 * include the layer, so the same role has the same hash in every project;
 * the layer has its own hash, recorded next to it.
 */
export interface ProjectLayer {
  /** Role this layer applies to. */
  roleId: string
  /** Appended to the role's system prompt under a "本项目补充说明" heading. */
  context?: string
  /** Project scenarios; one with the same name as a role scenario replaces it. */
  scenarios: RoleScenario[]
  /** Extra output checks for this project, run after the role's own on every reply. */
  verification?: VerificationRule[]
  /** Content hash of the layer (see `computeProjectLayerHash`). */
  hash: string
  /** Where the layer was loaded from (file path), for diagnostics. */
  source: string
}

/** Human-facing, versioned metadata of a role document. */
export interface RoleMetadata {
  role_id: string
  name: string
  version: string
  description: string
  annotations?: Record<string, string>
}

/** Declared input and output contract for a role. */
export interface RoleContract {
  input?: {
    type?: 'object' | 'string' | 'array'
    required?: string[]
    optional?: string[]
    schema?: string | object
  }
  output?: {
    format?: 'markdown' | 'json' | 'yaml'
    schema?: object
    required_sections?: string[]
    artifacts?: string[]
  }
}

/** Declarative rule used to verify role output. */
export interface VerificationRule {
  type: 'output_structure' | 'content_policy' | 'artifact_exists'
  config?: Record<string, unknown>
}

/** Optional guidance for downstream role collaboration and handoff data. */
export interface RoleCollaboration {
  typical_downstream?: string[]
  handoff?: {
    provides?: Array<{
      name: string
      description?: string
      source: string
    }>
  }
}

/** Fully resolved role definition consumed by orchestration components. */
export interface RoleDefinition {
  roleId: string
  name: string
  version: string
  description: string
  systemPrompt: string
  capabilities: string[]
  execution: RoleExecution
  raw: unknown
  contract?: RoleContract
  verification?: VerificationRule[]
  collaboration?: RoleCollaboration
  annotations?: Record<string, string>
  /** The role's own (generic) scenarios. */
  scenarios?: RoleScenario[]
  /**
   * The project layer attached by the provider, when the project has one for
   * this role. Not part of the role's content hash.
   */
  projectLayer?: ProjectLayer
}

/** Compact role view returned by a role provider. */
export interface RoleSummary {
  roleId: string
  name: string
  version: string
  harness: string
  keepAliveAfterTask: boolean
  /** Scenario names available for this role (its own and its project layer's), when there are any. */
  scenarios?: string[]
}

/**
 * Source of resolved role definitions.
 *
 * TODO: the default implementation (`FileRoleProvider` in
 * `@dsh/agent-manager`) is temporary — the architecture decision
 * (the public design) requires roles to ship as Role Pack Skills
 * loaded through `ctx.skills.get()`. This interface isolates the source so
 * a `SkillRoleProvider` can replace the default without touching callers.
 */
export interface RoleProvider {
  /** Resolve one role by id, or return `undefined` when it is unknown. */
  get(roleId: string): Promise<RoleDefinition | undefined>
  /** List all known roles as compact summaries. */
  list(): Promise<RoleSummary[]>
}
