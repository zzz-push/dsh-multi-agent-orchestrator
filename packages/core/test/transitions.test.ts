import { describe, expect, it } from 'vitest'
import { InvalidTransitionError } from '../src/run/errors.js'
import {
  canTransitionRun,
  canTransitionStep,
  RUN_TRANSITIONS,
  STEP_TRANSITIONS,
  transitionRunStatus,
  transitionStepStatus,
} from '../src/run/transitions.js'
import type { RunStatus, StepStatus } from '../src/run/types.js'

const ALL_RUN_STATUSES = Object.keys(RUN_TRANSITIONS) as RunStatus[]
const ALL_STEP_STATUSES = Object.keys(STEP_TRANSITIONS) as StepStatus[]

describe('run transitions', () => {
  it('allows every documented successor and returns the target status', () => {
    for (const current of ALL_RUN_STATUSES) {
      for (const target of RUN_TRANSITIONS[current]) {
        expect(canTransitionRun(current, target)).toBe(true)
        expect(transitionRunStatus(current, target)).toBe(target)
      }
    }
  })

  it('rejects every non-documented successor with InvalidTransitionError', () => {
    for (const current of ALL_RUN_STATUSES) {
      for (const target of ALL_RUN_STATUSES) {
        if (RUN_TRANSITIONS[current].includes(target)) continue
        expect(canTransitionRun(current, target)).toBe(false)
        expect(() => transitionRunStatus(current, target, 5)).toThrow(InvalidTransitionError)
      }
    }
  })

  it('carries entity, current, target and revision on the thrown error', () => {
    try {
      transitionRunStatus('applied', 'running', 7)
      throw new Error('expected transitionRunStatus to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransitionError)
      const invalid = error as InvalidTransitionError
      expect(invalid.entity).toBe('run')
      expect(invalid.current).toBe('applied')
      expect(invalid.target).toBe('running')
      expect(invalid.revision).toBe(7)
    }
  })

  it('keeps every terminal run status without any successor', () => {
    for (const terminal of ['applied', 'failed', 'cancelled'] as const) {
      expect(RUN_TRANSITIONS[terminal]).toEqual([])
    }
  })

  it('keeps delivery_ready and applied as distinct, separately reachable statuses', () => {
    expect(RUN_TRANSITIONS.delivery_ready).not.toContain('applied')
    expect(RUN_TRANSITIONS.applying).toContain('applied')
  })
})

describe('step transitions', () => {
  it('allows every documented successor and returns the target status', () => {
    for (const current of ALL_STEP_STATUSES) {
      for (const target of STEP_TRANSITIONS[current]) {
        expect(canTransitionStep(current, target)).toBe(true)
        expect(transitionStepStatus(current, target)).toBe(target)
      }
    }
  })

  it('rejects every non-documented successor with InvalidTransitionError', () => {
    for (const current of ALL_STEP_STATUSES) {
      for (const target of ALL_STEP_STATUSES) {
        if (STEP_TRANSITIONS[current].includes(target)) continue
        expect(canTransitionStep(current, target)).toBe(false)
        expect(() => transitionStepStatus(current, target, 3)).toThrow(InvalidTransitionError)
      }
    }
  })

  it('never folds an unknown/failed status into succeeded directly', () => {
    expect(STEP_TRANSITIONS.failed).not.toContain('succeeded')
    expect(STEP_TRANSITIONS.cancelled).toEqual([])
    expect(STEP_TRANSITIONS.skipped_dependency_failed).toEqual([])
  })
})
