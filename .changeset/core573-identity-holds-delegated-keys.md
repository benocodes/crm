---
'@vibase/server-d1': patch
---

A mailbox's identity can no longer be broken or re-owned by a write that only needs `contacts:write`. Deleting an identity, or changing its `contact_id` or `own`, is refused with `409 identity_in_use` while a connected mailbox uses it (disconnect the mailbox first). Marking an address as one of your own (`own: true`), or giving an own address a contact, now needs a signed-in person: an agent gets `403 user_required`. An API key is no longer issued for a delegated agent (`409 delegated_agent`: it acts through its member's OAuth grant), and keys already issued for one stop working, with the answer a revoked key gets. Deleting a record, and merging contacts, no longer stop at 100 linked rows: each cascade handles up to 4,000 rows per kind of dependant in one request (past that, `400 set_limit_exceeded` as before).
