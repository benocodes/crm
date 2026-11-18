---
'@vibase/server-d1': minor
---

The public form ingress handler (`handleFormIngress` in `@vibase/api`): answers `POST /f/{public_id}` and its CORS preflight from a request and injected Turnstile and rate-limit ports, in the order of the spec (limits, form, origin, validation, honeypot, blocklist, Turnstile, capture), with the uniform `202` for accepted, honeypot and blocked submissions. Not routed yet: no deployed behaviour changes until the Worker serves `/f/*`.
