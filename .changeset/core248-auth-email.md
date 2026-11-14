---
"@vibase/server-d1": minor
---

Optional auth email. With the `EMAIL` (`send_email`) binding and an `AUTH_EMAIL_FROM` variable both present on the built-in provider, `invitations.create` emails the invitation (the new `delivery` field defaults to `email` and the answer has no `url`; `delivery: "link"` returns the link as before; `email` while email is off is `501 email_not_configured`; a failed send revokes the invitation and answers `502 email_send_failed`). Accepting an emailed invitation records the address as verified. `invitations.list` returns `delivery`. Control migration `0003` adds `invitations.delivery` (existing rows are `link`): run `vibase-server upgrade` before using it. One variable without the other, or a malformed address, fails closed. With neither, nothing changes.
