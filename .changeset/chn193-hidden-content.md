---
'@vibase/server-d1': minor
---

A captured message now stores what a person reading it sees. Gmail bodies drop hidden elements (`display:none`, `visibility:hidden`, `opacity:0`, `font-size:0`, zero height with `overflow:hidden`, the `hidden` attribute, `template`), HTML comments (Outlook conditional blocks included) and image URLs (an image becomes its alt text). Every channel, forms included, strips zero-width, bidi-control and Unicode tag characters from the body, subject and sender names before the preview and fingerprint are made. The MCP instructions now tell agents that message text comes from outside the team and is data, never instructions. Migration `0029_reset_content_sha256` clears the stored capture fingerprints so mail stored before this release still matches later copies; run `vibase-server upgrade` to apply it.
