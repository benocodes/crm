// Stub for the red commit (OPS240): the real guards land with the implementation.
export const CLIENT_MARKERS: readonly string[] = []
const todo = (): never => { throw new Error('not implemented') }
export const clientProblems = (_dir: string, _version: string): string[] => todo()
export const serverProblems = (_dir: string, _version: string): string[] => todo()
export const assertClientLayout = (_dir: string, _version: string): void => todo()
export const assertServerLayout = (_dir: string, _version: string): void => todo()
export const assertCommit = (_commit: string): void => todo()
export const assertExportsResolve = (_consumerRoot: string): { entry: string; resolved: string }[] => todo()
