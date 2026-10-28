// The open-only check (spec CORE38 D14): the open packages install, typecheck and test with no enterprise package.
export const OPEN_PACKAGES = ['storage', 'storage-d1', 'api', 'server-d1'] as const
export const ENTERPRISE_PACKAGES = ['db', 'storage-postgres', 'server-postgres'] as const
export const ENTERPRISE_SPECIFIERS = ['pg', '@vault/db', '@vault/storage-postgres', '@vault/server-postgres'] as const
export interface PackageJson { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; [key: string]: unknown }

const nope = (): never => {
  throw new Error('not implemented')
}
export function classifyPackages(_dirs: readonly string[]): { open: string[]; enterprise: string[] } { return nope() }
export function openManifest(_manifest: PackageJson): PackageJson { return nope() }
export function productionTsconfig(): { extends: './tsconfig.json'; exclude: string[] } { return nope() }
