import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { FileRunRepository } from '../src/repository/file.js'
import { RepositoryInvariantError, RevisionConflictError } from '../src/run/errors.js'
import { describeRunRepositoryContract, makeRun } from './repository-contract.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function runNode(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // tsx loads the TypeScript source directly; cwd is the workspace so `--import tsx` resolves.
    execFile(process.execPath, ['--import', 'tsx', file, ...args], { cwd: path.resolve(import.meta.dirname, '../../..') }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(`${error.message}\n${stderr}`))
      else resolve(stdout.trim())
    })
  })
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-runs-'))
  dirs.push(dir)
  return dir
}

describeRunRepositoryContract('FileRunRepository', async () => new FileRunRepository({ dir: await tempDir() }))

describe('FileRunRepository', () => {
  it('survives the process: a fresh instance over the same directory sees every run and revision', async () => {
    const dir = await tempDir()
    const first = new FileRunRepository({ dir })
    await first.create(makeRun('run-1'))
    await first.update('run-1', 0, (run) => ({ ...run, status: 'running' }))
    await first.create(makeRun('run-2'))

    // Nothing is shared with `first` except the directory.
    const second = new FileRunRepository({ dir })
    const run = await second.get('run-1')
    expect(run).toMatchObject({ id: 'run-1', revision: 1, status: 'running' })
    expect((await second.list()).map((summary) => summary.id).sort()).toEqual(['run-1', 'run-2'])

    // And CAS holds across instances: `second` can only update from the revision on disk.
    await expect(second.update('run-1', 0, (run) => run)).rejects.toThrow(RevisionConflictError)
    const updated = await second.update('run-1', 1, (run) => ({ ...run, status: 'waiting_action' }))
    expect(updated.revision).toBe(2)
    expect((await first.get('run-1'))!.revision).toBe(2)
  })

  it('does not touch the filesystem until the first write, then keeps one directory per run holding its two newest revisions', async () => {
    const dir = path.join(await tempDir(), 'nested', 'runs')
    const repo = new FileRunRepository({ dir })
    await expect(repo.list()).resolves.toEqual([])
    await expect(repo.get('run-1')).resolves.toBeUndefined()
    await expect(readdir(dir)).rejects.toMatchObject({ code: 'ENOENT' })

    await repo.create(makeRun('run-1'))
    await repo.update('run-1', 0, (run) => ({ ...run, status: 'running' }))
    await repo.update('run-1', 1, (run) => ({ ...run, status: 'waiting_action' }))
    // Temp files are linked into place and removed; no `.tmp` litter after three writes.
    expect(await readdir(dir)).toEqual(['run-1'])
    expect(await readdir(path.join(dir, 'run-1'))).toEqual(['000000000001.json', '000000000002.json'])
    expect(JSON.parse(await readFile(path.join(dir, 'run-1', '000000000002.json'), 'utf8'))).toMatchObject({ id: 'run-1', revision: 2, status: 'waiting_action' })
  })

  it('reads a run stored in the legacy single-file layout, and moves it on the first update', async () => {
    const dir = await tempDir()
    await writeFile(path.join(dir, 'old-run.json'), JSON.stringify({ ...makeRun('old-run'), revision: 4 }), 'utf8')
    const repo = new FileRunRepository({ dir })

    expect(await repo.get('old-run')).toMatchObject({ id: 'old-run', revision: 4 })
    expect((await repo.list()).map((summary) => summary.id)).toEqual(['old-run'])
    await expect(repo.create(makeRun('old-run'))).rejects.toThrow(/already exists/)

    const updated = await repo.update('old-run', 4, (run) => ({ ...run, status: 'running' }))
    expect(updated.revision).toBe(5)
    expect(await readdir(dir)).toEqual(['old-run'])
    expect(await repo.get('old-run')).toMatchObject({ revision: 5, status: 'running' })
  })

  it('holds CAS across processes: of six writers racing from one revision, exactly one wins', async () => {
    const dir = await tempDir()
    const seed = new FileRunRepository({ dir })
    await seed.create(makeRun('run-1'))
    const script = [
      `import { FileRunRepository } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, '../src/repository/file.ts')).href)}`,
      'const repo = new FileRunRepository({ dir: process.argv[2] })',
      // Busy-wait to a shared start instant so the writers genuinely overlap;
      // without it they tend to run one after another and any CAS would pass.
      'while (Date.now() < Number(process.argv[4])) {}',
      "try { await repo.update('run-1', 0, (run) => ({ ...run, status: 'running', workflowId: 'writer-' + process.argv[3] })); console.log('won') }",
      "catch (error) { console.log(error.name) }",
    ].join('\n')
    const scriptFile = path.join(dir, 'writer.mjs')
    await writeFile(scriptFile, script, 'utf8')
    // Separate Node processes: no in-process queue can serialise them.
    const startAt = String(Date.now() + 1_500)
    const outputs = await Promise.all(Array.from({ length: 6 }, (_, index) => runNode(scriptFile, [dir, String(index), startAt])))
    expect(outputs.filter((output) => output === 'won')).toHaveLength(1)
    expect(outputs.filter((output) => output === 'RevisionConflictError')).toHaveLength(5)
    const run = await seed.get('run-1')
    expect(run?.revision).toBe(1)
    expect(run?.workflowId).toMatch(/^writer-\d$/)
  })

  it('returns what it persisted, not the caller object graph', async () => {
    const dir = await tempDir()
    const repo = new FileRunRepository({ dir })
    await repo.create(makeRun('run-1'))
    const returned = await repo.update('run-1', 0, (run) => ({ ...run, status: 'running' }))
    const reread = await repo.get('run-1')
    expect(reread).toEqual(returned)
    expect(reread).not.toBe(returned)
    // Mutating the returned value must not change what a later read sees.
    returned.status = 'failed'
    expect((await repo.get('run-1'))!.status).toBe('running')
  })

  it('refuses run ids that would not be safe file names', async () => {
    const repo = new FileRunRepository({ dir: await tempDir() })
    for (const id of ['../escape', 'a/b', '.hidden', '', 'x'.repeat(200)]) {
      await expect(repo.create(makeRun(id))).rejects.toThrow(RepositoryInvariantError)
      await expect(repo.get(id)).rejects.toThrow(RepositoryInvariantError)
      await expect(repo.update(id, 0, (run) => run)).rejects.toThrow(RepositoryInvariantError)
    }
    // UUIDs — what startWorkflow() generates — are fine.
    await expect(repo.create(makeRun('3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'))).resolves.toBeUndefined()
  })

  it('throws on a damaged document for get(), but list() skips it and reports it', async () => {
    const dir = await tempDir()
    const skipped: string[] = []
    const repo = new FileRunRepository({ dir, onSkippedFile: (file) => skipped.push(path.basename(file)) })
    await repo.create(makeRun('good'))
    await writeFile(path.join(dir, 'broken.json'), '{ not json', 'utf8')
    await writeFile(path.join(dir, 'mismatch.json'), JSON.stringify({ ...makeRun('other'), id: 'other' }), 'utf8')
    await writeFile(path.join(dir, 'old-schema.json'), JSON.stringify({ ...makeRun('old-schema'), schemaVersion: 0 }), 'utf8')
    // A leftover temp file from an interrupted write is not a run document at all.
    await writeFile(path.join(dir, 'good.json.123.abcd.tmp'), 'partial', 'utf8')

    await expect(repo.get('broken')).rejects.toThrow(RepositoryInvariantError)
    await expect(repo.get('mismatch')).rejects.toThrow(RepositoryInvariantError)
    await expect(repo.get('old-schema')).rejects.toThrow(RepositoryInvariantError)
    // The damaged run cannot be silently updated into a "healthy" one either.
    await expect(repo.update('broken', 0, (run) => run)).rejects.toThrow(RepositoryInvariantError)

    const listed = await repo.list()
    expect(listed.map((summary) => summary.id)).toEqual(['good'])
    expect(skipped.sort()).toEqual(['broken.json', 'mismatch.json', 'old-schema.json'])
  })

  it('refuses to store a non-finite number instead of silently writing null', async () => {
    const repo = new FileRunRepository({ dir: await tempDir() })
    const run = makeRun('run-1')
    run.workflow = { maxParallel: Number.POSITIVE_INFINITY, failureMode: 'stop_after_batch' }
    await expect(repo.create(run)).rejects.toThrow(/maxParallel.*Infinity/)
    // Nothing landed on disk for the rejected create.
    await expect(repo.get('run-1')).resolves.toBeUndefined()

    await repo.create(makeRun('run-1'))
    await expect(repo.update('run-1', 0, (current) => ({ ...current, usage: { tokens: Number.NaN } })))
      .rejects.toThrow(RepositoryInvariantError)
    expect((await repo.get('run-1'))!.revision).toBe(0)
  })

  it('serialises a burst of same-run updates so every revision is claimed exactly once', async () => {
    const repo = new FileRunRepository({ dir: await tempDir() })
    await repo.create(makeRun('run-1'))
    // Each updater reads the revision it is handed; only one can hold each
    // number, so with in-process serialisation exactly one of every batch of
    // N racers on the same revision wins and the rest see a conflict.
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => repo.update('run-1', 0, (run) => ({ ...run, status: 'running' }))),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(7)
    expect((await repo.get('run-1'))!.revision).toBe(1)
  })
})
