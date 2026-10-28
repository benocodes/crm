// Stub (red phase).
export const PLACEHOLDER_DATABASE_ID = '00000000-0000-0000-0000-000000000000'
export class RemoteRefusal extends Error {}
export const REPO_ROOT = ''
export const ROOT_ENV_PATH = ''
export const CONFIG_PATH = ''
export interface D1BindingConfig { binding: string; database_name?: string; database_id?: string; remote?: boolean; preview_database_id?: string }
export interface ConfigLike { name?: string; d1_databases?: D1BindingConfig[] }
export interface Target { env: string; workerName: string; databaseName: string; databaseId: string }
export interface Cmd { command: string; args: string[] }
export function parseEnvFlag(_argv: string[]): string { throw new Error('not implemented') }
export function requireConfirm(_env: NodeJS.ProcessEnv): void { throw new Error('not implemented') }
export function loadRootEnv(_path?: string): void { throw new Error('not implemented') }
export function resolveTarget(_config: ConfigLike, _envName: string): Target { throw new Error('not implemented') }
export function migrateCommands(_envName: string): Cmd[] { throw new Error('not implemented') }
export function deployCommands(_envName: string, _sha: string): Cmd[] { throw new Error('not implemented') }
