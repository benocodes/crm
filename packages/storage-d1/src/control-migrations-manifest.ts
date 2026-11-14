// The control-plane migrations this build expects ([[CORE259]] D4): the control database's own compiled set, tracked in its own `d1_migrations`, separate from the CRM
// manifest ([[CORE61]]). "Current" means applied equals this list exactly. The hash is the immutability record, checked against the files by
// `control-migrations-manifest.test.ts`. Add a new file here in the same change that creates it. Control 0001 is generated: `pnpm -C packages/auth schema:generate --write`.
export const CONTROL_MIGRATIONS: readonly { readonly name: string; readonly sha256: string }[] = [
  { name: '0001_control_plane.sql', sha256: '2f54a315aa523c3dcef2358ae7982da9fc72661845af313d7805eff68c85dcaf' },
  { name: '0002_invitations.sql', sha256: '6182163772f257d9487b4fe5fb19093edaf18ea691696fe088acd8677dce3a36' },
]
