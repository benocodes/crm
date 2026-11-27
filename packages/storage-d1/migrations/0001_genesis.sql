-- Genesis schema for the CRM D1 database ([[CORE678]]).
-- Written by hand to the schema conventions of [[CORE679]] (C1-C8), which a test over the live catalogue holds:
-- one id CHECK or a foreign key, one timestamp CHECK, every CHECK named, one unique (organization_id, id) index,
-- idx_ index names, STRICT tables, upper-case keywords. Column order is that of the 36-file chain this replaces.

CREATE TABLE deployment (
  singleton INTEGER PRIMARY KEY NOT NULL CONSTRAINT deployment_singleton CHECK (singleton = 1),
  organization_id TEXT NOT NULL UNIQUE
    CONSTRAINT deployment_organization_id_uuid CHECK (length(organization_id) = 36 AND organization_id NOT GLOB '*[^0-9a-f-]*' AND substr(organization_id, 9, 1) = '-' AND substr(organization_id, 14, 1) = '-' AND substr(organization_id, 19, 1) = '-' AND substr(organization_id, 24, 1) = '-'),
  auth_provider TEXT NOT NULL,
  auth_org_id TEXT NOT NULL,
  UNIQUE (auth_provider, auth_org_id)
) STRICT;

CREATE TABLE organizations (
  id TEXT PRIMARY KEY NOT NULL REFERENCES deployment (organization_id),
  created_at TEXT NOT NULL CONSTRAINT organizations_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CONSTRAINT organizations_updated_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  name TEXT NOT NULL,
  auth_provider TEXT,
  auth_org_id TEXT,
  CONSTRAINT organizations_provider_iff_org CHECK ((auth_provider IS NULL) = (auth_org_id IS NULL)),
  UNIQUE (auth_provider, auth_org_id)
) STRICT;

CREATE TABLE principals (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT principals_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CONSTRAINT principals_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  kind TEXT NOT NULL CONSTRAINT principals_kind CHECK (kind IN ('user', 'agent', 'system'))
) STRICT;

CREATE UNIQUE INDEX idx_principals_single_system ON principals (kind) WHERE kind = 'system';

CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL CONSTRAINT users_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CONSTRAINT users_updated_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  email TEXT NOT NULL UNIQUE CONSTRAINT users_email CHECK (email = lower(email) AND email NOT GLOB '*[^ -~]*'),
  name TEXT,
  auth_provider TEXT,
  auth_subject TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0 CONSTRAINT users_email_verified CHECK (email_verified IN (0, 1)),
  CONSTRAINT users_provider_iff_subject CHECK ((auth_provider IS NULL) = (auth_subject IS NULL)),
  UNIQUE (auth_provider, auth_subject)
) STRICT;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT tasks_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CONSTRAINT tasks_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CONSTRAINT tasks_updated_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  title TEXT NOT NULL CONSTRAINT tasks_title_length CHECK (length(title) BETWEEN 1 AND 500),
  notes TEXT CONSTRAINT tasks_notes_length CHECK (notes IS NULL OR (length(notes) <= 10000)),
  status TEXT NOT NULL DEFAULT 'open' CONSTRAINT tasks_status CHECK (status IN ('open', 'done')),
  due_at TEXT CONSTRAINT tasks_due_at_timestamp CHECK (due_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', due_at) = due_at, 0))),
  completed_at TEXT CONSTRAINT tasks_completed_at_timestamp CHECK (completed_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at, 0))),
  assignee_id TEXT REFERENCES principals (id),
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CONSTRAINT tasks_deleted_at_timestamp CHECK (deleted_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0))),
  additional_props TEXT NOT NULL DEFAULT '{}' CONSTRAINT tasks_additional_props CHECK (json_valid(additional_props) AND json_type(additional_props) = 'object')
) STRICT;

CREATE UNIQUE INDEX idx_tasks_organization_id_id ON tasks (organization_id, id);

CREATE TABLE companies (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT companies_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CONSTRAINT companies_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CONSTRAINT companies_updated_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CONSTRAINT companies_deleted_at_timestamp CHECK (deleted_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0))),
  name TEXT NOT NULL CONSTRAINT companies_name_length CHECK (length(name) BETWEEN 1 AND 500),
  domain TEXT CONSTRAINT companies_domain CHECK (domain IS NULL OR (domain = lower(domain) AND domain NOT GLOB '*[^ -~]*'))
    CONSTRAINT companies_domain_length CHECK (domain IS NULL OR (length(domain) <= 253)),
  additional_props TEXT NOT NULL DEFAULT '{}' CONSTRAINT companies_additional_props CHECK (json_valid(additional_props) AND json_type(additional_props) = 'object')
) STRICT;

CREATE UNIQUE INDEX idx_companies_organization_id_id ON companies (organization_id, id);

CREATE UNIQUE INDEX idx_companies_domain_unique ON companies (organization_id, domain)
  WHERE deleted_at IS NULL AND domain IS NOT NULL;

CREATE TABLE contacts (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT contacts_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CONSTRAINT contacts_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CONSTRAINT contacts_updated_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CONSTRAINT contacts_deleted_at_timestamp CHECK (deleted_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0))),
  name TEXT CONSTRAINT contacts_name_length CHECK (name IS NULL OR (length(name) BETWEEN 1 AND 500)),
  company_id TEXT,
  merged_into_id TEXT,
  additional_props TEXT NOT NULL DEFAULT '{}' CONSTRAINT contacts_additional_props CHECK (json_valid(additional_props) AND json_type(additional_props) = 'object'),
  CONSTRAINT contacts_merged_is_deleted CHECK (merged_into_id IS NULL OR deleted_at IS NOT NULL),
  CONSTRAINT contacts_not_merged_into_self CHECK (merged_into_id <> id),
  CONSTRAINT contacts_company_fk FOREIGN KEY (organization_id, company_id) REFERENCES companies (organization_id, id),
  CONSTRAINT contacts_merged_into_fk FOREIGN KEY (organization_id, merged_into_id) REFERENCES contacts (organization_id, id)
) STRICT;

CREATE UNIQUE INDEX idx_contacts_organization_id_id ON contacts (organization_id, id);

CREATE INDEX idx_contacts_organization_id_company_id ON contacts (organization_id, company_id);

