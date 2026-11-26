---
title: Website forms
description: Post a contact form from your own site straight into your instance, with an optional Turnstile check, and know every answer the endpoint gives.
---

A form turns a website's contact form into a conversation in your instance. A person or an agent creates the form in the workspace (`forms.create`: its name, which field is the email, which the name, the consent wording, the origins allowed to post to it, and the tags to add). The form gets a **public id**, `frm_` followed by 26 characters. Your site posts to that id. There is nothing to install on the site beyond the HTML or the few lines of JavaScript below.

This endpoint is for browsers. It is not in the API reference and not an MCP tool: agents read what arrives through the normal tools (`threads`, `messages`, `interactions`, filtered on `channel` = `form`) or through a webhook on `interaction.created`.

## The endpoint

```
POST https://<your-instance>/f/<public_id>
Origin: https://www.example.com
Content-Type: application/x-www-form-urlencoded
```

- It needs no `Authorization` header. The public id is not a secret. What protects the form is the **allowed origins** list, the honeypot, the rate limits and, when the form's `challenge` is `turnstile`, the Turnstile check.
- `Content-Type` is one of three: `application/x-www-form-urlencoded` (a plain HTML form), `multipart/form-data` (text parts only: a file part is refused) or `application/json` (an object whose values are strings, numbers, booleans or arrays of strings).
- The browser sets `Origin` for you. It must equal one of the form's allowed origins exactly (scheme, host and port, no trailing slash), or the answer is `403 origin_not_allowed` and nothing is stored.
- A browser asks first with `OPTIONS /f/<public_id>` (a preflight). For an allowed origin the answer is `204` with the CORS headers that let the page read the result; for any other origin it is `403`.

## Caps

A submission that goes past a cap is refused with `400`, `413` or `415`, and nothing is stored.

| Limit | Value |
|---|---|
| Body | 32 KiB (32768 bytes) |
| Fields | 50 per submission |
| Field name | 1 to 64 characters, no control characters |
| Value | 5,000 characters (surrounding whitespace is trimmed) |
| Repeated field or array | 20 values |

Each form also has two rate limits, counted before anything else is read: 10 requests a minute from one IP address to one form, and 60 a minute to one form from everywhere. Past either one the answer is `429 rate_limited` with `Retry-After: 60`. A preflight counts too.

## Reserved fields

These names belong to Vibase. They are consumed by the endpoint, never stored as answers and never matched to the form's email, phone or name field.

| Field | What it does |
|---|---|
| `cf-turnstile-response` | The Turnstile token. Required only when the form's `challenge` is `turnstile`: the widget adds it for you. Ignored on a form with `challenge: none`. |
| `_vb_hp` | A honeypot. Hide this input from people with CSS. A value in it is treated as a bot: the answer is the same `202`, and nothing is stored. |
| `_vb_consent` | Consent given: `true`, `on`, `yes` or `1`. It is stored with the form's consent wording at the time. |
| `_vb_anonymous_id` | An optional id from your site (1 to 128 letters, digits and `_ . : -`), stored with the submission. An invalid one is dropped. |

Every name that starts with `_vb_` is reserved the same way, so do not name your own fields with that prefix. Every other field is an answer: it is shown on the message in the order it was sent.

## A plain HTML form

The Turnstile widget adds the token field to the form by itself.

```html
<form action="https://crm.mycompany.com/f/frm_xxxxxxxxxxxxxxxxxxxxxxxxxx" method="post">
  <input name="name" placeholder="Your name" />
  <input name="email" type="email" placeholder="Email" required />
  <textarea name="message" placeholder="How can we help?"></textarea>
  <input name="_vb_hp" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true" />
  <label><input type="checkbox" name="_vb_consent" /> I agree to be contacted.</label>
  <div class="cf-turnstile" data-sitekey="YOUR_TURNSTILE_SITE_KEY"></div>
  <button>Send</button>
</form>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
```

A plain post navigates the page to the JSON answer. To stay on the page, send it with `fetch`.

## With `fetch`

```html
<form id="contact">
  <input name="name" /> <input name="email" type="email" required />
  <textarea name="message"></textarea>
  <div class="cf-turnstile" data-sitekey="YOUR_TURNSTILE_SITE_KEY"></div>
  <button>Send</button>
  <p id="result"></p>
</form>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<script>
  document.querySelector('#contact').addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = event.target
    const res = await fetch('https://crm.mycompany.com/f/frm_xxxxxxxxxxxxxxxxxxxxxxxxxx', {
      method: 'POST',
      body: new FormData(form), // multipart/form-data; the widget's token is in it
    })
    document.querySelector('#result').textContent = res.status === 202 ? 'Thanks, we got it.' : 'Something went wrong, try again.'
    if (res.status !== 202) window.turnstile?.reset() // a token works once
  })
</script>
```

`FormData` posts as `multipart/form-data`. To send JSON instead, add `cf-turnstile-response` to the object yourself, from `turnstile.getResponse()`, and set `content-type: application/json`.

## Every answer

An answer is JSON. An error is `{"error": {"code": ..., "message": ...}}`.

| Status and code | When |
|---|---|
| `202 received` | Accepted. The answer is the same when the honeypot was filled, when the sender is on the workspace blocklist and when the address is already a contact, so a bot learns nothing. The body is `{"status": "received"}`. |
| `204` (preflight) | The answer to `OPTIONS` from an allowed origin, with the CORS headers. |
| `400 validation_error` | The body could not be read, a cap was passed, or the email or phone is not valid. |
| `403 origin_not_allowed` | `Origin` is missing or not one of the form's allowed origins. No CORS headers. |
| `403 challenge_failed` | The form's `challenge` is `turnstile` and the token is missing, wrong, used twice, or was issued for another site. |
| `404 not_found` | No such form, or it is disabled. |
| `405 method_not_allowed` | Only `POST` and `OPTIONS` are answered. |
| `413 payload_too_large` | The body is over 32 KiB. |
| `415 unsupported_media_type` | The `Content-Type` is none of the three. |
| `429 rate_limited` | Too many requests. Wait `Retry-After` seconds (60). |
| `503 challenge_unavailable` | The form's `challenge` is `turnstile` and the instance could not check the token (no Turnstile secret, or Cloudflare did not answer). Nothing is stored. Try again. |
| `503 temporarily_unavailable` | The submission could not be recorded. Nothing is stored. Try again. |

A `503 migrations_pending` or `503 not_initialised` can also come from the instance itself before the endpoint is reached: the owner has not finished setting it up. These carry no CORS headers, so a browser sees them as a failed request.

Answers before the origin is checked (`405`, `413`, `415`, `429`, `404`, and the instance's own `503`s) carry no CORS headers either: the page cannot read them, only see that the request failed.

## The visitor check

Each form has a `challenge` setting: `none` or `turnstile`. A new form is `none`: anyone may post from an allowed origin, behind the honeypot, the blocklist and the rate limits. That suits an open lead form, and a visitor never meets a challenge. A form that has been a target of spam can be set to `turnstile` (`vibase forms update <id> --challenge turnstile`). Forms created before this setting existed keep `turnstile`.

On a `turnstile` form the endpoint fails closed: every submission needs a valid Turnstile token, and the check runs on your instance with its Turnstile secret (`TURNSTILE_SECRET_KEY`, set with `wrangler secret put`). The token must have been issued for the hostname of the page that posts, so create the widget for your site's domain. For a trial, Cloudflare publishes test keys: the always-pass secret `1x0000000000000000000000000000000AA` accepts only the token `XXXX.DUMMY.TOKEN.XXXX` and answers for `example.com`, so a test form must be on an allowed origin of `https://example.com`.
