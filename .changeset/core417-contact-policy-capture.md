---
'@vibase/server-d1': minor
---

Mail capture now applies each mailbox's `contact_creation` setting: with `sent` or `none`, addresses the setting does not qualify are recorded without a contact, and a later qualifying capture gives them one.
