-- CORE666 D4: the list a delegated agent's latest sign-in approved (closed, agent-grantable), written by the authenticator when a token carries a list that differs from this one. It is how a refresh or a same-list sign-in is
-- told from a new consent without touching `scopes`, which an owner may have narrowed since. Machinery: never in the agent record, an API answer, an event payload or `schema.get`. Nullable and never backfilled: an existing
-- delegated agent reads NULL and is corrected by its next request; an agent account and an API-key agent keep NULL for good.
ALTER TABLE agents ADD COLUMN consented_scopes TEXT CONSTRAINT agents_consented_scopes CHECK (consented_scopes IS NULL OR (json_valid(consented_scopes) AND json_type(consented_scopes) = 'array'));
