---
"@vibase/server-d1": patch
---

Self-service password reset by email. With email configured (`EMAIL` binding and `AUTH_EMAIL_FROM`) on the built-in provider, `POST /auth/request-password-reset` is open (5 requests per hour per client IP), emails a one-hour reset link to a known address and answers the same for an unknown one (the send runs after the response); `/.well-known/vibase`'s `auth` block gains `self_service_reset`, and `/sign-in` shows "Forgot password?" when it is `true`. Owner-issued reset links are unchanged and never emailed; with email off nothing changes. A failed invitation or reset send now logs one line (event name and error code only), and the `502 email_send_failed` message no longer claims the invitation was dropped when the compensating revoke also failed.
