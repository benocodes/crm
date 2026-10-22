/** Error classes of the storage layer: a leaf module (no imports), so any package can name them. */

export class StorageError extends Error {
  override name = 'StorageError'
}

/** A bounded set exceeded the runtime's cap ([[CORE35]] D7). Raised before anything is written. */
export class SetLimitExceeded extends StorageError {
  override name = 'SetLimitExceeded'
  readonly code = 'set_limit_exceeded'
  constructor(
    readonly limit: number,
    readonly size: number,
  ) {
    super(`a set of more than ${limit} records is not supported (limit ${limit})`)
  }
}

/** The planned state changed before the unit ran and the unit was a no-op ("drift"): nothing was written. */
export class UnitDriftError extends StorageError {
  override name = 'UnitDriftError'
  readonly code = 'unit_drift'
  constructor(readonly operation: string) {
    super(`${operation}: the records changed while the operation was being prepared`)
  }
}

/** The unit committed but its result could not be decoded. Never replayed, never shown as success. */
export class CommittedResultInvalid extends StorageError {
  override name = 'CommittedResultInvalid'
  readonly code = 'committed_result_invalid'
  constructor(
    readonly operation: string,
    cause: unknown,
  ) {
    super(`${operation}: the unit committed but its result is invalid`, { cause })
  }
}

/** The transport failed in a way that leaves the commit uncertain. Never replayed. */
export class CommitOutcomeUnknown extends StorageError {
  override name = 'CommitOutcomeUnknown'
  readonly code = 'commit_outcome_unknown'
  constructor(
    readonly operation: string,
    cause: unknown,
  ) {
    super(`${operation}: the outcome of the commit is unknown`, { cause })
  }
}

/** An identity addressed a binding it is not admitted to (D1 serves exactly one organisation, [[CORE35]] D18). */
export class ForeignOrganizationError extends StorageError {
  override name = 'ForeignOrganizationError'
  readonly code = 'foreign_organization'
  constructor() {
    super('the organisation is not served by this storage binding')
  }
}

/** A cold (never-executable) database was asked to run a query. */
export class ColdExecutionError extends StorageError {
  override name = 'ColdExecutionError'
  constructor() {
    super('a cold database only compiles queries; it cannot execute them')
  }
}

/** A value that does not fit its column's public shape (codecs). */
export class CodecError extends StorageError {
  override name = 'CodecError'
}

/** A statement of a unit failed in the database (constraint, syntax): the unit rolled back. */
export class StatementFailed extends StorageError {
  override name = 'StatementFailed'
  constructor(
    readonly operation: string,
    cause: unknown,
  ) {
    super(`${operation}: a statement failed and the unit rolled back`, { cause })
  }
}
