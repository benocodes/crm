import openapiTS, { astToString } from 'openapi-typescript'
import type { Translator } from './emit.js'

/** The repo generator's translator: the pinned openapi-typescript's text for one document (DX694 D4; the core takes it injected). */
export const openapiTranslator: Translator = async (document) => astToString(await openapiTS(document as never))
