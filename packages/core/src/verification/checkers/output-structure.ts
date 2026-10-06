import type { Checker, VerificationContext, VerificationResult } from '../types.js'

/** Configuration understood by the Markdown structure checker. */
export interface OutputStructureConfig {
  format?: 'markdown' | 'json' | 'yaml'
  required_sections?: string[]
}

/**
 * Checks that an output contains the sections declared by a role.
 *
 * Markdown is the only format for which structure checks are currently
 * implemented. Other declared formats are accepted and reported as a
 * deliberate no-op so that a role can opt into them before a parser exists.
 */
export class OutputStructureChecker implements Checker {
  readonly type: 'output_structure' = 'output_structure'

  async check(
    context: VerificationContext,
    config: Record<string, unknown>,
  ): Promise<VerificationResult> {
    const cfg = (config ?? {}) as unknown as OutputStructureConfig
    const rule = { type: this.type, config }

    if (cfg.format !== undefined && cfg.format !== 'markdown') {
      return {
        rule,
        passed: true,
        message: `格式 ${String(cfg.format)} 检查暂未实现`,
      }
    }

    const requiredSections = cfg.required_sections
    if (requiredSections === undefined) {
      return {
        rule,
        passed: true,
        message: '没有必需章节',
      }
    }

    // A malformed runtime configuration should result in a failed check,
    // rather than an exception that obscures which rule was invalid.
    if (!Array.isArray(requiredSections) || requiredSections.length === 0) {
      if (Array.isArray(requiredSections)) {
        return {
          rule,
          passed: true,
          message: '没有必需章节',
        }
      }
      return {
        rule,
        passed: false,
        message: 'required_sections 必须是字符串数组',
      }
    }
    if (requiredSections.some((section) => typeof section !== 'string')) {
      return {
        rule,
        passed: false,
        message: 'required_sections 必须是字符串数组',
      }
    }

    const missingSections = requiredSections.filter(
      (section) => !this.hasSectionInMarkdown(context.output, section),
    )

    if (missingSections.length > 0) {
      return {
        rule,
        passed: false,
        message: `缺少必需章节: ${missingSections.join(', ')}`,
        details: { missingSections },
      }
    }

    return {
      rule,
      passed: true,
      message: `所有 ${requiredSections.length} 个必需章节都存在`,
    }
  }

  /** Check common Markdown heading and Chinese bracket heading forms. */
  private hasSectionInMarkdown(content: string, section: string): boolean {
    const escapedSection = this.escapeRegex(section)
    const patterns = [
      // ## Section (allow trailing whitespace and a closing # sequence)
      new RegExp(`^#{1,6}\\s+${escapedSection}\\s*#*\\s*$`, 'm'),
      // ##Section (some generated Chinese Markdown omits the space)
      new RegExp(`^#{1,6}\\s*${escapedSection}\\s*#*\\s*$`, 'm'),
      // 【Section】
      new RegExp(`【${escapedSection}】`, 'm'),
    ]

    return patterns.some((pattern) => pattern.test(content))
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
}
