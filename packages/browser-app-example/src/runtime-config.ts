// The one module that reads the build-injected constant (scripts/build.ts `define`); kept apart so tests and the build script can import settings.ts.
import type { AppConfig } from './settings.js'

declare const __APP_CONFIG__: AppConfig
export const config: AppConfig = __APP_CONFIG__
