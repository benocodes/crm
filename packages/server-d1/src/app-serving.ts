// STUB (red commit): the real module lands with the implementation.
export interface AssetsLike {
  fetch(req: Request): Promise<Response>
}
export const appCsp = (_issuer?: string): string => ''
export const serveApp = async (_req: Request, _opts: { assets?: AssetsLike; issuer?: string }): Promise<Response | undefined> => undefined
