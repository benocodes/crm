# vibase

One released version of the vibase product: the `vibase` command-line client, a prebuilt vault Worker for Cloudflare, the connect page, the D1 migrations and a base Worker config with no instance in it.

`release.json` lists the version, the source commit, the wrangler version this release was tested with and a sha256 of every file. The package installs that exact wrangler beside the `vibase` command.

```bash
npm install -g ./vibase-<version>.tgz
vibase --version
```

Node 22 or newer. Licence: AGPL-3.0-only.
