/**
 * The two surfaces of the API ([[API32]]): records under `/api/v1`, organisation configuration under `/meta/v1`.
 * Operations and definitions keep surface-relative paths; only the full path appears on the wire.
 */
export type Surface = 'api' | 'meta'

export const SURFACES: readonly Surface[] = ['api', 'meta']

/** D2: both surfaces start at v1. */
export const SURFACE_PREFIX: Readonly<Record<Surface, string>> = { api: '/api/v1', meta: '/meta/v1' }
export const API_PREFIX = SURFACE_PREFIX.api
export const META_PREFIX = SURFACE_PREFIX.meta

/** D4: the title of each surface's OpenAPI document. */
export const SURFACE_TITLE: Readonly<Record<Surface, string>> = { api: 'Vault records API', meta: 'Vault meta API' }

/** The path of a surface's OpenAPI document. */
export const openApiPath = (surface: Surface): string => `${SURFACE_PREFIX[surface]}/openapi.json`

/** D3: the wire path of an operation (or definition path) on its surface. */
export const fullPath = (op: { surface: Surface; path: string }): string => SURFACE_PREFIX[op.surface] + op.path
