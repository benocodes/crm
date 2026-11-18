// STUB (red commit)
export interface NavContext { provider: string | null; scopes: readonly string[] }
export interface NavRow { label: string; href: string; icon?: unknown; visible?: (ctx: NavContext) => boolean }
export const NAV: NavRow[] = []
export const visibleNav = (_rows: readonly NavRow[], _ctx: NavContext, _path: string): { label: string; href: string; icon?: unknown; current: boolean }[] => []
