import type { AppConfig } from './config.js'
import type { Env, Session } from './session.js'
export async function loadSession(_config: AppConfig, _env: Env): Promise<Session> {
  throw new Error('not implemented')
}
