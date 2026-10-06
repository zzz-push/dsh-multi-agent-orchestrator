import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { OutputVerifier, VerificationError } from '../../src/verification/verifier.js'
import type { Checker, VerificationContext } from '../../src/verification/types.js'

const context = (output: string, cwd = '/tmp'): VerificationContext => ({
  output,
  cwd,
  roleId: 'test-role',
})
const codeFence = String.fromCharCode(96).repeat(3)

describe('OutputVerifier', () => {
  describe('output_structure', () => {
    it('detects missing Markdown sections', async () => {
      const verifier = new OutputVerifier()
      const [result] = await verifier.verify(
        context('# 标题\n\n## 背景与目标\n\n正文'),
        [{
          type: 'output_structure',
          config: {
            format: 'markdown',
            required_sections: ['背景与目标', '接口定义', '实施建议'],
          },
        }],
      )

      expect(result?.passed).toBe(false)
      expect(result?.message).toContain('接口定义')
      expect(result?.message).toContain('实施建议')
      expect(result?.details?.missingSections).toEqual(['接口定义', '实施建议'])
    })

    it('accepts all required standard headings', async () => {
      const verifier = new OutputVerifier()
      const [result] = await verifier.verify(
        context('## 背景与目标\n## 方案设计\n## 接口定义\n## 实施建议'),
        [{
          type: 'output_structure',
          config: { required_sections: ['背景与目标', '方案设计', '接口定义', '实施建议'] },
        }],
      )

      expect(result?.passed).toBe(true)
    })

    it('accepts headings without a separating space and bracket headings', async () => {
      const verifier = new OutputVerifier()
      const [result] = await verifier.verify(
        context('##背景与目标\n【接口定义】'),
        [{
          type: 'output_structure',
          config: { required_sections: ['背景与目标', '接口定义'] },
        }],
      )

      expect(result?.passed).toBe(true)
    })

    it('treats unsupported formats as an explicit no-op', async () => {
      const verifier = new OutputVerifier()
      const [result] = await verifier.verify(
        context('not a Markdown document'),
        [{ type: 'output_structure', config: { format: 'json', required_sections: ['Missing'] } }],
      )

      expect(result?.passed).toBe(true)
      expect(result?.message).toContain('暂未实现')
    })

    it('passes when no sections are declared', async () => {
      const verifier = new OutputVerifier()
      const [result] = await verifier.verify(
        context('any output'),
        [{ type: 'output_structure', config: {} }],
      )

      expect(result?.passed).toBe(true)
      expect(result?.message).toContain('没有必需章节')
    })

    it('passes when required_sections is declared but empty', async () => {
      const verifier = new OutputVerifier()
      const [result] = await verifier.verify(
        context('any output'),
        [{ type: 'output_structure', config: { required_sections: [] } }],
      )

      expect(result?.passed).toBe(true)
      expect(result?.message).toContain('没有必需章节')
    })

    it('fails when required_sections is not an array', async () => {
      const verifier = new OutputVerifier()
      const [result] = await verifier.verify(
        context('any output'),
        [{ type: 'output_structure', config: { required_sections: 'not-an-array' } }],
      )

      expect(result?.passed).toBe(false)
      expect(result?.message).toContain('必须是字符串数组')
    })

    it('fails when required_sections contains a non-string entry', async () => {
      const verifier = new OutputVerifier()
      const [result] = await verifier.verify(
        context('## Valid'),
        [{ type: 'output_structure', config: { required_sections: ['Valid', 123] } }],
      )

      expect(result?.passed).toBe(false)
      expect(result?.message).toContain('必须是字符串数组')
    })
  })

  describe('content_policy', () => {
    it('rejects a denied pattern', async () => {
      const verifier = new OutputVerifier()
      const [result] = await verifier.verify(
        context('说明\nfunction implementFeature() {}'),
        [{
          type: 'content_policy',
          config: {
            deny_patterns: [{ regex: '^function\\s+\\w+', message: '不应包含函数实现' }],
          },
        }],
      )

      expect(result?.passed).toBe(false)
      expect(result?.message).toContain('不应包含函数实现')
      expect(result?.details).toEqual({ violatedPattern: '^function\\s+\\w+' })
    })

    it('rejects when a required pattern is absent', async () => {
      const verifier = new OutputVerifier()
      const [result] = await verifier.verify(
        context('这是一个没有代码块的文档。'),
        [{
          type: 'content_policy',
          config: {
            require_patterns: [{ regex: codeFence + 'typescript', message: '必须包含 TypeScript 代码块' }],
          },
        }],
      )

      expect(result?.passed).toBe(false)
      expect(result?.message).toContain('必须包含 TypeScript 代码块')
      expect(result?.details).toEqual({ missingPattern: codeFence + 'typescript' })
    })

    it('passes when all deny and require patterns are satisfied', async () => {
      const verifier = new OutputVerifier()
      const [result] = await verifier.verify(
        context('架构文档\n' + codeFence + 'typescript\ninterface User {}\n' + codeFence),
        [{
          type: 'content_policy',
          config: {
            deny_patterns: [{ regex: '^function ', message: '不要有函数实现' }],
            require_patterns: [
              { regex: codeFence + 'typescript', message: '必须有 TS 代码' },
              { regex: 'interface', message: '必须有接口定义' },
            ],
          },
        }],
      )

      expect(result?.passed).toBe(true)
      expect(result?.message).toContain('3 个')
    })

    it('reports malformed regular expressions as failed checks', async () => {
      const verifier = new OutputVerifier()
      const [result] = await verifier.verify(
        context('output'),
        [{
          type: 'content_policy',
          config: { deny_patterns: [{ regex: '[', message: 'invalid' }] },
        }],
      )

      expect(result?.passed).toBe(false)
      expect(result?.message).toContain('正则无效')
    })

    it('rejects a non-array require_patterns declaration', async () => {
      const verifier = new OutputVerifier()
      const [result] = await verifier.verify(
        context('output'),
        [{ type: 'content_policy', config: { require_patterns: 'not-an-array' } }],
      )

      expect(result?.passed).toBe(false)
      expect(result?.message).toContain('require_patterns 必须是数组')
    })

    it('reports a malformed regular expression inside require_patterns', async () => {
      const verifier = new OutputVerifier()
      const [result] = await verifier.verify(
        context('output'),
        [{
          type: 'content_policy',
          config: { require_patterns: [{ regex: '[', message: 'invalid' }] },
        }],
      )

      expect(result?.passed).toBe(false)
      expect(result?.message).toContain('正则无效')
    })

    it('rejects a pattern entry missing regex/message strings', async () => {
      const verifier = new OutputVerifier()
      const [result] = await verifier.verify(
        context('output'),
        [{
          type: 'content_policy',
          config: { deny_patterns: [{ regex: 123, message: 'x' }] },
        }],
      )

      expect(result?.passed).toBe(false)
      expect(result?.message).toContain('必须包含字符串 regex 和 message')
    })
  })

  describe('artifact_exists', () => {
    it('detects a missing artifact', async () => {
      const verifier = new OutputVerifier()
      const [result] = await verifier.verify(
        context('output', '/tmp'),
        [{ type: 'artifact_exists', config: { files: ['non-existent-file.md'] } }],
      )

      expect(result?.passed).toBe(false)
      expect(result?.message).toContain('non-existent-file.md')
      expect(result?.details?.missingFiles).toEqual(['non-existent-file.md'])
    })

    it('accepts artifacts present in the workspace', async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'dsh-verifier-'))
      try {
        await mkdir(path.join(directory, 'docs'))
        await writeFile(path.join(directory, 'docs', 'technical.md'), '# Design')
        const verifier = new OutputVerifier()
        const [result] = await verifier.verify(
          context('output', directory),
          [{ type: 'artifact_exists', config: { files: ['docs/technical.md'] } }],
        )

        expect(result?.passed).toBe(true)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })

    it('rejects parent traversal outside the workspace', async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'dsh-verifier-'))
      try {
        const verifier = new OutputVerifier()
        const [result] = await verifier.verify(
          context('output', directory),
          [{ type: 'artifact_exists', config: { files: ['../outside.txt'] } }],
        )

        expect(result?.passed).toBe(false)
        expect(result?.details?.unsafeFiles).toEqual(['../outside.txt'])
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })

    it('treats every declared file as missing when the workspace root itself does not exist', async () => {
      const verifier = new OutputVerifier()
      const [result] = await verifier.verify(
        context('output', path.join(tmpdir(), 'dsh-verifier-nonexistent-root')),
        [{ type: 'artifact_exists', config: { files: ['whatever.md'] } }],
      )

      expect(result?.passed).toBe(false)
      expect(result?.details?.missingFiles).toEqual(['whatever.md'])
    })

    it('rejects a non-array files declaration', async () => {
      const verifier = new OutputVerifier()
      const [result] = await verifier.verify(
        context('output', '/tmp'),
        [{ type: 'artifact_exists', config: { files: 'not-an-array' } }],
      )

      expect(result?.passed).toBe(false)
      expect(result?.message).toContain('files 必须是字符串数组')
    })

    it('rejects a files array containing a non-string entry', async () => {
      const verifier = new OutputVerifier()
      const [result] = await verifier.verify(
        context('output', '/tmp'),
        [{ type: 'artifact_exists', config: { files: ['ok.md', 123] } }],
      )

      expect(result?.passed).toBe(false)
      expect(result?.message).toContain('files 必须是字符串数组')
    })

    it('passes when no files are declared at all', async () => {
      const verifier = new OutputVerifier()
      const [result] = await verifier.verify(
        context('output', '/tmp'),
        [{ type: 'artifact_exists', config: {} }],
      )

      expect(result?.passed).toBe(true)
    })

    it('passes when files is declared as an empty array', async () => {
      const verifier = new OutputVerifier()
      const [result] = await verifier.verify(
        context('output', '/tmp'),
        [{ type: 'artifact_exists', config: { files: [] } }],
      )

      expect(result?.passed).toBe(true)
    })
  })

  describe('engine behavior', () => {
    it('reports unknown rule types without stopping other checks', async () => {
      const verifier = new OutputVerifier()
      const results = await verifier.verify(context('## Present'), [
        { type: 'unknown_rule' as never, config: {} },
        { type: 'output_structure', config: { required_sections: ['Present'] } },
      ])

      expect(results).toHaveLength(2)
      expect(results[0]?.passed).toBe(false)
      expect(results[0]?.message).toContain('未知的验证类型')
      expect(results[1]?.passed).toBe(true)
    })

    it('reports a checker that throws synchronously as a failed result, without stopping other checks', async () => {
      const throwingChecker: Checker = {
        type: 'exploding',
        async check() {
          throw new Error('boom')
        },
      }
      const verifier = new OutputVerifier([throwingChecker])
      const results = await verifier.verify(context('## Present'), [
        { type: 'exploding' as never, config: {} },
        { type: 'output_structure', config: { required_sections: ['Present'] } },
      ])

      expect(results).toHaveLength(2)
      expect(results[0]?.passed).toBe(false)
      expect(results[0]?.message).toContain('检查器执行失败')
      expect(results[0]?.message).toContain('boom')
      expect(results[1]?.passed).toBe(true)
    })

    it('normalizes a rule with no declared type to "unknown" instead of throwing', async () => {
      const verifier = new OutputVerifier()
      const [result] = await verifier.verify(context('output'), [{} as never])

      expect(result?.passed).toBe(false)
      expect(result?.rule.type).toBe('unknown')
      expect(result?.message).toContain('未知的验证类型')
    })

    it('supports custom checkers and replacement by type', async () => {
      const checker: Checker = {
        type: 'custom',
        async check(checkContext, config) {
          return {
            rule: { type: 'output_structure', config },
            passed: checkContext.roleId === 'test-role',
            message: 'custom check',
          }
        },
      }
      const verifier = new OutputVerifier([checker])
      const [result] = await verifier.verify(context('output'), [{ type: 'custom' as never }])

      expect(result?.passed).toBe(true)
      expect(result?.message).toBe('custom check')
    })

    it('throws VerificationError with all results from verifyOrThrow', async () => {
      const verifier = new OutputVerifier()
      await expect(verifier.verifyOrThrow(
        context('output'),
        [{ type: 'content_policy', config: { require_patterns: [{ regex: 'missing', message: 'required' }] } }],
      )).rejects.toMatchObject({
        name: 'VerificationError',
        results: [{ passed: false }],
      })

      try {
        await verifier.verifyOrThrow(context('output'), [
          { type: 'content_policy', config: { require_patterns: [{ regex: 'missing', message: 'required' }] } },
        ])
      } catch (error) {
        expect(error).toBeInstanceOf(VerificationError)
        expect((error as VerificationError).message).toContain('1/1')
      }
    })

    it('formats mixed results for operators', () => {
      const verifier = new OutputVerifier()
      const report = verifier.formatReport([
        { rule: { type: 'output_structure', config: {} }, passed: true, message: '所有章节存在' },
        { rule: { type: 'content_policy', config: {} }, passed: false, message: '包含禁止的模式' },
      ])

      expect(report).toContain('1/2 通过')
      expect(report).toContain('❌')
      expect(report).toContain('✅')
      expect(report).toContain('content_policy')
    })
  })
})
