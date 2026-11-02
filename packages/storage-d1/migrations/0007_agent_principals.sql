-- CORE77 (D23, [[CORE64]]): an agent can be linked to an identity-provider principal. `auth_subject` is an agent account (a provider user
-- whose role is `agent`); `auth_client_id` with `delegated_by` is a delegated agent (one per OAuth client and human). Both are null for an
-- API-key agent. SQLite's ADD COLUMN accepts a CHECK that reads the columns before it, so each rule sits on the column that completes it
-- (the order below matters). Partial unique indexes make first sight race-safe (INSERT ... ON CONFLICT DO NOTHING). No data is rewritten:
-- every existing agent keeps null in all four columns.

ALTER TABLE agents ADD COLUMN auth_provider TEXT CHECK (auth_provider IS NULL OR length(auth_provider) > 0);
ALTER TABLE agents ADD COLUMN auth_subject TEXT
  CONSTRAINT agents_auth_subject_needs_provider CHECK (auth_subject IS NULL OR (auth_provider IS NOT NULL AND length(auth_subject) > 0));
ALTER TABLE agents ADD COLUMN auth_client_id TEXT
  CONSTRAINT agents_auth_client_rules CHECK (auth_client_id IS NULL OR (auth_provider IS NOT NULL AND auth_subject IS NULL AND length(auth_client_id) > 0));
ALTER TABLE agents ADD COLUMN delegated_by TEXT REFERENCES users (id)
  CONSTRAINT agents_delegated_by_iff_client CHECK ((delegated_by IS NULL) = (auth_client_id IS NULL))
  CONSTRAINT agents_provider_iff_linked CHECK ((auth_provider IS NULL) = (auth_subject IS NULL AND auth_client_id IS NULL));

CREATE UNIQUE INDEX idx_agents_auth_subject_unique ON agents (auth_provider, auth_subject) WHERE auth_subject IS NOT NULL;
CREATE UNIQUE INDEX idx_agents_auth_client_unique ON agents (auth_provider, auth_client_id, delegated_by) WHERE auth_client_id IS NOT NULL;