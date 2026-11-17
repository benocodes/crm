---
'@vibase/server-d1': minor
---

A form now carries its allowed origins and tags: `forms.create` and `forms.update` take `allowed_origins` (at most 20 normalised https origins) and `tag_ids` (at most 20 live tags), each replaced whole, and `forms.get`, `forms.list` and the `form.*` events show both lists.
