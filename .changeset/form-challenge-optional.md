---
'@vibase/server-d1': minor
---

A form's visitor check is now its own setting. `forms.challenge` is `none` or `turnstile`: a new form defaults to `none` (open, still behind the honeypot, origin allow-list, blocklist and rate limits), `turnstile` requires a passed Cloudflare Turnstile token as before. Migration `0027_form_challenge` adds the column and gives every existing form `turnstile`, so no form's behaviour changes; run `vibase-server upgrade` to apply it. Set it with `forms.create` / `forms.update` (`challenge`).
