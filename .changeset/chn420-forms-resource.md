---
'@vibase/server-d1': minor
---

Migration `0023_forms.sql`: the `forms` table (website forms and their field mapping), with `form_allowed_origins` and `form_tags`, and a new owner-only `forms` resource on `/meta/v1/forms` (list, get, create, update, delete; `forms:read` for members, `forms:write` for owners, signed in). Each form is created with its own credential-less agent. Nothing receives a submission yet.
