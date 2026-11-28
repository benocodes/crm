---
title: Install from a release tarball
description: Install the server package from a release's tarball, after checking it against the release's checksums.
---

Use this when you want to install a release file instead of fetching the package from npm.

Versions are listed on the repository's Releases page; each release carries three tarballs (CLI, server and SDK) and a `SHA256SUMS` file. Download them and check the checksums first (`sha256sum -c SHA256SUMS`, or `shasum -a 256 -c SHA256SUMS` on macOS):

```bash
npm install -g ./vibase-server-d1-<version>.tgz
vibase-server --help
```

Everything else works as in [Deploy Vibase](/deployment/self-hosting/): the installed package is the version that deploys. The same goes for the command line client, `vibase-cli-<version>.tgz`.
