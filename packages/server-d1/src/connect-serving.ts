// Stub (red commit): the implementation follows.
export interface AssetsLike {
  fetch(req: Request): Promise<Response>
}

export function connectCsp(_issuer?: string): string {
  return ''
}

export async function serveConnect(_req: Request, _opts: { assets?: AssetsLike; issuer?: string }): Promise<Response | undefined> {
  return undefined
}