CREATE TABLE unit_assertion (
  ok INTEGER NOT NULL,
  CONSTRAINT unit_assertion_holds CHECK (ok = 1)
) STRICT;

CREATE TABLE memberships (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT memberships_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CONSTRAINT memberships_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CONSTRAINT memberships_updated_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL CONSTRAINT memberships_role CHECK (role IN ('owner', 'member')),
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CONSTRAINT memberships_deleted_at_timestamp CHECK (deleted_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0)))
) STRICT;

CREATE UNIQUE INDEX idx_memberships_live_unique ON memberships (organization_id, user_id) WHERE deleted_at IS NULL;

CREATE INDEX idx_memberships_user_id ON memberships (user_id) WHERE deleted_at IS NULL;

CREATE TABLE agents (
  id TEXT PRIMARY KEY NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL CONSTRAINT agents_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CONSTRAINT agents_updated_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]' CONSTRAINT agents_scopes CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  disabled_at TEXT CONSTRAINT agents_disabled_at_timestamp CHECK (disabled_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', disabled_at) = disabled_at, 0))),
  created_by TEXT NOT NULL REFERENCES principals (id),
  auth_provider TEXT CONSTRAINT agents_auth_provider CHECK (auth_provider IS NULL OR length(auth_provider) > 0),
  auth_subject TEXT,
  auth_client_id TEXT,
  delegated_by TEXT REFERENCES users (id),
  consented_scopes TEXT CONSTRAINT agents_consented_scopes CHECK (consented_scopes IS NULL OR (json_valid(consented_scopes) AND json_type(consented_scopes) = 'array')),
  CONSTRAINT agents_auth_subject_needs_provider CHECK (auth_subject IS NULL OR (auth_provider IS NOT NULL AND length(auth_subject) > 0)),
  CONSTRAINT agents_auth_client_rules CHECK (auth_client_id IS NULL OR (auth_provider IS NOT NULL AND auth_subject IS NULL AND length(auth_client_id) > 0)),
  CONSTRAINT agents_delegated_by_iff_client CHECK ((delegated_by IS NULL) = (auth_client_id IS NULL)),
  CONSTRAINT agents_provider_iff_linked CHECK ((auth_provider IS NULL) = (auth_subject IS NULL AND auth_client_id IS NULL))
) STRICT;

CREATE UNIQUE INDEX idx_agents_organization_id_id ON agents (organization_id, id);

CREATE UNIQUE INDEX idx_agents_auth_subject_unique ON agents (auth_provider, auth_subject) WHERE auth_subject IS NOT NULL;

CREATE UNIQUE INDEX idx_agents_auth_client_unique ON agents (auth_provider, auth_client_id, delegated_by) WHERE auth_client_id IS NOT NULL;

CREATE TABLE files (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT files_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CONSTRAINT files_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  CONSTRAINT files_size_nonnegative CHECK (size_bytes >= 0),
  CONSTRAINT files_sha256_hex CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')
) STRICT;

CREATE UNIQUE INDEX idx_files_organization_id_id ON files (organization_id, id);

CREATE INDEX idx_files_sha256 ON files (organization_id, sha256);

CREATE TABLE interaction_participants (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT interaction_participants_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CONSTRAINT interaction_participants_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  interaction_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  role TEXT NOT NULL,
  CONSTRAINT interaction_participants_role CHECK (role IN ('from', 'to', 'cc', 'bcc')),
  CONSTRAINT interaction_participants_interaction_fk FOREIGN KEY (organization_id, interaction_id) REFERENCES interactions (organization_id, id),
  CONSTRAINT interaction_participants_identity_fk FOREIGN KEY (organization_id, identity_id) REFERENCES identities (organization_id, id)
) STRICT;

CREATE UNIQUE INDEX idx_interaction_participants_unique ON interaction_participants (organization_id, interaction_id, role, identity_id);

CREATE INDEX idx_interaction_participants_identity ON interaction_participants (organization_id, identity_id, interaction_id);

CREATE TABLE message_attachments (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT message_attachments_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CONSTRAINT message_attachments_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  message_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  file_id TEXT,
  type TEXT NOT NULL,
  name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  inline INTEGER NOT NULL CONSTRAINT message_attachments_inline CHECK (inline IN (0, 1)),
  content_id TEXT,
  fetch_status TEXT NOT NULL,
  fetch_metadata TEXT CONSTRAINT message_attachments_fetch_metadata CHECK (fetch_metadata IS NULL OR json_valid(fetch_metadata)),
  fetch_error TEXT,
  CONSTRAINT message_attachments_type CHECK (type IN ('image', 'file', 'video', 'audio')),
  CONSTRAINT message_attachments_fetch_status CHECK (fetch_status IN ('stored', 'pending', 'failed', 'skipped')),
  CONSTRAINT message_attachments_stored_file CHECK ((fetch_status = 'stored') = (file_id IS NOT NULL)),
  CONSTRAINT message_attachments_position_nonnegative CHECK (position >= 0),
  CONSTRAINT message_attachments_size_nonnegative CHECK (size_bytes IS NULL OR size_bytes >= 0),
  CONSTRAINT message_attachments_message_fk FOREIGN KEY (organization_id, message_id) REFERENCES messages (organization_id, id),
  CONSTRAINT message_attachments_file_fk FOREIGN KEY (organization_id, file_id) REFERENCES files (organization_id, id)
) STRICT;

CREATE UNIQUE INDEX idx_message_attachments_position_unique ON message_attachments (organization_id, message_id, position);

CREATE INDEX idx_message_attachments_file ON message_attachments (organization_id, file_id);

CREATE TABLE contact_files (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT contact_files_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CONSTRAINT contact_files_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  contact_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  updated_at TEXT NOT NULL CONSTRAINT contact_files_updated_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  deleted_at TEXT CONSTRAINT contact_files_deleted_at_timestamp CHECK (deleted_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0))),
  CONSTRAINT contact_files_contact_fk FOREIGN KEY (organization_id, contact_id) REFERENCES contacts (organization_id, id),
  CONSTRAINT contact_files_file_fk FOREIGN KEY (organization_id, file_id) REFERENCES files (organization_id, id)
) STRICT;

CREATE UNIQUE INDEX idx_contact_files_live_unique ON contact_files (organization_id, contact_id, file_id) WHERE deleted_at IS NULL;

CREATE INDEX idx_contact_files_file ON contact_files (organization_id, file_id);

