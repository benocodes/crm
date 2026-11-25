export class VibaseError extends Error {
  constructor(status: number, code: string, message: string) {
    super(message)
    throw new Error('not implemented')
  }
}
export function isVibaseError(_value: unknown): _value is VibaseError {
  throw new Error('not implemented')
}
