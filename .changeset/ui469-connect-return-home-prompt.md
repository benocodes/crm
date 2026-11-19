---
'@vibase/server-d1': minor
---

The Gmail connect flow returns to the instance's own Connected accounts page. With `CONNECT_RETURN_URL` unset and the app served, the callback now redirects to `<PUBLIC_BASE_URL or the request's origin>/accounts` (with `connection_id` on success or `error=<code>` on a refusal) instead of showing the built-in result page; a set `CONNECT_RETURN_URL` still wins, and an instance without the app keeps the built-in page. Home's Get started now offers **Connect your email**, a link to Connected accounts, to a person who may connect a mailbox and owns none.