CREATE TABLE company_files (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT company_files_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CONSTRAINT company_files_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  company_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  updated_at TEXT NOT NULL CONSTRAINT company_files_updated_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  deleted_at TEXT CONSTRAINT company_files_deleted_at_timestamp CHECK (deleted_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0))),
  CONSTRAINT company_files_company_fk FOREIGN KEY (organization_id, company_id) REFERENCES companies (organization_id, id),
  CONSTRAINT company_files_file_fk FOREIGN KEY (organization_id, file_id) REFERENCES files (organization_id, id)
) STRICT;

CREATE UNIQUE INDEX idx_company_files_live_unique ON company_files (organization_id, company_id, file_id) WHERE deleted_at IS NULL;

CREATE INDEX idx_company_files_file ON company_files (organization_id, file_id);

CREATE TRIGGER files_append_only BEFORE UPDATE ON files
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER interaction_participants_append_only BEFORE UPDATE ON interaction_participants
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER message_attachments_append_only BEFORE UPDATE ON message_attachments
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TABLE associations (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT associations_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CONSTRAINT associations_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  a_type TEXT NOT NULL CONSTRAINT associations_a_type_identifier CHECK (length(a_type) > 0 AND a_type NOT GLOB '*[^a-z0-9_]*'),
  a_id TEXT NOT NULL CONSTRAINT associations_a_id_uuid CHECK (length(a_id) = 36 AND a_id NOT GLOB '*[^0-9a-f-]*' AND substr(a_id, 9, 1) = '-' AND substr(a_id, 14, 1) = '-' AND substr(a_id, 19, 1) = '-' AND substr(a_id, 24, 1) = '-'),
  b_type TEXT NOT NULL CONSTRAINT associations_b_type_identifier CHECK (length(b_type) > 0 AND b_type NOT GLOB '*[^a-z0-9_]*'),
  b_id TEXT NOT NULL CONSTRAINT associations_b_id_uuid CHECK (length(b_id) = 36 AND b_id NOT GLOB '*[^0-9a-f-]*' AND substr(b_id, 9, 1) = '-' AND substr(b_id, 14, 1) = '-' AND substr(b_id, 19, 1) = '-' AND substr(b_id, 24, 1) = '-'),
  relation TEXT NOT NULL DEFAULT 'related_to' CONSTRAINT associations_relation CHECK (relation IN ('related_to')),
  updated_at TEXT NOT NULL CONSTRAINT associations_updated_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  deleted_at TEXT CONSTRAINT associations_deleted_at_timestamp CHECK (deleted_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0))),
  CONSTRAINT associations_canonical_order CHECK (a_type < b_type OR (a_type = b_type AND a_id < b_id))
) STRICT;

CREATE UNIQUE INDEX idx_associations_live_unique ON associations (organization_id, a_type, a_id, b_type, b_id, relation) WHERE deleted_at IS NULL;

CREATE INDEX idx_associations_a ON associations (organization_id, a_type, a_id) WHERE deleted_at IS NULL;

CREATE INDEX idx_associations_b ON associations (organization_id, b_type, b_id) WHERE deleted_at IS NULL;

CREATE TABLE notes (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT notes_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CONSTRAINT notes_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CONSTRAINT notes_updated_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  title TEXT CONSTRAINT notes_title_length CHECK (title IS NULL OR (length(title) BETWEEN 1 AND 500)),
  content TEXT NOT NULL CONSTRAINT notes_content_length CHECK (length(content) BETWEEN 1 AND 100000),
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CONSTRAINT notes_deleted_at_timestamp CHECK (deleted_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0)))
) STRICT;

CREATE UNIQUE INDEX idx_notes_organization_id_id ON notes (organization_id, id);

CREATE TABLE tags (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT tags_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CONSTRAINT tags_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CONSTRAINT tags_updated_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE CONSTRAINT tags_name_length CHECK (length(name) BETWEEN 1 AND 100),
  description TEXT CONSTRAINT tags_description_length CHECK (description IS NULL OR (length(description) BETWEEN 1 AND 1000)),
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CONSTRAINT tags_deleted_at_timestamp CHECK (deleted_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0)))
) STRICT;

CREATE UNIQUE INDEX idx_tags_organization_id_id ON tags (organization_id, id);

CREATE UNIQUE INDEX idx_tags_live_name ON tags (organization_id, name) WHERE deleted_at IS NULL;

CREATE TABLE pipelines (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT pipelines_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CONSTRAINT pipelines_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CONSTRAINT pipelines_updated_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE CONSTRAINT pipelines_name_length CHECK (length(name) BETWEEN 1 AND 100),
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CONSTRAINT pipelines_deleted_at_timestamp CHECK (deleted_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0)))
) STRICT;

CREATE UNIQUE INDEX idx_pipelines_organization_id_id ON pipelines (organization_id, id);

CREATE UNIQUE INDEX idx_pipelines_live_name ON pipelines (organization_id, name) WHERE deleted_at IS NULL;

CREATE TABLE pipeline_stages (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT pipeline_stages_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CONSTRAINT pipeline_stages_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CONSTRAINT pipeline_stages_updated_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  pipeline_id TEXT NOT NULL REFERENCES pipelines (id),
  name TEXT NOT NULL COLLATE NOCASE CONSTRAINT pipeline_stages_name_length CHECK (length(name) BETWEEN 1 AND 100),
  kind TEXT NOT NULL CONSTRAINT pipeline_stages_kind CHECK (kind IN ('open', 'won', 'lost')),
  position INTEGER NOT NULL CONSTRAINT pipeline_stages_position CHECK (position >= 0),
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CONSTRAINT pipeline_stages_deleted_at_timestamp CHECK (deleted_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0)))
) STRICT;

CREATE UNIQUE INDEX idx_pipeline_stages_organization_id_id ON pipeline_stages (organization_id, id);

CREATE UNIQUE INDEX idx_pipeline_stages_pipeline_id_id ON pipeline_stages (pipeline_id, id);

CREATE UNIQUE INDEX idx_pipeline_stages_live_name ON pipeline_stages (organization_id, pipeline_id, name) WHERE deleted_at IS NULL;

