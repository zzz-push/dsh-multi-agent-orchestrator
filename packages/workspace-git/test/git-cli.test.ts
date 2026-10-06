import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { GitCli } from '../src/git-cli.js'
import { GitCommandError } from '../src/errors.js'
import {
  createTempGitRepo,
  cleanupTempRepo,
} from './fixtures/test-repo.js'

describe('GitCli', () => {
  let cli: GitCli
  let testRepo: string

  beforeEach(async () => {
    cli = new GitCli({ gitPath: 'git', timeoutMs: 5000 })
    testRepo = await createTempGitRepo()
  })

  afterEach(async () => {
    await cleanupTempRepo(testRepo)
  })

  describe('exec', () => {
    it('executes Git command with parameter array', async () => {
      const result = await cli.exec(['rev-parse', 'HEAD'], testRepo)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toMatch(/^[0-9a-f]{40}/)
      expect(result.stderr).toBe('')
    })

    it('throws GitCommandError on non-zero exit code', async () => {
      await expect(
        cli.exec(['rev-parse', 'nonexistent-ref'], testRepo),
      ).rejects.toThrow(GitCommandError)
    })

    it('includes command details in error', async () => {
      try {
        await cli.exec(['rev-parse', 'nonexistent-ref'], testRepo)
        expect.fail('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(GitCommandError)
        const error = err as GitCommandError
        expect(error.details).toMatchObject({
          command: ['rev-parse', 'nonexistent-ref'],
          exitCode: 128,
        })
        expect((error.details as any).stderr).toContain('unknown revision')
      }
    })

    it('reports git messages in English whatever the caller locale is', async () => {
      // LANG alone would translate git's messages on a machine that has the
      // translations installed; LC_ALL=C set by GitCli takes precedence.
      const error = await cli.exec(['rev-parse', 'nonexistent-ref'], testRepo, { env: { LANG: 'zh_CN.UTF-8' } })
        .then(() => undefined, (err: unknown) => err as GitCommandError)
      expect((error?.details as { stderr?: string } | undefined)?.stderr).toContain('unknown revision')
    })

    it('times out long-running commands', async () => {
      // `gitPath` is just the binary GitCli spawns; pointing it at `sleep`
      // gives a real, reliably-hanging process without depending on any
      // git-specific way to make git itself block.
      const slowCli = new GitCli({ gitPath: 'sleep', timeoutMs: 100 })

      await expect(slowCli.exec(['5'])).rejects.toMatchObject({
        message: 'Git command timeout',
        details: { command: ['5'], timeoutMs: 100 },
      })
    })

    it('uses shell: false to prevent injection', async () => {
      // Attempt command injection - should fail safely
      const maliciousArg = 'HEAD; echo injected'

      // This should fail because the entire string is treated as one argument
      await expect(
        cli.exec(['rev-parse', maliciousArg], testRepo),
      ).rejects.toThrow(GitCommandError)
    })
  })

  describe('execLine', () => {
    it('returns trimmed stdout for single-line commands', async () => {
      const result = await cli.execLine(['rev-parse', 'HEAD'], testRepo)

      expect(result).toMatch(/^[0-9a-f]{40}$/)
      expect(result).not.toContain('\n')
    })

    it('throws on command failure', async () => {
      await expect(
        cli.execLine(['rev-parse', 'invalid-ref'], testRepo),
      ).rejects.toThrow(GitCommandError)
    })
  })
})
