# Vibase documentation

Astro + Starlight, built as a static site for Cloudflare Pages.

The site describes Vibase as a headless, agentic CRM. Start with Concepts or the Clerk-backed quickstart.

From the repository root:

```bash
pnpm install
pnpm -C packages/docs dev
pnpm -C packages/docs typecheck
pnpm -C packages/docs build
pnpm -C packages/docs preview
```

Production is the Cloudflare Pages project `vibase-docs`, serving `docs.vibase.ai` (Pages origin: `vibase-docs.pages.dev`). Canonical URLs default to `https://docs.vibase.ai`; forks can override `DOCS_SITE_URL`. No adapter, bindings, or runtime credentials are needed for the static site.

The project uses direct uploads. To update it with a Wrangler login that has access to the owning Cloudflare account:

```bash
pnpm -C packages/docs typecheck
pnpm -C packages/docs build
pnpm -C packages/server-d1 exec wrangler --cwd ../docs pages deploy dist --project-name vibase-docs --branch main --commit-dirty=true
```

The last command uses the repository's existing Wrangler installation and runs in the docs directory. It deploys the local build, including uncommitted documentation changes, without deploying the API Worker. Keep account credentials out of the command line. The repo root's Cloudflare API token may have Worker access without Pages access; the existing Wrangler OAuth login supports Pages.

For a separate project using Pages Git integration: keep the repository root as the build root, build with `pnpm -C packages/docs build`, publish `packages/docs/dist`, and set `NODE_VERSION=22.21.1` and `PNPM_VERSION=10.7.0`.

Astro 6 and Starlight 0.38 are pinned for the repository's Node 22.21 runtime; newer Astro releases require a newer Node patch. Upgrade them together when upgrading the runtime.

Author public content in `src/content/docs/`; keep private knowledge notes and credentials outside this package. See `src/content/docs/deployment/docs-site.md` for publishing instructions.

## API reference

`dev`, `build`, and `typecheck` first run `openapi:generate`. The generator requests both public OpenAPI documents from the production `@vibase/api` router in process, using its single-workspace configuration. Storage execution throws: generation must never query a database or read credentials. No running server is required.

The unmodified documents are written to the ignored `public/openapi/api.json` and `public/openapi/meta.json`. `starlight-openapi` renders their operation pages and sidebars; the same JSON is published for download. Never hand-edit generated contracts. Run `pnpm -C packages/docs openapi:generate` after changing backend operations during an active dev session, or restart the docs server.
