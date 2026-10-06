import { spawn } from 'node:child_process'
import path from 'node:path'
import { GitCommandError } from './errors.js'

export interface GitCliOptions {
  gitPath: string
  timeoutMs: number
}

export interface GitCommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface GitExecOptions {
  /** Additional environment variables for Git (merged with process.env). */
  env?: NodeJS.ProcessEnv
  /** Optional stdin payload. Git still receives an argv array. */
  input?: string
}

/**
 * Git command-line interface wrapper.
 * All commands use parameter arrays (never shell string concatenation).
 */
export class GitCli {
  constructor(private readonly options: GitCliOptions) {}

  /**
   * Execute a Git command with parameter array.
   * @param args - Command arguments (e.g., ['rev-parse', 'HEAD'])
   * @param cwd - Working directory for the command
   * @throws {GitCommandError} When exitCode !== 0
   */
  async exec(
    args: string[],
    cwd?: string,
    execOptions: GitExecOptions = {},
  ): Promise<GitCommandResult> {
    return new Promise((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        callback()
      }

      const proc = spawn(this.options.gitPath, args, {
        cwd: cwd === undefined ? undefined : path.resolve(cwd),
        // LC_ALL=C: git's messages are part of its interface here — worktree-ops
        // matches stderr ("not a git repository", "does not exist") to treat a
        // missing worktree as already removed. Under a translated locale
        // (e.g. zh_CN.UTF-8) those messages come back localized, the matches
        // fail, and idempotent cleanup throws. Paths are bytes to git, so the
        // C locale does not affect non-ASCII file names. A caller can still
        // override it through execOptions.env.
        env: { ...process.env, LC_ALL: 'C', LANGUAGE: 'C', ...execOptions.env },
        stdio: [execOptions.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        shell: false, // Force disable shell to prevent injection
      })

      let stdout = ''
      let stderr = ''
      proc.stdout!.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      proc.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      timer = setTimeout(() => {
        proc.kill('SIGTERM')
        finish(() =>
          reject(
            new GitCommandError('Git command timeout', {
              details: { command: args, timeoutMs: this.options.timeoutMs },
            }),
          ),
        )
      }, this.options.timeoutMs)

      if (execOptions.input !== undefined && proc.stdin !== undefined) {
        proc.stdin!.on('error', () => {
          // Git may close stdin early after rejecting a malformed command. The
          // command's exit code remains the source of truth in that case.
        })
        proc.stdin!.end(execOptions.input)
      }

      proc.on('close', (code) => {
        const exitCode = code ?? -1
        const result = { stdout, stderr, exitCode }

        if (exitCode !== 0) {
          finish(() =>
            reject(
              new GitCommandError(`Git command failed (exit ${exitCode})`, {
                details: { command: args, exitCode, stderr },
              }),
            ),
          )
        } else {
          finish(() => resolve(result))
        }
      })

      proc.on('error', (err) => {
        finish(() =>
          reject(
            new GitCommandError('Git command spawn failed', {
              cause: err,
              details: { command: args },
            }),
          ),
        )
      })
    })
  }

  /**
   * Execute a Git command and return trimmed stdout (for single-line output commands).
   * @param args - Command arguments
   * @param cwd - Working directory
   */
  async execLine(
    args: string[],
    cwd?: string,
    execOptions: GitExecOptions = {},
  ): Promise<string> {
    const { stdout } = await this.exec(args, cwd, execOptions)
    return stdout.trim()
  }
}
