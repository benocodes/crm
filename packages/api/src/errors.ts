export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413

export class ApiError extends Error {
  override name = 'ApiError'
  constructor(
    public readonly status: ErrorStatus,
    public readonly code: string,
    message: string,
  ) {
    super(message)
  }
  toBody(): { error: { code: string; message: string } } {
    return { error: { code: this.code, message: this.message } }
  }
}

/** Maps a foreign-key violation to `invalid_reference`; never leaks the constraint detail. */
export function mapDatabaseError(err: unknown): unknown {
  if ((err as { code?: unknown } | null)?.code === '23503') {
    return new ApiError(400, 'invalid_reference', 'a referenced record does not exist')
  }
  return err
}
