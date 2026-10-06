import { InvalidTransitionError } from './errors.js'
import type { RunStatus, StepStatus } from './types.js'

export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  validating: ['ready', 'failed'],
  ready: ['running', 'cancelling'],
  running: ['waiting_approval', 'waiting_action', 'delivery_ready', 'cancelling'],
  waiting_approval: ['running', 'cancelling', 'failed'],
  waiting_action: ['running', 'failed', 'cancelling'],
  delivery_ready: ['applying', 'cancelling'],
  applying: ['applied', 'waiting_action', 'interrupted'],
  cancelling: ['cancelled', 'interrupted'],
  applied: [],
  failed: [],
  cancelled: [],
  interrupted: ['running', 'failed', 'cancelling'],
}

export const STEP_TRANSITIONS: Readonly<Record<StepStatus, readonly StepStatus[]>> = {
  pending: ['ready', 'skipped_dependency_failed'],
  ready: ['provisioning', 'cancelled'],
  provisioning: ['running', 'failed', 'cancelled', 'interrupted'],
  running: ['verifying', 'failed', 'cancelled', 'interrupted'],
  verifying: ['running', 'waiting_approval', 'merge_queued', 'succeeded', 'failed', 'cancelled', 'interrupted'],
  waiting_approval: ['merge_queued', 'failed', 'cancelled'],
  merge_queued: ['merged', 'merge_conflict', 'cancelled', 'interrupted'],
  merged: [],
  succeeded: [],
  merge_conflict: ['waiting_approval', 'failed', 'cancelled'],
  failed: ['ready', 'cancelled'],
  cancelled: [],
  skipped_dependency_failed: [],
  interrupted: ['ready', 'failed', 'cancelled'],
}

export function canTransitionRun(current: RunStatus, target: RunStatus): boolean {
  return RUN_TRANSITIONS[current].includes(target)
}

export function canTransitionStep(current: StepStatus, target: StepStatus): boolean {
  return STEP_TRANSITIONS[current].includes(target)
}

export function transitionRunStatus(current: RunStatus, target: RunStatus, revision = 0): RunStatus {
  if (!canTransitionRun(current, target)) {
    throw new InvalidTransitionError('run', current, target, revision)
  }
  return target
}

export function transitionStepStatus(current: StepStatus, target: StepStatus, revision = 0): StepStatus {
  if (!canTransitionStep(current, target)) {
    throw new InvalidTransitionError('step', current, target, revision)
  }
  return target
}

export const transitionRun = transitionRunStatus
export const transitionStep = transitionStepStatus
