---
"@vibase/server-d1": patch
---

Google sign-in on the built-in provider. With a complete Google client (`AUTH_GOOGLE_CLIENT_ID` and `AUTH_GOOGLE_CLIENT_SECRET`, else the Gmail client's `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; half of the `AUTH_GOOGLE_*` pair fails closed naming the variable) `/sign-in` and `/invite` show a "Continue with Google" button, and `/.well-known/vibase`'s `better-auth` block gains `sign_in_methods` (`["password"]` or `["password","google"]`). Google signs in an existing account whose email Google reports verified and equal; a new account is created only through a live invitation for the Google-verified email (the token rides Better Auth's OAuth state, never a URL), else the callback returns to `/sign-in?error=invitation_required`. The vault user's `email_verified` follows the Better Auth user. The redirect URI to register on the Google client is `<PUBLIC_BASE_URL>/auth/callback/google`.
