---
'@vibase/server-d1': minor
---

The workspace app's pages move under `/app`: Home is `/app/home`, Connected accounts `/app/accounts` and Agents `/app/agents`. `/`, `/app` and `/app/` redirect to `/app/home`. The old paths `/home`, `/accounts`, `/agents` and `/connect` (and anything below them) now answer `404`, with no redirect, so change any bookmark, link, or Clerk "after sign-in/out" URL that names one (a Clerk instance's after-sign-in URL is changed in the Clerk dashboard by hand). Signing in, accepting an invitation and the Google sign-in land on `/app/home`, and the Gmail connect flow returns to `/app/accounts` unless `CONNECT_RETURN_URL` is set. `/connect` is no longer a sign-in return target. `wrangler.jsonc`'s `assets.run_worker_first` lists `/`, `/app`, `/app/*`, `/assets/*` and the five auth pages; a deployed instance picks it up on its next deploy.
