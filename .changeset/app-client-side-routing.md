---
'@vibase/server-d1': minor
---

The workspace app at `/home`, `/accounts` and `/agents` is now a single-page app: moving between its pages no longer reloads the browser, and the sign-in session and workspace are read once per visit. Deep links and refresh work as before, and the window title and the current sidebar entry follow the page.
