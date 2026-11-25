import { mkdir, writeFile } from 'node:fs/promises'
import { generateSdk, loadDocuments } from './index.js'

const directory = new URL('../generated/', import.meta.url)
const generated = await generateSdk(await loadDocuments())
await mkdir(directory, { recursive: true })
await writeFile(new URL('operations.ts', directory), generated.operations)
await writeFile(new URL('types.ts', directory), generated.types)
console.log('Generated src/generated/operations.ts and src/generated/types.ts')
