import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { FileRunLeaseStore } from '../src/repository/file-lease.js'
import { InMemoryRunLeaseStore, type RunLeaseStore } from '../src/repository/lease.js'
import { LeaseLostError } from '../src/run/errors.js'
import type { Clock } from '../src/ports.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-leases-'))
  dirs.push(dir)
  return dir
}

function manualClock(start = 1_000): Clock & { advance(ms: number): void } {
  let now = start
  return { now: () => now, advance: (ms) => { now += ms } }
}

function describeLeaseStoreContract(name: string, factory: (clock: Clock) => Promise<RunLeaseStore>) {
  describe(`${name}: RunLeaseStore contract`, () => {
    it('gives the lease to one owner and refuses everyone else until it expires', async () => {
      const clock = manualClock()
      const store = await factory(clock)
      const lease = await store.acquire('run-1', 'a', 100)
      expect(lease).toMatchObject({ runId: 'run-1', owner: 'a', token: 1, expiresAt: 1_100 })
      expect(await store.acquire('run-1', 'b', 100)).toBeUndefined()

      clock.advance(101)
      const taken = await store.acquire('run-1', 'b', 100)
      expect(taken).toMatchObject({ owner: 'b', token: 2 })
      await expect(store.renew(lease!, 100)).rejects.toBeInstanceOf(LeaseLostError)
    })

    it('renews for its holder, and re-acquiring your own live lease renews it without a new token', async () => {
      const clock = manualClock()
      const store = await factory(clock)
      const lease = (await store.acquire('run-1', 'a', 100))!
      clock.advance(60)
      const renewed = await store.renew(lease, 100)
      expect(renewed).toMatchObject({ token: 1, expiresAt: 1_160 })
      clock.advance(60)
      expect(await store.acquire('run-1', 'b', 100)).toBeUndefined()
      expect(await store.acquire('run-1', 'a', 100)).toMatchObject({ token: 1, expiresAt: 1_220 })
    })

    it('frees the lease on release, and ignores a release from someone who no longer holds it', async () => {
      const clock = manualClock()
      const store = await factory(clock)
      const lease = (await store.acquire('run-1', 'a', 100))!
      await store.release(lease)
      const next = (await store.acquire('run-1', 'b', 100))!
      expect(next.token).toBe(2)
      await store.release(lease)
      expect(await store.get('run-1')).toMatchObject({ owner: 'b', token: 2 })
      await expect(store.renew(lease, 100)).rejects.toBeInstanceOf(LeaseLostError)
    })

    it('keeps runs independent', async () => {
      const store = await factory(manualClock())
      expect(await store.acquire('run-1', 'a', 100)).toBeDefined()
      expect(await store.acquire('run-2', 'b', 100)).toBeDefined()
      expect(await store.get('run-3')).toBeUndefined()
    })
  })
}

describeLeaseStoreContract('InMemoryRunLeaseStore', async (clock) => new InMemoryRunLeaseStore(clock))
describeLeaseStoreContract('FileRunLeaseStore', async (clock) => new FileRunLeaseStore({ dir: await tempDir(), clock }))

describe('FileRunLeaseStore', () => {
  it('keeps only the newest lease file, under a dot-directory a run listing skips', async () => {
    const clock = manualClock()
    const dir = await tempDir()
    const store = new FileRunLeaseStore({ dir, clock })
    for (const owner of ['a', 'b', 'c']) {
      await store.acquire('run-1', owner, 10)
      clock.advance(11)
    }
    expect(await readdir(dir)).toEqual(['.leases'])
    expect(await readdir(path.join(dir, '.leases', 'run-1'))).toEqual(['000000000003.json'])
  })

  it('treats a damaged lease file as free rather than wedging the run', async () => {
    const dir = await tempDir()
    const store = new FileRunLeaseStore({ dir, clock: manualClock() })
    await store.acquire('run-1', 'a', 100)
    await writeFile(path.join(dir, '.leases', 'run-1', '000000000001.json'), '{ nope', 'utf8')
    expect(await store.acquire('run-1', 'b', 100)).toMatchObject({ owner: 'b', token: 2 })
  })

  it('refuses run ids that would not be safe directory names', async () => {
    const store = new FileRunLeaseStore({ dir: await tempDir() })
    await expect(store.acquire('../escape', 'a', 100)).rejects.toThrow(/not a safe file name/)
  })

  it('hands a free lease to exactly one of several processes racing for it', async () => {
    const dir = await tempDir()
    const source = pathToFileURL(path.resolve(import.meta.dirname, '../src/repository/file-lease.ts')).href
    const script = [
      `import { FileRunLeaseStore } from ${JSON.stringify(source)}`,
      'const store = new FileRunLeaseStore({ dir: process.argv[2] })',
      'while (Date.now() < Number(process.argv[4])) {}',
      "const lease = await store.acquire('run-1', 'owner-' + process.argv[3], 60000)",
      "console.log(lease === undefined ? 'refused' : 'won')",
    ].join('\n')
    const file = path.join(dir, 'contender.mjs')
    await writeFile(file, script, 'utf8')
    const startAt = String(Date.now() + 1_500)
    const outputs = await Promise.all(Array.from({ length: 6 }, (_, index) => new Promise<string>((resolve, reject) => {
      execFile(process.execPath, ['--import', 'tsx', file, dir, String(index), startAt], { cwd: path.resolve(import.meta.dirname, '../../..') }, (error, stdout, stderr) => {
        if (error !== null) reject(new Error(`${error.message}\n${stderr}`))
        else resolve(stdout.trim())
      })
    })))
    expect(outputs.filter((output) => output === 'won')).toHaveLength(1)
    expect(outputs.filter((output) => output === 'refused')).toHaveLength(5)
    expect(await new FileRunLeaseStore({ dir }).get('run-1')).toMatchObject({ token: 1 })
  })
})
