// The one module that reads the build-injected constant (scripts/build.ts `define`); kept apart so tests and the build script can import config.ts.
import type { AppConfig } from './config.js'

declare const __APP_CONFIG__: AppConfig
export const config: AppConfig = __APP_CONFIG__
