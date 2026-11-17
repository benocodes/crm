---
'@vibase/server-d1': minor
---

A form's agent is now managed by its form: `agents.update` and `api_keys.create` refuse it with `409 form_principal`, renaming a form renames its agent, and deleting a form disables it, each in the form's own unit with an `agent.updated` event before the form's event.
