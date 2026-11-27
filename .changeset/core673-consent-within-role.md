---
'@vibase/server-d1': minor
---

A person can approve for a connector only what their role holds. On the built-in sign-in the consent page shows the permissions the signed-in account cannot approve as off and disabled ("Your role in this workspace doesn't include this" for a person, "This agent account hasn't been granted this" for an agent account), and the server cuts an accepted consent to the requested permissions the account holds, so a hand-made request naming more is narrowed, not refused. If the page cannot load what the account may approve it offers Deny only. A raised role reaches a connector through its next consent. The page reads the list from a new same-origin `GET /auth/consent-bound` (session cookie, `401` without one). The CLI device login and Clerk are unchanged.
