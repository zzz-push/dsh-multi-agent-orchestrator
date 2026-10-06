import { randomBytes } from 'node:crypto'
import { link, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Filesystem primitives the durable repository and lease store are built on.
 * Both rely on one property only: `link(2)` refuses to overwrite an existing
 * name, atomically, across processes. Writing the full content to a temp file
 * first and then linking it into place means a reader sees either nothing or
 * a complete document, and two writers racing for the same name get exactly
 * one winner — a compare-and-set that needs no lock file, so no lock can be
 * left behind by a process that dies holding it.
 */

function tempNameFor(target: string): string {
  return `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
}

/**
 * Create `target` with `text`, failing with `EEXIST` when it already exists.
 * The content is complete before the name becomes visible.
 */
export async function publishExclusive(target: string, text: string): Promise<void> {
  const tmp = tempNameFor(target)
  await writeFile(tmp, text, 'utf8')
  try {
    await link(tmp, target)
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined)
  }
}

/** Replace `target` with `text` atomically (temp file + rename). Last writer wins. */
export async function replaceAtomic(target: string, text: string): Promise<void> {
  const tmp = tempNameFor(target)
  try {
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, target)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

const SEQUENCE_FILE = /^(\d{1,15})\.json$/

/** File name for sequence number `n`, zero-padded so a plain listing sorts in order. */
export function sequenceFileName(n: number): string {
  return `${String(n).padStart(12, '0')}.json`
}

/** Sequence numbers present in `dir`, ascending. `[]` when `dir` does not exist. */
export async function listSequence(dir: string): Promise<number[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return []
    throw error
  }
  const numbers: number[] = []
  for (const entry of entries) {
    const match = SEQUENCE_FILE.exec(entry)
    if (match?.[1] !== undefined) numbers.push(Number(match[1]))
  }
  return numbers.sort((a, b) => a - b)
}

/** Delete every sequence file in `dir` numbered below `keepFrom`. Best effort. */
export async function pruneSequence(dir: string, keepFrom: number): Promise<void> {
  for (const n of await listSequence(dir).catch(() => [])) {
    if (n >= keepFrom) break
    await rm(path.join(dir, sequenceFileName(n)), { force: true }).catch(() => undefined)
  }
}

export function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code
}
