import { uuidv7 } from '@vault/storage'

/**
 * What a unit of internal work needs from the application ([[CORE41]] P5): the clock and the id source, built once per
 * request from `AppOptions.clock`/`newId` (defaults: real time, `uuidv7(now)`). Authentication, first sight, the
 * directory and bootstrap mint ids and stamps from this, so golden runs are deterministic.
 */
export interface InternalEnv {
  readonly now: Date
  newId(): string
}

export function internalEnv(opts: { clock?: () => Date; newId?: () => string }): InternalEnv {
  const now = (opts.clock ?? (() => new Date()))()
  return { now, newId: opts.newId ?? (() => uuidv7(now)) }
}
