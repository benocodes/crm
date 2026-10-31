// The core D1 migrations this build expects ([[CORE61]] D2): wrangler records each applied file by name in `d1_migrations`,
// and the Worker compares names only. The hash is the immutability record, checked against the files by
// `migrations-manifest.test.ts` (D5). Add a new file here in the same change that creates it.
export const MIGRATIONS: readonly { readonly name: string; readonly sha256: string }[] = [
  { name: '0001_typed_storage_core.sql', sha256: '840803636a61ff83981a1167fcf1f821028be70e401f60e92c52a56e35aa2b28' },
  { name: '0002_identity_model.sql', sha256: '07e1acd7c69725566cbc1f4c1f1ff679901fc674604e47e9ee0994a507834e04' },
  { name: '0003_administration.sql', sha256: '0bb874b36add95daf240289cdecaab72f33771c38d2a9ecd9cc64562e4307298' },
  { name: '0004_messaging_model.sql', sha256: 'f0f593123db2e36be74679eec659a723c68fe6127c9d96a541416a885afabe18' },
]
