---
title: Webhooks
description: Have your instance call your workflow engine when something happens, and write a receiver that is safe against retries.
---

A webhook is how your instance tells your own workflow engine that something happened. The vault does not run automations: it delivers a signed event to a URL you choose, and your engine (a Cloudflare Workflow, n8n, Windmill, or any HTTP endpoint) does the work with its own agent credentials.

A complete, copyable receiver for Cloudflare Workers lives in the repository at `packages/webhook-receiver-example`. It verifies the request, starts a Workflow, answers at once, and the Workflow reads the new email and proposes a reply for approval.

## Subscribe

An agent subscribes with `POST /meta/v1/webhooks`. It needs `webhooks:write` to manage subscriptions and `webhooks:read` to list them and see their deliveries. It also needs `events:read` and the read scope of every event type it subscribes to, because a subscription delivers exactly what that agent could read from the event feed.

```bash
curl -X POST "$VIBASE_URL/meta/v1/webhooks" \
  -H "authorization: Bearer $AGENT_KEY" -H "content-type: application/json" \
  -d '{"url":"https://hooks.example.com/vibase"}'
```

- Without `event_types`, a subscription receives `interaction.created`. Pass up to 20 exact types, for example `["interaction.created","task.created"]`.
- The answer carries the signing secret (`whsec_` followed by base64) once. Store it as a secret of your receiver. `POST /meta/v1/webhooks/{id}/rotate-secret` makes a new one and keeps the old one signing for 24 hours, so you can change the receiver without losing deliveries.
- A subscription starts at the newest event when it is created. It delivers what happens after, not history.
- The target must be `https://`. A single agent may hold up to 10 subscriptions.
- `PATCH /meta/v1/webhooks/{id}` pauses (`status: "paused"`), resumes or edits it; `DELETE` removes it.

## What a delivery looks like

Every delivery is a `POST` with a JSON body and three Standard Webhooks headers:

| Header | Value |
|---|---|
| `webhook-id` | The event id. The same id on every attempt for that event. |
| `webhook-timestamp` | Unix seconds when this attempt was signed. |
| `webhook-signature` | `v1,<base64>` for each secret in force, separated by spaces (two during a rotation overlap). |

The body is the record `events.get` returns: the event `id`, `type`, `resource_type`, `resource_id`, `actor_id`, `before`, `after` and `created_at`. It carries ids and the changed fields, not message bodies or other content. Your workflow fetches what it needs with its own agent key, which is also why a delivery cannot leak more than that agent may read.

## Verify the signature

The signed text is `<webhook-id>.<webhook-timestamp>.<raw body>`, signed with HMAC-SHA256 keyed by the decoded `whsec_` secret. Verify against the raw body before parsing it. Accept the request if any `v1` signature matches, ignore other versions, and refuse a timestamp more than 5 minutes from your clock, in either direction.

With the `standardwebhooks` package:

```ts
import { Webhook } from 'standardwebhooks'

const wh = new Webhook(env.WEBHOOK_SECRET) // the whsec_... string
const event = wh.verify(rawBody, {
  'webhook-id': request.headers.get('webhook-id')!,
  'webhook-timestamp': request.headers.get('webhook-timestamp')!,
  'webhook-signature': request.headers.get('webhook-signature')!,
}) // throws when the signature or the timestamp is wrong
```

In a Worker you can do the same with Web Crypto and no dependency: `packages/webhook-receiver-example/src/verify.ts` is about forty lines.

## Answer fast, then work

Do nothing in the request except verify and hand off. The vault waits 10 seconds for an answer and counts a slower one as a failure.

- Any `2xx` is success. Everything else is a failure and is retried: a `4xx` or `5xx` status, a timeout, a connection error, and a redirect (`3xx`; redirects are not followed).
- At this release `410 Gone`, `429` and a `Retry-After` header are ordinary failures like the rest: they are retried on the schedule below and change nothing else.
- Return `5xx` when you could not start the work, so the vault retries. Return `2xx` when the work is already started or not wanted.

Delivery is **at least once and unordered**. The same event can arrive twice, and two events can arrive in either order. Use `webhook-id` as the idempotency key. In Cloudflare Workflows that is free: start the instance with `id` set to the `webhook-id`, treat "instance already exists" as success, and a re-delivery cannot run the work twice.

```ts
try {
  await env.WORKFLOW.create({ id: webhookId, params: event })
} catch (error) {
  // "already exists" means this event was started before: still answer 2xx
}
return new Response('ok') // 200
```

When order matters, read the feed in order instead of trusting arrival order.

## Retries and failed deliveries

The vault sends from its per-minute schedule. A failed attempt is retried after 30 seconds, 5 minutes, 30 minutes, 2 hours, 6 hours, 12 hours, 24 hours (give or take 20 percent; a delay shorter than a minute waits for the next one). That is 8 attempts over about 45 hours. A delivery that fails every attempt is marked `dead`.

`GET /meta/v1/webhooks/{id}/deliveries` lists deliveries with `status` (`pending`, `delivered`, `dead` or `cancelled`), `attempts`, `last_status_code` and `last_error`. The error codes are:

- `timeout`: no answer in 10 seconds.
- `connection_failed`: the connection failed or was refused.
- `http_status`: the answer was not a `2xx`; see `last_status_code`.
- `redirect`: the answer was a `3xx`.
- `sender_failed`: the vault could not sign or send, or the delivery used up its attempts.
- `cancelled_subscription`: the subscription was deleted before the delivery was sent.
- `cancelled_scope`: the subscribing agent lost `events:read` or the right to see that event, or was disabled.

Response bodies are never stored. At this release the vault does not disable a subscription or delete old deliveries on its own, whatever the receiver answers.

## Catch up after downtime

Push is a convenience over the event feed, not a replacement for it. If your receiver was down long enough for deliveries to go `dead`, or you are starting fresh, read the feed from the last event you processed:

```bash
curl "$VIBASE_URL/api/v1/events?type=interaction.created&after=$LAST_EVENT_ID&limit=100" \
  -H "authorization: Bearer $AGENT_KEY"
```

Pass the response's `next_cursor` as `after` until it is `null`. `vibase events tail` does the same from the command line and can follow new events. Start the same idempotent workflow for each event, with the event id as the instance id, so a caught-up event and a pushed event share one path.

## Scopes at a glance

| Who | Scopes |
|---|---|
| The subscribing agent | `webhooks:write`, `webhooks:read`, `events:read`, and the read scope of each subscribed type (`interactions:read` for `interaction.created`) |
| The workflow's agent (the example) | `interactions:read`, `messages:read`, `connections:read`, `action_requests:read`, and `messages:request_approval` to propose a reply (`messages:write` to send directly) |

The two can be the same agent or different ones. Keeping them apart means the key your workflow engine holds cannot change subscriptions.

## Operating an instance

- Webhook secrets are sealed with `CREDENTIALS_KEY` (base64 of 32 random bytes). Without it, creating or rotating answers `501 webhooks_not_configured`.
- `WEBHOOK_ALLOW_INSECURE_URLS=true` allows `http://` and loopback targets. Use it for local development only.
- Each minute's run has a work budget. `CRON_TICK_BUDGET` raises it from the default of 50 to as much as 1000 when you have many subscriptions and your plan allows the extra calls.
- On a remote environment, run the database migrations before deploying a Worker that includes webhooks, and run `setup:remote` so the Clerk scope mirror knows the new `webhooks:*` and `events:read` scopes.
