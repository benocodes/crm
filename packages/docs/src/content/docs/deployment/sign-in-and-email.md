---
title: Google sign-in and email
description: Turn on Sign in with Google, and what to expect while email is off.
---

## Sign in with Google (optional)

Google sign-in is off until the Worker has a Google OAuth client. Put both `AUTH_GOOGLE_CLIENT_ID` and `AUTH_GOOGLE_CLIENT_SECRET` in the secrets file before you run setup (both or neither: setup refuses half a pair), and setup puts them on the Worker. When Google is on, the closing output lists one manual item that no program can do for you: add the redirect URI `https://<your host>/auth/callback/google` to that Google OAuth client. Google accepts the sign-in only after you do. A Google account joins the workspace only through an invitation sent to its verified email.

## Email is off by default

Email is not configured by setup. The statement setup prints, and which holds until you add an email sender yourself:

> Email is not configured: there is no self-service password reset. A member who forgets their password gets a reset link from an owner; an owner gets one from `vibase-server owner-reset` (needs this instance's Cloudflare credentials). Invitation links are printed for you to send.
