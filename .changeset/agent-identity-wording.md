---
'@vibase/cli': patch
'@vibase/server-d1': patch
---

An agent account that claims its invitation now sees "Your agent account is ready" with how to sign in (`vibase login`, MCP or the SDK) instead of "No access to this workspace". The CLI's owner-login warning names both routes for an agent identity: an invitation for an agent that can use a browser, and `agents create` with `api-keys create` for a headless one.
