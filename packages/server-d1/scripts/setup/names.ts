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
  /** The `MAIL_SYNC` workflow's name; read only for a replace ([[OPS250]], 250.19). */
  workflowName?: string
  /** The recorded database ids, only to refuse a record whose control database is the CRM database. */
  d1Id?: string
  controlD1Id?: string
}

/** [[OPS262]] D5: a new instance's Workflow; shared by `vibase-server setup` (an existing record's name wins there) and a `--replace-instance` block ([[OPS250]]). */
export const workflowName = (env: string): string => `vb-mail-sync-${env}`

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
      throw new RemoteRefusal(
        `${flag} ${given}: this instance already records ${label} ${recorded} in ${where}; renaming an instance is a cutover, not a setup re-run (drop the flag, or build a fresh instance in its place with setup:remote --replace-instance <env>, OPS250)`,
      )
    }
    out[key] = recorded
  }
  checkDistinctDatabases(out.d1Name, out.controlD1Name)
  if (record.d1Id !== undefined && record.d1Id === record.controlD1Id)
    throw new RemoteRefusal(
      `${where} records the same database id ${record.d1Id} for the CRM and the control database: the control plane is its own database`,
    )
  return out
}

/**
 * `--replace-instance` ([[OPS250]] D12): the new names are the derivation or the flags, never the record's; a name equal to one the record holds would reuse a database,
 * bucket or Worker that holds the old instance, so it is refused before any call. Returns the options with the record's names kept in `replace.old`.
 */
export function replaceNames(opts: SetupOptions, record: RecordedNames, where: string): SetupOptions {
  for (const [key, flag, label] of KINDS) {
    const recorded = record[key]
    if (recorded !== undefined && opts[key] === recorded)
      throw new RemoteRefusal(
        `--replace-instance: ${opts.nameFlags?.[key] !== undefined ? `${flag} ` : `the derived ${label} name `}${recorded} equals the ${label} ${where} records; a replace builds new resources and touches nothing old (give ${flag} a different name)`,
      )
  }
  const newWorkflow = workflowName(opts.env)
  if (record.workflowName !== undefined && record.workflowName === newWorkflow)
    throw new RemoteRefusal(
      `--replace-instance: the derived Workflow name ${newWorkflow} equals the Workflow ${where} records; a replace builds new resources and touches nothing old`,
    )
  return { ...opts, replace: { old: record } }
}
