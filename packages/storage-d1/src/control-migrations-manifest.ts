// The control-plane migrations this build expects ([[CORE259]] D4): the control database's own compiled set, tracked in its own `d1_migrations`, separate from the CRM
// manifest ([[CORE61]]). "Current" means applied equals this list exactly. The hash is the immutability record, checked against the files by
// `control-migrations-manifest.test.ts`. Add a new file here in the same change that creates it. Control genesis opens with the Better Auth DDL that `pnpm -C packages/auth schema:generate` prints ([[CORE678]] D6).
export const CONTROL_MIGRATIONS: readonly { readonly name: string; readonly sha256: string }[] = [
  // AGT701 D14, ruling 701.27: genesis reopened before v0.3.0 for `invitations.agent_id` (old hash fc56fdaf...).
  { name: '0001_genesis.sql', sha256: '874abb896b0ab1a2ec4534debff8e1183baf3bff4ff6237f06be4adc5eccba9a' },
]
