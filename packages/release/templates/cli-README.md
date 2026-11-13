# @vibase/cli

`vibase`, the command line of a vibase server: every operation the server offers, as a command. It has no dependencies and deploys nothing.

```bash
npm install -g @vibase/cli@<version>
vibase --version
vibase login --server <url>
```

Until the package is on the registry, install the tarball of the release by file: `npm install -g ./vibase-cli-<version>.tgz`.

Running an instance (setup, status, upgrade) is the job of the separate server package, `@vibase/server-d1`: `npx @vibase/server-d1@<version> <command>`.

Node 22 or newer. Licence: AGPL-3.0-only.