CREATE TABLE deals (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT deals_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CONSTRAINT deals_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CONSTRAINT deals_updated_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name TEXT NOT NULL CONSTRAINT deals_name_length CHECK (length(name) BETWEEN 1 AND 200),
  pipeline_id TEXT NOT NULL REFERENCES pipelines (id),
  stage_id TEXT NOT NULL,
  amount_minor INTEGER CONSTRAINT deals_amount_minor CHECK (amount_minor IS NULL OR (amount_minor >= 0 AND amount_minor <= 9007199254740991)),
  currency TEXT CONSTRAINT deals_currency CHECK (currency IS NULL OR (length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*')),
  expected_close_date TEXT CONSTRAINT deals_expected_close_date CHECK (expected_close_date IS NULL OR date(expected_close_date) = expected_close_date),
  owner_id TEXT REFERENCES principals (id),
  closed_at TEXT CONSTRAINT deals_closed_at_timestamp CHECK (closed_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', closed_at) = closed_at, 0))),
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CONSTRAINT deals_deleted_at_timestamp CHECK (deleted_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0))),
  additional_props TEXT NOT NULL DEFAULT '{}' CONSTRAINT deals_additional_props CHECK (json_valid(additional_props) AND json_type(additional_props) = 'object'),
  CONSTRAINT deals_amount_needs_currency CHECK (amount_minor IS NULL OR currency IS NOT NULL),
  CONSTRAINT deals_stage_fk FOREIGN KEY (pipeline_id, stage_id) REFERENCES pipeline_stages (pipeline_id, id)
) STRICT;

CREATE UNIQUE INDEX idx_deals_organization_id_id ON deals (organization_id, id);

CREATE INDEX idx_deals_organization_id_pipeline_id ON deals (organization_id, pipeline_id);

CREATE INDEX idx_deals_organization_id_stage_id ON deals (organization_id, stage_id);

CREATE INDEX idx_deals_organization_id_owner_id ON deals (organization_id, owner_id);

CREATE TABLE channel_credentials (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT channel_credentials_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CONSTRAINT channel_credentials_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  connection_id TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL CONSTRAINT channel_credentials_refresh_token_ciphertext CHECK (length(refresh_token_ciphertext) > 0),
  key_version INTEGER NOT NULL CONSTRAINT channel_credentials_key_version CHECK (key_version >= 1),
  CONSTRAINT channel_credentials_connection_fk FOREIGN KEY (organization_id, connection_id) REFERENCES channel_connections (organization_id, id)
) STRICT;

CREATE INDEX idx_channel_credentials_connection ON channel_credentials (organization_id, connection_id, created_at);

CREATE TABLE gmail_watches (
  connection_id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CONSTRAINT gmail_watches_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  mailbox TEXT NOT NULL CONSTRAINT gmail_watches_mailbox CHECK (mailbox = lower(mailbox) AND length(mailbox) > 0),
  expires_at TEXT NOT NULL CONSTRAINT gmail_watches_expires_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at, 0)),
  CONSTRAINT gmail_watches_connection_fk FOREIGN KEY (organization_id, connection_id) REFERENCES channel_connections (organization_id, id)
) STRICT;

CREATE INDEX idx_gmail_watches_mailbox ON gmail_watches (mailbox);

