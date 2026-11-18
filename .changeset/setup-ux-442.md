---
'@vibase/server-d1': patch
---

Setup UX: `vibase-server setup` and `upgrade` print one progress line per health poll and, when the host never answers, a hint about a stale local DNS cache; the Google OAuth client ID and secret are checked for a swapped pair before any step; the secrets step says present secrets are kept and names `--rotate-secrets`; the owner invitation is printed in a closing "Claim your instance" block after verify.
