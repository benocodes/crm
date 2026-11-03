/** A failure with its exit code ([[API6]] D8): `1` the API or the network, `2` usage or configuration. */
export class CliError extends Error {
  constructor(
    readonly exit: 1 | 2,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
/** A usage or configuration error: exit `2`. */
export const usage = (message: string, code = 'usage') => new CliError(2, code, message)
