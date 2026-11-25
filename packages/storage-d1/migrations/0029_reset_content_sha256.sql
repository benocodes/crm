-- CHN193 D5 ([[AGT588]]): the capture fingerprint covers the stored subject, sender and rendered body, and this release changes what is stored (hidden
-- content and invisible characters are stripped at capture). Reset every fingerprint so a message stored before the change still matches any later copy
-- (CORE574 D6: a NULL fingerprint is "existing"). Fingerprints written from now on are computed over the stripped render. The rule for the next change
-- to the stored subject, sender or body: reset them in that release's migration. No event: content_sha256 is never exposed (CORE574 P3).
-- messages is append-only (0004 D41, recreated in 0024): the guard is dropped for this one UPDATE and recreated as it was.
DROP TRIGGER messages_append_only;

UPDATE messages SET content_sha256 = NULL;

CREATE TRIGGER messages_append_only BEFORE UPDATE ON messages
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;