CREATE TABLE mail_sync_state (
  connection_id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CONSTRAINT mail_sync_state_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  sync_requested_at TEXT CONSTRAINT mail_sync_state_sync_requested_at_timestamp CHECK (sync_requested_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', sync_requested_at) = sync_requested_at, 0))),
  lease_until TEXT CONSTRAINT mail_sync_state_lease_until_timestamp CHECK (lease_until IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', lease_until) = lease_until, 0))),
  run_id TEXT,
  last_success_at TEXT CONSTRAINT mail_sync_state_last_success_at_timestamp CHECK (last_success_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', last_success_at) = last_success_at, 0))),
  last_error_code TEXT,
  last_error_at TEXT CONSTRAINT mail_sync_state_last_error_at_timestamp CHECK (last_error_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', last_error_at) = last_error_at, 0))),
  CONSTRAINT mail_sync_state_connection_fk FOREIGN KEY (organization_id, connection_id) REFERENCES channel_connections (organization_id, id)
) STRICT;

CREATE TABLE mail_sync_cursors (
  connection_id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CONSTRAINT mail_sync_cursors_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  history_id TEXT NOT NULL CONSTRAINT mail_sync_cursors_history_id CHECK (length(history_id) > 0),
  page_token TEXT,
  last_synced_at TEXT CONSTRAINT mail_sync_cursors_last_synced_at_timestamp CHECK (last_synced_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', last_synced_at) = last_synced_at, 0))),
  CONSTRAINT mail_sync_cursors_connection_fk FOREIGN KEY (organization_id, connection_id) REFERENCES channel_connections (organization_id, id)
) STRICT;

CREATE TABLE action_requests (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT action_requests_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CONSTRAINT action_requests_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CONSTRAINT action_requests_updated_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  operation TEXT NOT NULL CONSTRAINT action_requests_operation CHECK (length(operation) BETWEEN 3 AND 100),
  arguments TEXT NOT NULL CONSTRAINT action_requests_arguments CHECK (json_valid(arguments) AND json_type(arguments) = 'object'),
  edited_arguments TEXT CONSTRAINT action_requests_edited_arguments CHECK (edited_arguments IS NULL OR (json_valid(edited_arguments) AND json_type(edited_arguments) = 'object')),
  status TEXT NOT NULL CONSTRAINT action_requests_status CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'expired', 'superseded', 'executed', 'failed')),
  reason TEXT NOT NULL CONSTRAINT action_requests_reason CHECK (length(reason) BETWEEN 1 AND 2000),
  evidence TEXT NOT NULL CONSTRAINT action_requests_evidence CHECK (json_valid(evidence) AND json_type(evidence) = 'array' AND json_array_length(evidence) <= 20),
  contact_id TEXT,
  thread_id TEXT,
  interaction_id TEXT,
  dedup_key TEXT CONSTRAINT action_requests_dedup_key CHECK (dedup_key IS NULL OR length(dedup_key) BETWEEN 1 AND 200),
  expires_at TEXT NOT NULL CONSTRAINT action_requests_expires_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at, 0)),
  decided_by TEXT REFERENCES principals (id),
  decided_at TEXT CONSTRAINT action_requests_decided_at_timestamp CHECK (decided_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', decided_at) = decided_at, 0))),
  decision_reason TEXT CONSTRAINT action_requests_decision_reason CHECK (decision_reason IS NULL OR length(decision_reason) <= 2000),
  superseded_by_id TEXT,
  result TEXT CONSTRAINT action_requests_result CHECK (result IS NULL OR json_valid(result)),
  error_code TEXT,
  error_message TEXT,
  executed_at TEXT CONSTRAINT action_requests_executed_at_timestamp CHECK (executed_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', executed_at) = executed_at, 0))),
  target_summary TEXT CONSTRAINT action_requests_target_summary CHECK (target_summary IS NULL OR length(target_summary) BETWEEN 1 AND 500),
  CONSTRAINT action_requests_decided CHECK ((status = 'pending') = (decided_by IS NULL) AND (decided_by IS NULL) = (decided_at IS NULL)),
  CONSTRAINT action_requests_executed CHECK ((status = 'executed') = (executed_at IS NOT NULL)),
  CONSTRAINT action_requests_contact_fk FOREIGN KEY (organization_id, contact_id) REFERENCES contacts (organization_id, id),
  CONSTRAINT action_requests_thread_fk FOREIGN KEY (organization_id, thread_id) REFERENCES threads (organization_id, id),
  CONSTRAINT action_requests_interaction_fk FOREIGN KEY (organization_id, interaction_id) REFERENCES interactions (organization_id, id),
  CONSTRAINT action_requests_superseded_by_fk FOREIGN KEY (organization_id, superseded_by_id) REFERENCES action_requests (organization_id, id)
) STRICT;

CREATE UNIQUE INDEX idx_action_requests_organization_id_id ON action_requests (organization_id, id);

CREATE UNIQUE INDEX idx_action_requests_pending_dedup ON action_requests (organization_id, dedup_key) WHERE status = 'pending' AND dedup_key IS NOT NULL;

CREATE INDEX idx_action_requests_pending_expiry ON action_requests (expires_at) WHERE status = 'pending';

CREATE INDEX idx_action_requests_organization_status ON action_requests (organization_id, status, id);

CREATE INDEX idx_action_requests_organization_created_by ON action_requests (organization_id, created_by);

CREATE INDEX idx_action_requests_organization_operation ON action_requests (organization_id, operation);

CREATE INDEX idx_action_requests_contact ON action_requests (organization_id, contact_id) WHERE contact_id IS NOT NULL;

CREATE INDEX idx_action_requests_thread ON action_requests (organization_id, thread_id) WHERE thread_id IS NOT NULL;

CREATE INDEX idx_action_requests_interaction ON action_requests (organization_id, interaction_id) WHERE interaction_id IS NOT NULL;

CREATE TABLE action_executions (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT action_executions_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CONSTRAINT action_executions_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CONSTRAINT action_executions_updated_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  authorised_by TEXT NOT NULL REFERENCES principals (id),
  action_request_id TEXT,
  connection_id TEXT,
  operation TEXT NOT NULL CONSTRAINT action_executions_operation CHECK (length(operation) BETWEEN 3 AND 100),
  arguments TEXT NOT NULL CONSTRAINT action_executions_arguments CHECK (json_valid(arguments) AND json_type(arguments) = 'object'),
  resolution TEXT NOT NULL CONSTRAINT action_executions_resolution CHECK (json_valid(resolution) AND json_type(resolution) = 'object'),
  status TEXT NOT NULL CONSTRAINT action_executions_status CHECK (status IN ('queued', 'claimed', 'done', 'failed')),
  client_ref TEXT NOT NULL CONSTRAINT action_executions_client_ref CHECK (length(client_ref) BETWEEN 3 AND 300),
  idempotency_key TEXT CONSTRAINT action_executions_idempotency_key CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 200),
  input_hash TEXT NOT NULL CONSTRAINT action_executions_input_hash CHECK (length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
  deadline_at TEXT NOT NULL CONSTRAINT action_executions_deadline_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deadline_at) = deadline_at, 0)),
  dispatched_at TEXT CONSTRAINT action_executions_dispatched_at_timestamp CHECK (dispatched_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', dispatched_at) = dispatched_at, 0))),
  done_at TEXT CONSTRAINT action_executions_done_at_timestamp CHECK (done_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', done_at) = done_at, 0))),
  attempts INTEGER NOT NULL DEFAULT 0 CONSTRAINT action_executions_attempts CHECK (attempts >= 0),
  next_attempt_at TEXT NOT NULL CONSTRAINT action_executions_next_attempt_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', next_attempt_at) = next_attempt_at, 0)),
  lease_until TEXT CONSTRAINT action_executions_lease_until_timestamp CHECK (lease_until IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', lease_until) = lease_until, 0))),
  lease_token TEXT,
  last_error_code TEXT,
  result TEXT CONSTRAINT action_executions_result CHECK (result IS NULL OR json_valid(result)),
  error_code TEXT,
  error_message TEXT CONSTRAINT action_executions_error_message CHECK (error_message IS NULL OR length(error_message) <= 2000),
  CONSTRAINT action_executions_done CHECK (status <> 'done' OR result IS NOT NULL),
  CONSTRAINT action_executions_failed CHECK (status <> 'failed' OR error_code IS NOT NULL),
  CONSTRAINT action_executions_finished CHECK ((status IN ('done', 'failed')) = (done_at IS NOT NULL)),
  CONSTRAINT action_executions_outcome CHECK ((status <> 'done' OR error_code IS NULL) AND (status <> 'failed' OR result IS NULL)),
  CONSTRAINT action_executions_lease CHECK ((status = 'claimed' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR (status <> 'claimed' AND lease_token IS NULL AND lease_until IS NULL)),
  CONSTRAINT action_executions_connection_fk FOREIGN KEY (organization_id, connection_id) REFERENCES channel_connections (organization_id, id),
  CONSTRAINT action_executions_request_fk FOREIGN KEY (organization_id, action_request_id) REFERENCES action_requests (organization_id, id)
) STRICT;

CREATE UNIQUE INDEX idx_action_executions_request ON action_executions (organization_id, action_request_id) WHERE action_request_id IS NOT NULL;

CREATE UNIQUE INDEX idx_action_executions_idempotency ON action_executions (organization_id, created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX idx_action_executions_client_ref ON action_executions (client_ref);

CREATE INDEX idx_action_executions_due ON action_executions (next_attempt_at, id) WHERE status = 'queued';

CREATE INDEX idx_action_executions_lease ON action_executions (lease_until, id) WHERE status = 'claimed';

CREATE INDEX idx_action_executions_organization_status ON action_executions (organization_id, status, id);

CREATE INDEX idx_action_executions_organization_operation ON action_executions (organization_id, operation, id);

CREATE VIRTUAL TABLE companies_search USING fts5(id UNINDEXED, name, domain, tokenize = 'trigram');

CREATE TRIGGER companies_search_ai AFTER INSERT ON companies
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO companies_search (id, name, domain) VALUES (new.id, new.name, new.domain);
END;

CREATE TRIGGER companies_search_au AFTER UPDATE OF name, domain, deleted_at ON companies
BEGIN
  DELETE FROM companies_search WHERE id = old.id;
  INSERT INTO companies_search (id, name, domain) SELECT new.id, new.name, new.domain WHERE new.deleted_at IS NULL;
END;

CREATE TRIGGER companies_search_ad AFTER DELETE ON companies
BEGIN
  DELETE FROM companies_search WHERE id = old.id;
END;

CREATE VIRTUAL TABLE notes_search USING fts5(id UNINDEXED, title, content, tokenize = 'trigram');

CREATE TRIGGER notes_search_ai AFTER INSERT ON notes
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO notes_search (id, title, content) VALUES (new.id, new.title, new.content);
END;

CREATE TRIGGER notes_search_au AFTER UPDATE OF title, content, deleted_at ON notes
BEGIN
  DELETE FROM notes_search WHERE id = old.id;
  INSERT INTO notes_search (id, title, content) SELECT new.id, new.title, new.content WHERE new.deleted_at IS NULL;
END;

CREATE TRIGGER notes_search_ad AFTER DELETE ON notes
BEGIN
  DELETE FROM notes_search WHERE id = old.id;
END;

CREATE VIRTUAL TABLE tasks_search USING fts5(id UNINDEXED, title, notes, tokenize = 'trigram');

CREATE TRIGGER tasks_search_ai AFTER INSERT ON tasks
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO tasks_search (id, title, notes) VALUES (new.id, new.title, new.notes);
END;

CREATE TRIGGER tasks_search_au AFTER UPDATE OF title, notes, deleted_at ON tasks
BEGIN
  DELETE FROM tasks_search WHERE id = old.id;
  INSERT INTO tasks_search (id, title, notes) SELECT new.id, new.title, new.notes WHERE new.deleted_at IS NULL;
END;

CREATE TRIGGER tasks_search_ad AFTER DELETE ON tasks
BEGIN
  DELETE FROM tasks_search WHERE id = old.id;
END;

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  id TEXT NOT NULL UNIQUE
    CONSTRAINT events_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CONSTRAINT events_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL
    CONSTRAINT events_resource_id_uuid CHECK (length(resource_id) = 36 AND resource_id NOT GLOB '*[^0-9a-f-]*' AND substr(resource_id, 9, 1) = '-' AND substr(resource_id, 14, 1) = '-' AND substr(resource_id, 19, 1) = '-' AND substr(resource_id, 24, 1) = '-'),
  actor_id TEXT NOT NULL REFERENCES principals (id),
  "before" TEXT CONSTRAINT events_before CHECK ("before" IS NULL OR json_valid("before")),
  "after" TEXT CONSTRAINT events_after CHECK ("after" IS NULL OR json_valid("after"))
) STRICT;

CREATE INDEX idx_events_resource_id_seq ON events (resource_id, seq);

CREATE TRIGGER events_append_only BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TABLE connection_capture_labels (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT connection_capture_labels_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  label_id TEXT NOT NULL CONSTRAINT connection_capture_labels_label_id CHECK (length(label_id) BETWEEN 1 AND 100 AND label_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  created_at TEXT NOT NULL CONSTRAINT connection_capture_labels_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  CONSTRAINT connection_capture_labels_connection_fk FOREIGN KEY (organization_id, connection_id) REFERENCES channel_connections (organization_id, id),
  CONSTRAINT connection_capture_labels_unique UNIQUE (connection_id, label_id)
) STRICT;

CREATE TABLE connection_blocked_senders (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT connection_blocked_senders_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  kind TEXT NOT NULL CONSTRAINT connection_blocked_senders_kind CHECK (kind IN ('address', 'domain')),
  value TEXT NOT NULL,
  created_at TEXT NOT NULL CONSTRAINT connection_blocked_senders_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  CONSTRAINT connection_blocked_senders_value CHECK (value = lower(value) AND value = trim(value) AND length(value) > 0 AND ((kind = 'address' AND instr(value, '@') > 1) OR (kind = 'domain' AND instr(value, '@') = 0))),
  CONSTRAINT connection_blocked_senders_connection_fk FOREIGN KEY (organization_id, connection_id) REFERENCES channel_connections (organization_id, id),
  CONSTRAINT connection_blocked_senders_unique UNIQUE (connection_id, kind, value)
) STRICT;

CREATE TABLE blocked_senders (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT blocked_senders_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CONSTRAINT blocked_senders_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CONSTRAINT blocked_senders_updated_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CONSTRAINT blocked_senders_deleted_at_timestamp CHECK (deleted_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0))),
  kind TEXT NOT NULL CONSTRAINT blocked_senders_kind CHECK (kind IN ('address', 'domain')),
  value TEXT NOT NULL,
  CONSTRAINT blocked_senders_value CHECK (value = lower(value) AND value = trim(value) AND length(value) > 0 AND ((kind = 'address' AND instr(value, '@') > 1) OR (kind = 'domain' AND instr(value, '@') = 0)))
) STRICT;

CREATE UNIQUE INDEX idx_blocked_senders_live ON blocked_senders (organization_id, kind, value) WHERE deleted_at IS NULL;

CREATE TABLE identities (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT identities_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CONSTRAINT identities_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CONSTRAINT identities_updated_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CONSTRAINT identities_deleted_at_timestamp CHECK (deleted_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0))),
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  contact_id TEXT,
  own INTEGER NOT NULL DEFAULT 0 CONSTRAINT identities_own CHECK (own IN (0, 1)),
  CONSTRAINT identities_kind CHECK (kind IN ('email', 'phone')),
  CONSTRAINT identities_own_has_no_contact CHECK (own = 0 OR contact_id IS NULL),
  CONSTRAINT identities_email_ascii_lower CHECK (kind <> 'email' OR (value = lower(value) AND value NOT GLOB '*[^ -~]*')),
  CONSTRAINT identities_contact_fk FOREIGN KEY (organization_id, contact_id) REFERENCES contacts (organization_id, id)
) STRICT;

CREATE UNIQUE INDEX idx_identities_organization_id_id ON identities (organization_id, id);

CREATE UNIQUE INDEX idx_identities_address_unique ON identities (organization_id, kind, value) WHERE deleted_at IS NULL;

CREATE INDEX idx_identities_contact_id ON identities (contact_id);

CREATE TABLE forms (
  id TEXT PRIMARY KEY NOT NULL REFERENCES agents (id),
  created_at TEXT NOT NULL CONSTRAINT forms_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CONSTRAINT forms_updated_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CONSTRAINT forms_deleted_at_timestamp CHECK (deleted_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0))),
  name TEXT NOT NULL CONSTRAINT forms_name_length CHECK (length(name) BETWEEN 1 AND 200),
  public_id TEXT NOT NULL UNIQUE CONSTRAINT forms_public_id_shape CHECK (length(public_id) = 30 AND substr(public_id, 1, 4) = 'frm_' AND substr(public_id, 5) NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'),
  enabled INTEGER NOT NULL DEFAULT 1 CONSTRAINT forms_enabled CHECK (enabled IN (0, 1)),
  email_field TEXT CONSTRAINT forms_email_field_shape CHECK (email_field IS NULL OR (length(email_field) BETWEEN 1 AND 64 AND email_field NOT GLOB '*[^]A-Za-z0-9_.[-]*')),
  phone_field TEXT CONSTRAINT forms_phone_field_shape CHECK (phone_field IS NULL OR (length(phone_field) BETWEEN 1 AND 64 AND phone_field NOT GLOB '*[^]A-Za-z0-9_.[-]*')),
  name_field TEXT CONSTRAINT forms_name_field_shape CHECK (name_field IS NULL OR (length(name_field) BETWEEN 1 AND 64 AND name_field NOT GLOB '*[^]A-Za-z0-9_.[-]*')),
  consent_text TEXT CONSTRAINT forms_consent_text_length CHECK (consent_text IS NULL OR (length(consent_text) BETWEEN 1 AND 2000)),
  challenge TEXT NOT NULL DEFAULT 'turnstile' CONSTRAINT forms_challenge CHECK (challenge IN ('none', 'turnstile')),
  CONSTRAINT forms_identity_field CHECK (email_field IS NOT NULL OR phone_field IS NOT NULL),
  CONSTRAINT forms_fields_distinct CHECK (
    (email_field IS NULL OR phone_field IS NULL OR email_field <> phone_field)
    AND (email_field IS NULL OR name_field IS NULL OR email_field <> name_field)
    AND (phone_field IS NULL OR name_field IS NULL OR phone_field <> name_field)
  )
) STRICT;

