import { ForeignOrganizationError, SetLimitExceeded, StatementFailed, UnitDriftError } from '@vault/storage'
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

/**
 * Maps a storage-layer failure to the public error. Business refusals already are ApiErrors; this covers
 * what the runtimes raise: a foreign-key failure is `invalid_reference`, drift is a retryable conflict, an
 * over-cap set is the documented limit error, a foreign organisation is refused. Anything else is left to be masked.
 */
export function mapStorageError(err: unknown): unknown {
  if (err instanceof StatementFailed && err.kind === 'foreign_key') {
    return new ApiError(400, 'invalid_reference', 'a referenced record does not exist')
  }
  if (err instanceof UnitDriftError) {
    return new ApiError(409, 'conflict', 'the record changed while the operation was running; retry')
  }
  if (err instanceof SetLimitExceeded) return new ApiError(400, 'set_limit_exceeded', err.message)
  if (err instanceof ForeignOrganizationError) return new ApiError(403, 'organization_forbidden', 'not a member of that organisation')
  return mapDatabaseError(err)
}
