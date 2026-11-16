---
"@vibase/server-d1": patch
---

API keys are authenticated against the control plane first. The Worker looks a key's hash up in control `api_keys`, reads its revocation, expiry and agent on every request (only the immutable key-to-agent mapping is cached per isolate), stamps `last_used_at` in control, and falls back to the CRM database's keys when control has none. No key is created in control yet, so existing keys keep working through the fallback.
