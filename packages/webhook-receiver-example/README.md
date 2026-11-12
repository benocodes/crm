# webhook-receiver-example

A copyable Cloudflare Worker that turns a vault webhook into a Workflow ([[API7]] D21). It is the worked example for the
[webhooks guide](../docs/src/content/docs/guides/webhooks.md).

```text
vault ──POST (signed)──> Worker ──create({ id: webhook-id })──> Workflow
                          2xx at once                            read the message  (own agent key)
                                                                 draft a reply     (draftReply, yours to replace)
                                                                 propose it        (POST /api/v1/action-requests)
```

- `src/verify.ts`: Standard Webhooks verification with Web Crypto, no dependency.
- `src/receiver.ts`: verifies, starts one Workflow instance per event (the instance id is the event id, so a re-delivery cannot run twice), answers `2xx`.
  Other event types are acknowledged and ignored.
- `src/reply.ts`: the Workflow body. Four steps (`read-message`, `find-connection`, `draft-reply`, `propose-reply`), each returning plain data.
  It only reads inbound email and only proposes: the reply waits for a person or agent with `messages:write` to approve it.
- `src/vault.ts`: a small REST client. A `4xx` ends the step at once (`NonRetryableError`) except `408`, `409`, `425` and `429`; `5xx` and network errors retry.
- `draftReply` in `src/reply.ts` is a pure function. Put your model call (the Vercel AI SDK, for example) there.

To copy it: take `src/`, `wrangler.jsonc` and `.dev.vars.example`. Nothing under `src/` imports this repo.

## Set up (no Cloudflare account needed to try it locally)

1. In your vault, create an agent for the Workflow with the scopes `interactions:read`, `messages:read`, `connections:read`,
   `action_requests:read` and `messages:request_approval`, and an API key for it. Add `messages:write` instead of
   `messages:request_approval` only if you want the Workflow to send directly (change `propose-reply` to `POST /api/v1/messages/send`).
2. Copy `.dev.vars.example` to `.dev.vars` and set `VIBASE_URL` and `VIBASE_API_KEY`.
3. `pnpm -C packages/webhook-receiver-example dev` serves the Worker on `http://127.0.0.1:8789` with a local Workflow.
4. Subscribe an agent that holds `webhooks:write` and `events:read` (the default event type is `interaction.created`):

   ```bash
   curl -X POST "$VIBASE_URL/meta/v1/webhooks" -H "authorization: Bearer $AGENT_KEY" -H 'content-type: application/json' \
     -d '{"url":"http://127.0.0.1:8789/"}'
   ```

   A plain `http://` target needs `WEBHOOK_ALLOW_INSECURE_URLS=true` on the vault and is for local use only. The answer carries `secret` once: put it in `.dev.vars` as `WEBHOOK_SECRET` and restart the Worker.
5. The vault's per-minute cron dispatches and sends; the next inbound email starts a Workflow instance and, a moment later, a pending `messages.send` request appears under `/api/v1/action-requests`.

## Deploy (yours to run: it creates a Cloudflare resource)

```bash
pnpm -C packages/webhook-receiver-example build          # bundles with wrangler --dry-run, no login
cd packages/webhook-receiver-example
CLOUDFLARE_ACCOUNT_ID=... pnpm exec wrangler deploy      # add routes or a custom domain in wrangler.jsonc first
pnpm exec wrangler secret put WEBHOOK_SECRET
pnpm exec wrangler secret put VIBASE_API_KEY
```

Set `VIBASE_URL` in `wrangler.jsonc`, then subscribe the deployed `https://` URL.

## Tests

`pnpm -C packages/webhook-receiver-example test` runs the verifier against the vault's own signer and `standardwebhooks`, the receiver with a fake Workflow binding,
the Workflow against a fake vault with the workerd step shim, the copyability checks, and the guide's facts against the code's constants. The tests live in `scripts/`
(not `src/`) because they import the vault's packages; the example's own sources do not.
The end-to-end run (a real capture through workerd, no network) is `pnpm -C packages/server-d1 e2e:webhook-example`.