CREATE UNIQUE INDEX idx_forms_organization_id_id ON forms (organization_id, id);

CREATE UNIQUE INDEX idx_forms_live_name ON forms (organization_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;

CREATE TABLE form_allowed_origins (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT form_allowed_origins_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  form_id TEXT NOT NULL,
  origin TEXT NOT NULL CONSTRAINT form_allowed_origins_origin_length CHECK (length(origin) BETWEEN 1 AND 253),
  created_at TEXT NOT NULL CONSTRAINT form_allowed_origins_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  CONSTRAINT form_allowed_origins_form_fk FOREIGN KEY (organization_id, form_id) REFERENCES forms (organization_id, id),
  CONSTRAINT form_allowed_origins_unique UNIQUE (form_id, origin)
) STRICT;

CREATE TABLE form_tags (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT form_tags_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  form_id TEXT NOT NULL,
  tag_id TEXT NOT NULL REFERENCES tags (id),
  created_at TEXT NOT NULL CONSTRAINT form_tags_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  CONSTRAINT form_tags_form_fk FOREIGN KEY (organization_id, form_id) REFERENCES forms (organization_id, id),
  CONSTRAINT form_tags_unique UNIQUE (form_id, tag_id)
) STRICT;

CREATE TABLE threads (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT threads_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CONSTRAINT threads_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  channel TEXT NOT NULL,
  subject TEXT,
  CONSTRAINT threads_channel CHECK (channel IN ('email', 'form'))
) STRICT;

CREATE UNIQUE INDEX idx_threads_organization_id_id ON threads (organization_id, id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT messages_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CONSTRAINT messages_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  thread_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  in_reply_to TEXT,
  author TEXT NOT NULL CONSTRAINT messages_author CHECK (json_valid(author)),
  occurred_at TEXT NOT NULL CONSTRAINT messages_occurred_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) = occurred_at, 0)),
  preview TEXT NOT NULL,
  content_key TEXT,
  version INTEGER NOT NULL,
  retracted_at TEXT CONSTRAINT messages_retracted_at_timestamp CHECK (retracted_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', retracted_at) = retracted_at, 0))),
  content_sha256 TEXT CONSTRAINT messages_content_sha256 CHECK (content_sha256 IS NULL OR (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*')),
  CONSTRAINT messages_channel CHECK (channel IN ('email', 'form')),
  CONSTRAINT messages_kind CHECK (kind IN ('message', 'reaction')),
  CONSTRAINT messages_content_key CHECK (kind <> 'message' OR content_key IS NOT NULL),
  CONSTRAINT messages_preview_length CHECK (length(preview) <= 200),
  CONSTRAINT messages_version_positive CHECK (version >= 1),
  CONSTRAINT messages_thread_fk FOREIGN KEY (organization_id, thread_id) REFERENCES threads (organization_id, id),
  UNIQUE (organization_id, id, thread_id)
) STRICT;

CREATE UNIQUE INDEX idx_messages_organization_id_id ON messages (organization_id, id);

CREATE UNIQUE INDEX idx_messages_external_id_unique ON messages (organization_id, channel, external_id);

CREATE INDEX idx_messages_thread_occurred ON messages (organization_id, thread_id, occurred_at, id);

CREATE INDEX idx_messages_occurred ON messages (organization_id, occurred_at, id);

CREATE TABLE interactions (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT interactions_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CONSTRAINT interactions_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  kind TEXT NOT NULL,
  channel TEXT NOT NULL,
  direction TEXT NOT NULL,
  occurred_at TEXT NOT NULL CONSTRAINT interactions_occurred_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) = occurred_at, 0)),
  thread_id TEXT,
  message_id TEXT,
  CONSTRAINT interactions_kind CHECK (kind IN ('message', 'reaction')),
  CONSTRAINT interactions_channel CHECK (channel IN ('email', 'form')),
  CONSTRAINT interactions_direction CHECK (direction IN ('inbound', 'outbound')),
  CONSTRAINT interactions_kind_pointers CHECK (kind NOT IN ('message', 'reaction') OR (message_id IS NOT NULL AND thread_id IS NOT NULL)),
  CONSTRAINT interactions_thread_fk FOREIGN KEY (organization_id, thread_id) REFERENCES threads (organization_id, id),
  CONSTRAINT interactions_message_fk FOREIGN KEY (organization_id, message_id, thread_id) REFERENCES messages (organization_id, id, thread_id)
) STRICT;

