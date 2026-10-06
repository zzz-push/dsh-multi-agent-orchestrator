/** Supported declarative output verification rule types. */
export type VerificationRuleType =
  | 'output_structure'
  | 'content_policy'
  | 'artifact_exists'

/** A verification rule declared by a role. */
export interface VerificationRule {
  type: VerificationRuleType
  config?: Record<string, unknown>
}

/** Result returned by one checker. */
export interface VerificationResult {
  rule: VerificationRule
  passed: boolean
  message?: string
  details?: Record<string, unknown>
}

/** Inputs available to every checker. */
export interface VerificationContext {
  /** Agent's textual output. */
  output: string
  /** Working directory used for artifact checks. */
  cwd: string
  /** Role identifier, useful to custom checkers and diagnostics. */
  roleId: string
}

/** An implementation for one verification rule type. */
export interface Checker {
  readonly type: string
  check(
    context: VerificationContext,
    config: Record<string, unknown>,
  ): Promise<VerificationResult>
}
