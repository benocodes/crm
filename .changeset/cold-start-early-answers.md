---
'@vibase/server-d1': patch
---

A cold Worker answers an unauthenticated `POST /mcp` (the 401 and its challenge), the two protected-resource documents and the authorization-server metadata from its variables alone, before it loads the application or reads a database, so Claude's 5-second connector check no longer times out on a fresh isolate. On a fresh deploy the `/mcp` 401 went from about 0.5 s to 0.14 s and the metadata from 0.6 s to 0.07 s (from a colo next to the database; the saving grows with the distance to it). Built-in provider only; every other request, and any request with a credential, takes the full path as before.
