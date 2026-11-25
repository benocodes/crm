-- CORE574 D6/D7: the capture fingerprint. A nullable lowercase-hex SHA-256 of what a captured message stores (its subject, sender and rendered body),
-- written by the connection pipeline so a second mail that reuses a known Message-ID with other content is told apart from a second copy of the same one.
-- NULL on every existing row, on reactions and on form submissions; a NULL fingerprint matches anything. Never exposed (no resource field, filter, sort, event or schema entry).
ALTER TABLE messages ADD COLUMN content_sha256 TEXT CONSTRAINT messages_content_sha256 CHECK (content_sha256 IS NULL OR (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'));
