// Recorded names win ([[OPS262]] D6, [[CORE259]] D16, OPS276): an instance that already records its resource names keeps them; a new one
// takes the `vb-<kind>-<env>` derivation of `buildSetupOptions`. A name flag that disagrees with the record is refused (P3).
import { RemoteRefusal } from '../remote.js'
import { checkDistinctDatabases } from './args.js'
import type { SetupOptions } from './types.js'

export interface RecordedNames {
  workerName?: string
  d1Name?: string
  /** The control database ([[OPS279]]): absent for an instance that has none yet (P4). */
  controlD1Name?: string
  r2Name?: string
  /** The recorded database ids, only to refuse a record whose control database is the CRM database. */
  d1Id?: string
  controlD1Id?: string
}

const KINDS = [
  ['workerName', '--worker-name', 'Worker'],
  ['d1Name', '--d1-name', 'D1 database'],
  ['controlD1Name', '--control-d1-name', 'control D1 database'],
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
  checkDistinctDatabases(out.d1Name, out.controlD1Name)
  if (record.d1Id !== undefined && record.d1Id === record.controlD1Id) throw new RemoteRefusal(`${where} records the same database id ${record.d1Id} for the CRM and the control database: the control plane is its own database`)
  return out
}
