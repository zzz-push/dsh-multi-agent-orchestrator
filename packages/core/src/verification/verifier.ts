import type {
  Checker,
  VerificationContext,
  VerificationResult,
  VerificationRule,
} from './types.js'
import { ArtifactExistsChecker } from './checkers/artifact-exists.js'
import { ContentPolicyChecker } from './checkers/content-policy.js'
import { OutputStructureChecker } from './checkers/output-structure.js'

/** Raised by verifyOrThrow when one or more rules fail. */
export class VerificationError extends Error {
  constructor(
    message: string,
    public readonly results: VerificationResult[],
  ) {
    super(message)
    this.name = 'VerificationError'
  }
}

/** Runs role-declared output checks and collects every rule result. */
export class OutputVerifier {
  private readonly checkers = new Map<string, Checker>()

  constructor(checkers: Iterable<Checker> = []) {
    this.registerChecker(new OutputStructureChecker())
    this.registerChecker(new ContentPolicyChecker())
    this.registerChecker(new ArtifactExistsChecker())
    for (const checker of checkers) this.registerChecker(checker)
  }

  /** Register or replace a checker for its type. */
  registerChecker(checker: Checker): void {
    this.checkers.set(checker.type, checker)
  }

  /** Run all rules in declaration order; a failure does not short-circuit. */
  async verify(
    context: VerificationContext,
    rules: VerificationRule[],
  ): Promise<VerificationResult[]> {
    const results: VerificationResult[] = []

    for (const rule of rules ?? []) {
      const normalizedRule = this.normalizeRule(rule)
      const checker = this.checkers.get(normalizedRule.type)

      if (!checker) {
        results.push({
          rule: normalizedRule,
          passed: false,
          message: `未知的验证类型: ${normalizedRule.type}`,
        })
        continue
      }

      try {
        const config = isRecord(normalizedRule.config) ? normalizedRule.config : {}
        results.push(await checker.check(context, config))
      } catch (error) {
        results.push({
          rule: normalizedRule,
          passed: false,
          message: `检查器执行失败: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }

    return results
  }

  /** Run all checks and throw a rich error if any result failed. */
  async verifyOrThrow(
    context: VerificationContext,
    rules: VerificationRule[],
  ): Promise<void> {
    const results = await this.verify(context, rules)
    const failed = results.filter((result) => !result.passed)

    if (failed.length === 0) return

    const messages = failed.map((result) => `- ${result.message ?? result.rule.type}`).join('\n')
    throw new VerificationError(
      `验证失败 (${failed.length}/${results.length}):\n${messages}`,
      results,
    )
  }

  /** Format mixed verification results for logs and operator-facing output. */
  formatReport(results: VerificationResult[]): string {
    const passed = results.filter((result) => result.passed)
    const failed = results.filter((result) => !result.passed)
    const lines: string[] = []
    lines.push(`验证结果: ${passed.length}/${results.length} 通过\\n`)

    if (failed.length > 0) {
      lines.push('❌ 失败的检查:')
      for (const result of failed) {
        lines.push(`  - [${result.rule.type}] ${result.message ?? '未提供消息'}`)
      }
    }

    if (passed.length > 0) {
      lines.push('\\n✅ 通过的检查:')
      for (const result of passed) {
        lines.push(`  - [${result.rule.type}] ${result.message ?? '通过'}`)
      }
    }

    return lines.join('\n')
  }

  private normalizeRule(rule: VerificationRule): VerificationRule {
    if (isRecord(rule) && typeof rule.type === 'string') {
      // Keep the caller's rule object (including any diagnostic metadata) in
      // the result. The structural cast is intentional: runtime validation
      // above guarantees the fields needed by the engine.
      return rule as unknown as VerificationRule
    }
    return { type: 'unknown' as VerificationRule['type'] }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
