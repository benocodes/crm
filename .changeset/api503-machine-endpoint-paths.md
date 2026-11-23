---
'@vibase/server-d1': minor
---

Three machine endpoints move to a stable shape, and the old paths are removed (no alias, no redirect): the Gmail connect callback `GET /oauth/google/callback` is now `GET /oauth/callback/google`, Gmail push `POST /gmail/push` is now `POST /inbound/gmail`, and Clerk's webhook `POST /webhooks/clerk` is now `POST /inbound/clerk`. Google sign-in's `/auth/callback/google` is unchanged. After upgrading, an operator updates three console settings: the Gmail OAuth client's authorised redirect URI to `https://<api-host>/oauth/callback/google`; the Pub/Sub push subscription's endpoint **and** token audience to `https://<api-host>/inbound/gmail` (a token minted for the old audience is refused `401`); and, where a Clerk webhook is set, its endpoint to `https://<api-host>/inbound/clerk`.
