// The core D1 migrations this build expects ([[CORE61]] D2): wrangler records each applied file by name in `d1_migrations`,
// and the Worker compares names only. The hash is the immutability record, checked against the files by
// `migrations-manifest.test.ts` (D5). Add a new file here in the same change that creates it.
export const MIGRATIONS: readonly { readonly name: string; readonly sha256: string }[] = [
  { name: '0001_genesis.sql', sha256: '311fb2f9fb9e39fe9f3bbe59415fa622b4800f3772f6ebf6d252e5dcceb27f92' },
]
