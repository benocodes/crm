// The control-plane migrations this build expects ([[CORE259]] D4): the control database's own compiled set, tracked in its own `d1_migrations`, separate from the CRM
// manifest ([[CORE61]]). "Current" means applied equals this list exactly. The hash is the immutability record, checked against the files by
// `control-migrations-manifest.test.ts`. Add a new file here in the same change that creates it. Control 0001 is generated: `pnpm -C packages/auth schema:generate --write`.
export const CONTROL_MIGRATIONS: readonly { readonly name: string; readonly sha256: string }[] = [
  { name: '0001_control_plane.sql', sha256: '2f54a315aa523c3dcef2358ae7982da9fc72661845af313d7805eff68c85dcaf' },
  { name: '0002_invitations.sql', sha256: '6182163772f257d9487b4fe5fb19093edaf18ea691696fe088acd8677dce3a36' },
  { name: '0003_invitation_delivery.sql', sha256: '10feb53551cea58bf897c1cbfc3ec9dfe6aca252a0a0fd9892596433e6ed4d00' },
  { name: '0004_webhooks.sql', sha256: '833caef3886afe7a2068a7d1c23e96fe1a0e163fb8f870f4a4d1b9638ccb5e68' },
  { name: '0005_api_keys.sql', sha256: '3e6143b61f4447dabd995f9016afafe678ba28ba0ebcca921cd459a8deb8fed8' },
]
