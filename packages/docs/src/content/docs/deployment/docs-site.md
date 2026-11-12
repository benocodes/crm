---
title: Publish these docs
description: Build the Starlight documentation and configure Cloudflare Pages.
---

The documentation is an Astro site using Starlight in `packages/docs`. It builds static HTML, CSS, JavaScript, and a Pagefind search index.

## Develop locally

From the repository root:

```bash
pnpm install
pnpm -C packages/docs dev
```

Edit Markdown or MDX under `packages/docs/src/content/docs/`. Navigation lives in `packages/docs/astro.config.mjs` and theme colors in `packages/docs/src/styles/custom.css`.

The API reference is generated from the production router's OpenAPI documents before development, typechecking, and builds. It requires no running instance, database, or credentials. During an active dev session, regenerate after changing API code with `pnpm -C packages/docs openapi:generate`, or restart the docs server. The exported JSON lives in the ignored `public/openapi/` directory; edit the backend operation definitions to change the contract.

## Check the production build

```bash
pnpm -C packages/docs typecheck
pnpm -C packages/docs build
pnpm -C packages/docs preview
```

Search is generated during the production build; use the preview to check it.

## Configure Cloudflare Pages

The Vibase documentation is deployed to the `vibase-docs` Pages project using direct uploads, with `docs.vibase.ai` as its custom domain. Canonical URLs default to that origin. The settings below also describe how to set up a separate Pages project for a fork using Git integration.

Connect the repository to a Pages project using these settings:

| Setting | Value |
| --- | --- |
| Root directory | Repository root (leave blank) |
| Build command | `pnpm -C packages/docs build` |
| Build output directory | `packages/docs/dist` |
| `NODE_VERSION` | `22.21.1` or a later compatible Node 22 release |
| `PNPM_VERSION` | `10.7.0` |
| `DOCS_SITE_URL` | Your final documentation origin, such as `https://docs.example.com` |

Keep the repository root as the build root so Pages can install from the workspace lockfile. The site needs no backend bindings or secrets. Static output does not require an Astro Cloudflare adapter.

Set `DOCS_SITE_URL` to override the default `https://docs.vibase.ai` origin for a fork. Builds generate canonical URLs and a sitemap for the selected origin.

Cloudflare's [build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/) and [monorepo guide](https://developers.cloudflare.com/pages/configuration/monorepos/) explain these settings.
