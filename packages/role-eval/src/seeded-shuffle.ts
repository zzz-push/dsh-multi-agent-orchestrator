import { randomInt } from 'node:crypto'

/**
 * Deterministic Fisher–Yates with a mulberry32 stream: the same `seed`
 * always gives the same order, so a recorded seed reproduces a shuffle —
 * which arm ran first in a comparison, which arm became `A` in a blinded
 * evidence bundle.
 */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const result = [...items]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1))
    ;[result[index], result[swap]] = [result[swap]!, result[index]!]
  }
  return result
}

/** A fresh seed for `seededShuffle`, in the range the evidence bundle has always used. */
export function randomSeed(): number {
  return randomInt(1, 2 ** 31 - 1)
}
