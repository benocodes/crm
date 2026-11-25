/** Every failure of a call rejects with this (DX603 D8): the API's own `{ error: { code, message } }`, or a code the client chose. */
export class VibaseError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'VibaseError'
    this.status = status
    this.code = code
  }
}

export function isVibaseError(value: unknown): value is VibaseError {
  return value instanceof VibaseError
}
