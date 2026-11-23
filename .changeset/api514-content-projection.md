---
'@vibase/server-d1': patch
---

A message's content fields (`preview`, `attachments`) are now declared on the `messages` resource and shown only to a caller with `messages:read`: the record schema in the OpenAPI document marks them optional, and `schema.get` lists them under the resource's `content` key. Every caller today holds `messages:read`, so records, events and webhook payloads are unchanged.