CREATE UNIQUE INDEX idx_interactions_organization_id_id ON interactions (organization_id, id);

CREATE UNIQUE INDEX idx_interactions_message_unique ON interactions (organization_id, message_id);

CREATE INDEX idx_interactions_occurred ON interactions (organization_id, occurred_at, id);

CREATE INDEX idx_interactions_thread_occurred ON interactions (organization_id, thread_id, occurred_at);

CREATE TRIGGER threads_append_only BEFORE UPDATE ON threads
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER interactions_append_only BEFORE UPDATE ON interactions
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TABLE message_sources (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT message_sources_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CONSTRAINT message_sources_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  message_id TEXT NOT NULL,
  connection_id TEXT,
  form_id TEXT,
  provider_message_id TEXT NOT NULL,
  provider_thread_id TEXT NOT NULL,
  CONSTRAINT message_sources_one_source CHECK ((connection_id IS NULL) <> (form_id IS NULL)),
  CONSTRAINT message_sources_message_fk FOREIGN KEY (organization_id, message_id) REFERENCES messages (organization_id, id),
  CONSTRAINT message_sources_connection_fk FOREIGN KEY (organization_id, connection_id) REFERENCES channel_connections (organization_id, id),
  CONSTRAINT message_sources_form_fk FOREIGN KEY (organization_id, form_id) REFERENCES forms (organization_id, id)
) STRICT;

