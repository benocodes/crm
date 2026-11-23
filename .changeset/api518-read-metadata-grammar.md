---
'@vibase/server-d1': patch
---

The scope grammar accepts the action `read_metadata` and a scope set closes `x:read` to `x:read_metadata` wherever the vault declares it. Nothing declares one yet, so no grant or token can carry it and every caller sees what it saw before; asking for `messages:read_metadata` is refused as an undeclared scope.
