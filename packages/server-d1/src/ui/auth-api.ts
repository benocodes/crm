// UI246 stub (red).
export interface ApiFailure {
  ok: false
  status: number
  code?: string
}
export type ApiResult<T> = { ok: true; data: T } | ApiFailure
export interface SessionUser {
  email: string
  name?: string
}
const stub = async (): Promise<ApiFailure> => ({ ok: false, status: -1 })
export const signUp = (_b: { name: string; email: string; password: string; invitation_token: string }): Promise<ApiResult<{ user?: SessionUser }>> => stub()
export const signIn = (_b: { email: string; password: string }): Promise<ApiResult<{ user?: SessionUser }>> => stub()
export const getSession = (): Promise<ApiResult<{ user: SessionUser } | null>> => stub()
export const signOut = (): Promise<ApiResult<unknown>> => stub()
export const resetPassword = (_b: { newPassword: string; token: string }): Promise<ApiResult<unknown>> => stub()
