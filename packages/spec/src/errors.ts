/** Base error with a stable machine-readable code. */
export abstract class DshError extends Error {
  abstract readonly code: string
  readonly details?: unknown

  constructor(message: string, options?: { cause?: unknown; details?: unknown }) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = new.target.name
    this.details = options?.details
  }
}
