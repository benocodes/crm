---
'@vibase/server-d1': minor
---

An approval request now says what it asks for in the vault's own words. Every action request carries a `target_summary` (one line written when the request is created: the operation, the target record's name and the changed fields; for a send, the mailbox and recipients, with outside text quoted, stripped of hidden characters and shortened), and reads show who proposed it (`proposer_kind`, `proposer_name`, `proposer_acting_for` for a delegated agent) and, for a send, the `sending_mailbox`. The reference approvals app leads each card with them and shows the proposer's own reason below, labelled, clamped and without bidi controls. Migration `0030_action_request_target_summary` adds a nullable `action_requests.target_summary`; run `vibase-server upgrade` to apply it. Requests created before the upgrade have no summary and the app shows the operation name.
