import { describe, expect, it } from 'vitest'
import { DshError } from '../src/errors.js'

// DshError is abstract; tests exercise it through a minimal concrete subclass.
class TestError extends DshError {
  readonly code = 'TEST_ERROR'
}

describe('DshError', () => {
  it('sets message and derives name from the concrete subclass', () => {
    const error = new TestError('something went wrong')
    expect(error.message).toBe('something went wrong')
    expect(error.name).toBe('TestError')
    expect(error.code).toBe('TEST_ERROR')
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(DshError)
  })

  it('leaves details and cause undefined when not provided', () => {
    const error = new TestError('bare')
    expect(error.details).toBeUndefined()
    expect(error.cause).toBeUndefined()
  })

  it('captures details and chains cause when provided', () => {
    const cause = new Error('root cause')
    const error = new TestError('wrapped', { cause, details: { field: 'x' } })
    expect(error.cause).toBe(cause)
    expect(error.details).toEqual({ field: 'x' })
  })
})
