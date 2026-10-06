import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { StepCheck } from '@dsh/core'

import { CommandVerificationDriver, WorkflowCheckVerificationDriver } from '../src/command-verification.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-verify-'))
  dirs.push(dir)
  return dir
}
const request = (worktreePath: string | undefined) => ({ runId: 'run-1', stepId: 'a', attempt: 1, worktreePath })

/**
 * Every process in `pid`'s process group, as `ps` prints it — diagnostics
 * for a flaky failure, which failed once and never again. Best effort: a missing
 * `ps` or a process already gone yields a note, never a throw.
 */
function processGroupSnapshot(pid: number | undefined): string {
  if (pid === undefined) return '(no pid)'
  try {
    const pgid = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    const rows = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,stat=,command='], { encoding: 'utf8' })
      .split('\n')
      .filter((row) => row.trim().split(/\s+/)[1] === pgid)
    return `pgid ${pgid}:\n${rows.join('\n')}`
  } catch (error) {
    return `(ps: ${error instanceof Error ? error.message.split('\n')[0] : String(error)})`
  }
}

describe('CommandVerificationDriver', () => {
  it('runs every check in the worktree, in order, and records exit code, duration and output tail', async () => {
    const dir = await tempDir()
    const driver = new CommandVerificationDriver({
      commands: [
        { name: 'pwd', command: 'pwd' },
        { name: 'touch', command: 'echo created > marker.txt && cat marker.txt' },
      ],
    })
    const result = await driver.run(request(dir))
    expect(result.passed).toBe(true)
    expect(result.evidence?.checks).toHaveLength(2)
    const [first, second] = result.evidence!.checks!
    expect(first).toMatchObject({ name: 'pwd', exitCode: 0 })
    expect(first!.outputSummary).toContain(path.basename(dir))
    expect(first!.durationMs).toBeGreaterThanOrEqual(0)
    expect(second).toMatchObject({ name: 'touch', exitCode: 0, outputSummary: 'created' })
  })

  it('stops at the first failing check, keeps the evidence for what ran, and names the failure', async () => {
    const dir = await tempDir()
    const driver = new CommandVerificationDriver({
      commands: [
        { name: 'ok', command: 'echo fine' },
        { name: 'boom', command: 'echo "something broke" >&2; exit 3' },
        { name: 'never', command: 'echo unreachable' },
      ],
    })
    const result = await driver.run(request(dir))
    expect(result.passed).toBe(false)
    expect(result.failureMessage).toBe('Check "boom" exited with code 3')
    expect(result.evidence?.passed).toBe(false)
    expect(result.evidence?.checks?.map((check) => check.name)).toEqual(['ok', 'boom'])
    expect(result.evidence?.checks?.[1]).toMatchObject({ exitCode: 3, outputSummary: 'something broke' })
  })

  it('kills a check that overruns its cap and reports it as a timeout, not a pass', async () => {
    const dir = await tempDir()
    const driver = new CommandVerificationDriver({
      commands: [{ name: 'slow', command: 'sleep 30', timeoutMs: 200 }],
    })
    const result = await driver.run(request(dir))
    expect(result.passed).toBe(false)
    expect(result.failureMessage).toBe('Check "slow" timed out')
    expect(result.evidence?.checks?.[0]).toMatchObject({ name: 'slow', signal: 'SIGTERM' })
    expect(result.evidence?.checks?.[0]?.outputSummary).toContain('timed out after 200ms')
  })

  it('keeps only the tail of long output', async () => {
    const dir = await tempDir()
    const driver = new CommandVerificationDriver({
      commands: [{ name: 'chatty', command: 'seq 1 100' }],
      outputTailLines: 3,
    })
    const result = await driver.run(request(dir))
    expect(result.evidence?.checks?.[0]?.outputSummary).toBe('98\n99\n100')
  })

  it('passes per-command env and fails cleanly without a worktree', async () => {
    const dir = await tempDir()
    const driver = new CommandVerificationDriver({
      commands: [{ name: 'env', command: 'echo "$DSH_CHECK_FLAG"', env: { DSH_CHECK_FLAG: 'on' } }],
    })
    expect((await driver.run(request(dir))).evidence?.checks?.[0]?.outputSummary).toBe('on')
    const missing = await driver.run(request(undefined))
    expect(missing.passed).toBe(false)
    expect(missing.failureMessage).toContain('worktreePath')
  })

  it('applies a driver-wide env to every command, under each command\'s own env', async () => {
    const dir = await tempDir()
    const driver = new CommandVerificationDriver({
      env: { LC_ALL: 'C', DSH_LAYER: 'driver' },
      commands: [
        { name: 'driver env', command: 'echo "$LC_ALL/$DSH_LAYER"' },
        { name: 'command wins', command: 'echo "$DSH_LAYER"', env: { DSH_LAYER: 'command' } },
      ],
    })
    const checks = (await driver.run(request(dir))).evidence?.checks ?? []
    expect(checks.map((check) => check.outputSummary)).toEqual(['C/driver', 'command'])
  })

  it('honours an abort signal by killing the running check', async () => {
    const dir = await tempDir()
    const controller = new AbortController()
    const driver = new CommandVerificationDriver({ commands: [{ name: 'slow', command: 'sleep 30' }] })
    const pending = driver.run({ ...request(dir), signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    const result = await pending
    expect(result.passed).toBe(false)
    expect(result.evidence?.checks?.[0]?.signal).toBe('SIGTERM')
  })

  it('stops the whole process group, not just the shell, so a check\'s children do not outlive it', async () => {
    const dir = await tempDir()
    const controller = new AbortController()
    // `sh` starts a grandchild and waits for it — the shape `pnpm test` has.
    const driver = new CommandVerificationDriver({ commands: [{ name: 'tree', command: 'sleep 30 & echo $! > child.pid; wait' }] })
    const pending = driver.run({ ...request(dir), signal: controller.signal })
    const pidFile = path.join(dir, 'child.pid')
    let pid: number | undefined
    for (let i = 0; i < 200 && pid === undefined; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      const text = await readFile(pidFile, 'utf8').catch(() => '')
      if (text.trim() !== '') pid = Number(text.trim())
    }
    expect(pid).toBeGreaterThan(0)
    const before = processGroupSnapshot(pid)
    const abortedAt = Date.now()
    controller.abort()
    const result = await pending
    // This once reported exit 0 after the abort under a full
    // coverage run and never reproduced. If it happens again, the message
    // carries what the group looked like before and after, and what the
    // check itself recorded.
    const diagnostics = () => [
      `abort → result took ${Date.now() - abortedAt} ms`,
      `checks: ${JSON.stringify(result.evidence?.checks)}`,
      `before abort: ${before}`,
      `after: ${processGroupSnapshot(pid)}`,
    ].join('\n')
    expect(result.passed, diagnostics()).toBe(false)
    let alive = true
    for (let i = 0; i < 100 && alive; i += 1) {
      try {
        process.kill(pid!, 0)
        await new Promise((resolve) => setTimeout(resolve, 10))
      } catch {
        alive = false
      }
    }
    expect(alive, diagnostics()).toBe(false)
  })

  it('runs nothing once the request is already aborted', async () => {
    const dir = await tempDir()
    const controller = new AbortController()
    controller.abort()
    const driver = new CommandVerificationDriver({ commands: [{ name: 'marker', command: 'touch ran.txt' }] })
    const result = await driver.run({ ...request(dir), signal: controller.signal })
    expect(result).toMatchObject({ passed: false, failureMessage: 'Checks cancelled', evidence: { checks: [] } })
    await expect(readFile(path.join(dir, 'ran.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('WorkflowCheckVerificationDriver', () => {
  const step = (overrides: Partial<StepCheck> = {}): StepCheck => ({ id: 'check', command: ['sh', '-c', 'true'], cwd: '.', timeoutSeconds: 30, envAllow: [], required: true, ...overrides })

  it('runs the step\'s declared checks as argv in the worktree, passing through only the allowed environment', async () => {
    const dir = await tempDir()
    process.env.DSH_TEST_ALLOWED = 'yes'
    process.env.DSH_TEST_SECRET = 'leaked'
    try {
      const result = await new WorkflowCheckVerificationDriver().run({
        ...request(dir),
        commands: [
          step({ id: 'argv', command: ['node', '-e', 'console.log(process.argv.slice(1).join("|"))', 'a b', '$HOME'] }),
          step({ id: 'env', command: ['node', '-e', 'console.log(process.env.DSH_TEST_ALLOWED, process.env.DSH_TEST_SECRET, process.env.LC_ALL)'], envAllow: ['DSH_TEST_ALLOWED'] }),
        ],
      })
      expect(result.passed).toBe(true)
      // No shell: the arguments arrive verbatim, "$HOME" unexpanded.
      expect(result.evidence?.checks?.[0]?.outputSummary).toBe('a b|$HOME')
      expect(result.evidence?.checks?.[1]?.outputSummary).toBe('yes undefined C')
    } finally {
      delete process.env.DSH_TEST_ALLOWED
      delete process.env.DSH_TEST_SECRET
    }
  })

  it('fails on a required check, records but ignores an optional one, and refuses a cwd outside the worktree', async () => {
    const dir = await tempDir()
    const driver = new WorkflowCheckVerificationDriver()
    const optional = await driver.run({ ...request(dir), commands: [step({ id: 'lint', command: ['sh', '-c', 'exit 3'], required: false }), step({ id: 'ok' })] })
    expect(optional.passed).toBe(true)
    expect(optional.evidence?.checks?.map((check) => [check.name, check.exitCode])).toEqual([['lint', 3], ['ok', 0]])

    const required = await driver.run({ ...request(dir), commands: [step({ id: 'test', command: ['sh', '-c', 'exit 1'] }), step({ id: 'never' })] })
    expect(required).toMatchObject({ passed: false, failureMessage: 'Check "test" exited with code 1' })
    expect(required.evidence?.checks).toHaveLength(1)

    const escaping = await driver.run({ ...request(dir), commands: [step({ cwd: '../elsewhere' })] })
    expect(escaping).toMatchObject({ passed: false, failureMessage: 'Check "check" cwd escapes the worktree: ../elsewhere' })
  })

  it('passes a step that declares no checks', async () => {
    expect(await new WorkflowCheckVerificationDriver().run(request(await tempDir()))).toEqual({ passed: true, evidence: { passed: true, checks: [] } })
  })
})