CREATE UNIQUE INDEX idx_message_sources_provider_unique ON message_sources (organization_id, connection_id, provider_message_id);

CREATE UNIQUE INDEX idx_message_sources_form_unique ON message_sources (organization_id, form_id, provider_message_id);

CREATE INDEX idx_message_sources_message ON message_sources (organization_id, message_id);

CREATE TRIGGER message_sources_append_only BEFORE UPDATE ON message_sources
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TABLE thread_sources (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT thread_sources_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CONSTRAINT thread_sources_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  thread_id TEXT NOT NULL,
  connection_id TEXT,
  form_id TEXT,
  provider_thread_id TEXT NOT NULL,
  CONSTRAINT thread_sources_one_source CHECK ((connection_id IS NULL) <> (form_id IS NULL)),
  CONSTRAINT thread_sources_thread_fk FOREIGN KEY (organization_id, thread_id) REFERENCES threads (organization_id, id),
  CONSTRAINT thread_sources_connection_fk FOREIGN KEY (organization_id, connection_id) REFERENCES channel_connections (organization_id, id),
  CONSTRAINT thread_sources_form_fk FOREIGN KEY (organization_id, form_id) REFERENCES forms (organization_id, id)
) STRICT;

CREATE UNIQUE INDEX idx_thread_sources_provider_unique ON thread_sources (organization_id, connection_id, provider_thread_id);

CREATE UNIQUE INDEX idx_thread_sources_form_unique ON thread_sources (organization_id, form_id, provider_thread_id);

CREATE INDEX idx_thread_sources_thread ON thread_sources (organization_id, thread_id);

CREATE TRIGGER thread_sources_append_only BEFORE UPDATE ON thread_sources
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TABLE channel_connections (
  id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT channel_connections_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CONSTRAINT channel_connections_created_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CONSTRAINT channel_connections_updated_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CONSTRAINT channel_connections_deleted_at_timestamp CHECK (deleted_at IS NULL OR (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0))),
  provider TEXT NOT NULL CONSTRAINT channel_connections_provider CHECK (provider IN ('google')),
  account_id TEXT NOT NULL CONSTRAINT channel_connections_account_id CHECK (length(account_id) > 0),
  identity_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users (id),
  status TEXT NOT NULL CONSTRAINT channel_connections_status CHECK (status IN ('active', 'reauth_required', 'suspended')),
  granted_scopes TEXT NOT NULL CONSTRAINT channel_connections_granted_scopes CHECK (json_valid(granted_scopes) AND json_type(granted_scopes) = 'array'),
  connected_at TEXT NOT NULL CONSTRAINT channel_connections_connected_at_timestamp CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', connected_at) = connected_at, 0)),
  exclude_group_addresses INTEGER NOT NULL DEFAULT 1 CONSTRAINT channel_connections_exclude_group_addresses CHECK (exclude_group_addresses IN (0, 1)),
  exclude_personal_domains INTEGER NOT NULL DEFAULT 1 CONSTRAINT channel_connections_exclude_personal_domains CHECK (exclude_personal_domains IN (0, 1)),
  contact_creation TEXT NOT NULL DEFAULT 'sent' CONSTRAINT channel_connections_contact_creation CHECK (contact_creation IN ('sent_and_received', 'sent', 'none')),
  CONSTRAINT channel_connections_identity_fk FOREIGN KEY (organization_id, identity_id) REFERENCES identities (organization_id, id)
) STRICT;

CREATE UNIQUE INDEX idx_channel_connections_organization_id_id ON channel_connections (organization_id, id);

CREATE UNIQUE INDEX idx_channel_connections_live_account ON channel_connections (organization_id, provider, account_id) WHERE deleted_at IS NULL;

CREATE INDEX idx_channel_connections_owner ON channel_connections (owner_id);

CREATE TRIGGER messages_append_only BEFORE UPDATE ON messages
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;
