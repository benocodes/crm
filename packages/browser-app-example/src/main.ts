// The entry: wires the build-injected settings and the browser's own fetch, location and storage into the page (app.ts), which a test drives with fakes.
import { run } from './app.js'
import { config } from './runtime-config.js'

void run(document.getElementById('app')!, { config, fetch: (input, init) => fetch(input, init), location })
