-- CORE318 D1 (cycle 1): the schemaless property bag on the four built-in objects. `additional_props` is a JSON object as text, `{}` when empty, never NULL.
-- The database checks only that it is an object (D3: the value and size limits live in API validation, because a CHECK cannot be changed without a
-- forbidden table rebuild). Additive: every existing row takes the default, and a writer that does not name the column is unaffected.
ALTER TABLE contacts ADD COLUMN additional_props TEXT NOT NULL DEFAULT '{}' CONSTRAINT contacts_additional_props CHECK (json_valid(additional_props) AND json_type(additional_props) = 'object');
ALTER TABLE companies ADD COLUMN additional_props TEXT NOT NULL DEFAULT '{}' CONSTRAINT companies_additional_props CHECK (json_valid(additional_props) AND json_type(additional_props) = 'object');
ALTER TABLE deals ADD COLUMN additional_props TEXT NOT NULL DEFAULT '{}' CONSTRAINT deals_additional_props CHECK (json_valid(additional_props) AND json_type(additional_props) = 'object');
ALTER TABLE tasks ADD COLUMN additional_props TEXT NOT NULL DEFAULT '{}' CONSTRAINT tasks_additional_props CHECK (json_valid(additional_props) AND json_type(additional_props) = 'object');
