// Recorded names win ([[OPS262]] D6, [[CORE259]] D16, OPS276): an instance that already records its resource names keeps them; a new one
// takes the `vb-<kind>-<env>` derivation of `buildSetupOptions`. A name flag that disagrees with the record is refused (P3).
import { RemoteRefusal } from '../remote.js'
import type { SetupOptions } from './types.js'

export interface RecordedNames {
  workerName?: string
  d1Name?: string
  r2Name?: string
}

const KINDS = [
  ['workerName', '--worker-name', 'Worker'],
  ['d1Name', '--d1-name', 'D1 database'],
  ['r2Name', '--r2-name', 'R2 bucket'],
] as const

/** The options with every recorded name in place of the derived one; throws `RemoteRefusal` where a flag differs from the record. */
export function applyRecordedNames(opts: SetupOptions, record: RecordedNames, where: string): SetupOptions {
  const out = { ...opts }
  for (const [key, flag, label] of KINDS) {
    const recorded = record[key]
    if (recorded === undefined) continue
    const given = opts.nameFlags?.[key]
    if (given !== undefined && given !== recorded) {
      throw new RemoteRefusal(`${flag} ${given}: this instance already records ${label} ${recorded} in ${where}; renaming an instance is a cutover, not a setup re-run (drop the flag)`)
    }
    out[key] = recorded
  }
  return out
}
