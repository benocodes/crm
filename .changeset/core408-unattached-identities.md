---
'@vibase/server-d1': minor
---

Migration `0022_unattached_identities.sql`: an identity may now be neither own nor a contact's (`contact_id` null, `own` false), the state a captured address takes when the contact policy does not qualify it. `identities.resolve` promotes such an identity to a new contact when it finds one. Nothing creates an unattached identity yet: capture behaves as before.
