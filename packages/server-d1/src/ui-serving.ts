// UI246 stub (red): the real module lands in the green commit.
export interface AssetsLike {
  fetch(req: Request): Promise<Response>
}
export const UI_PAGE_PATHS: readonly string[] = []
export const UI_PREFIX = '/ui'
export const UI_CSP = ''
export const UI_RUN_WORKER_FIRST: readonly string[] = []
export const isUiPath = (_pathname: string): boolean => false
export async function serveUi(_req: Request, _opts: { assets?: AssetsLike }): Promise<Response | undefined> {
  return undefined
}
