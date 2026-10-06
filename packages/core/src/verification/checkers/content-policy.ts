import type { Checker, VerificationContext, VerificationResult } from '../types.js'

/** Configuration for deny/require regular-expression checks. */
export interface ContentPolicyConfig {
  deny_patterns?: Array<{
    regex: string
    message: string
  }>
  require_patterns?: Array<{
    regex: string
    message: string
  }>
}

/** Checks output against role-declared regular-expression policies. */
export class ContentPolicyChecker implements Checker {
  readonly type: 'content_policy' = 'content_policy'

  async check(
    context: VerificationContext,
    config: Record<string, unknown>,
  ): Promise<VerificationResult> {
    const cfg = (config ?? {}) as unknown as ContentPolicyConfig
    const rule = { type: this.type, config }

    if (cfg.deny_patterns !== undefined && !Array.isArray(cfg.deny_patterns)) {
      return {
        rule,
        passed: false,
        message: 'deny_patterns 必须是数组',
      }
    }
    if (cfg.require_patterns !== undefined && !Array.isArray(cfg.require_patterns)) {
      return {
        rule,
        passed: false,
        message: 'require_patterns 必须是数组',
      }
    }

    for (const pattern of cfg.deny_patterns ?? []) {
      const parsed = this.compilePattern(pattern)
      if (!parsed.ok) {
        return { rule, passed: false, message: parsed.message, details: { invalidPattern: pattern?.regex } }
      }
      if (parsed.regex.test(context.output)) {
        return {
          rule,
          passed: false,
          message: pattern.message,
          details: { violatedPattern: pattern.regex },
        }
      }
    }

    for (const pattern of cfg.require_patterns ?? []) {
      const parsed = this.compilePattern(pattern)
      if (!parsed.ok) {
        return { rule, passed: false, message: parsed.message, details: { invalidPattern: pattern?.regex } }
      }
      if (!parsed.regex.test(context.output)) {
        return {
          rule,
          passed: false,
          message: pattern.message,
          details: { missingPattern: pattern.regex },
        }
      }
    }

    const checkCount = (cfg.deny_patterns?.length ?? 0) + (cfg.require_patterns?.length ?? 0)
    return {
      rule,
      passed: true,
      message: `通过 ${checkCount} 个内容策略检查`,
    }
  }

  private compilePattern(
    pattern: unknown,
  ): { ok: true; regex: RegExp } | { ok: false; message: string } {
    if (!isRecord(pattern) || typeof pattern.regex !== 'string' || typeof pattern.message !== 'string') {
      return { ok: false, message: '内容策略模式必须包含字符串 regex 和 message' }
    }

    try {
      // Multiline mode lets ^/$ policies apply to each Markdown line. Do not
      // use a global flag: a fresh, stateless test is expected for each rule.
      return { ok: true, regex: new RegExp(pattern.regex, 'm') }
    } catch (error) {
      return {
        ok: false,
        message: `内容策略正则无效: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
