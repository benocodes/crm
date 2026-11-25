export interface SessionTokenOptions {
  url: string
  fetch?: typeof fetch
  cookie?: string | (() => string | null | Promise<string | null>)
}
export function sessionToken(_options: SessionTokenOptions): () => Promise<string | null> {
  throw new Error('not implemented')
}
