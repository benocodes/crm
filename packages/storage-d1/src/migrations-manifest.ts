// The core D1 migrations this build expects ([[CORE61]] D2): wrangler records each applied file by name in `d1_migrations`,
// and the Worker compares names only. The hash is the immutability record, checked against the files by
// `migrations-manifest.test.ts` (D5). Add a new file here in the same change that creates it.
export const MIGRATIONS: readonly { readonly name: string; readonly sha256: string }[] = [
  { name: '0001_genesis.sql', sha256: '90d886dba20ac1e817dd9756fd859aa71f5fde0d2cfddf41b5c067d033aff73b' },
]
