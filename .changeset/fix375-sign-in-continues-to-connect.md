---
"@vibase/server-d1": patch
---

A finished sign-in (password, Google, or an invitation claim) now continues to `/connect` instead of stopping on the `/sign-in` "Signed in" view; a valid `return_to` such as `/device` is still honoured, including through Google sign-in.
