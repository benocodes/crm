-- D1 schema slice 2 (CORE36 cycle 1): the identity model. Forward-only, in 0001's conventions (canonical lowercase
-- UUID text, strftime-validated ISO timestamps, 0/1 checked booleans, STRICT tables). Every constraint the Postgres
-- tables have (migration 003): composite intra-organisation foreign keys, the live-row partial unique indexes, the
-- owner rule own = (contact_id IS NULL), the tombstone checks and, new in CORE36 D7, lowercase ASCII email values.
-- memberships, agents and api_keys arrive with CORE40's 0003. GLOB patterns stay under D1's 50 byte limit.

CREATE TABLE companies (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CHECK (deleted_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0)),
  name TEXT NOT NULL,
  domain TEXT CHECK (domain IS NULL OR (domain = lower(domain) AND domain NOT GLOB '*[^ -~]*')),
  UNIQUE (organization_id, id)
) STRICT;

CREATE UNIQUE INDEX idx_companies_domain_unique ON companies (organization_id, domain)
  WHERE deleted_at IS NULL AND domain IS NOT NULL;

CREATE TABLE contacts (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CHECK (deleted_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0)),
  name TEXT,
  company_id TEXT,
  merged_into_id TEXT,
  CONSTRAINT contacts_merged_is_deleted CHECK (merged_into_id IS NULL OR deleted_at IS NOT NULL),
  CONSTRAINT contacts_not_merged_into_self CHECK (merged_into_id <> id),
  UNIQUE (organization_id, id),
  CONSTRAINT contacts_company_fk FOREIGN KEY (organization_id, company_id) REFERENCES companies (organization_id, id),
  CONSTRAINT contacts_merged_into_fk FOREIGN KEY (organization_id, merged_into_id) REFERENCES contacts (organization_id, id)
) STRICT;

CREATE INDEX idx_contacts_organization_id_company_id ON contacts (organization_id, company_id);

CREATE TABLE identities (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CHECK (deleted_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0)),
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  contact_id TEXT,
  own INTEGER NOT NULL DEFAULT 0 CHECK (own IN (0, 1)),
  CONSTRAINT identities_kind CHECK (kind IN ('email', 'phone')),
  CONSTRAINT identities_own_xor_contact CHECK (own = (contact_id IS NULL)),
  CONSTRAINT identities_email_ascii_lower CHECK (kind <> 'email' OR (value = lower(value) AND value NOT GLOB '*[^ -~]*')),
  UNIQUE (organization_id, id),
  CONSTRAINT identities_contact_fk FOREIGN KEY (organization_id, contact_id) REFERENCES contacts (organization_id, id)
) STRICT;

CREATE UNIQUE INDEX idx_identities_address_unique ON identities (organization_id, kind, value) WHERE deleted_at IS NULL;
CREATE INDEX idx_identities_contact_id ON identities (contact_id);

-- Machinery, not a resource (invariant 5, CORE36 P3): a table that never holds a row. A unit's assertion step is
-- `INSERT INTO unit_assertion (ok) SELECT 0 WHERE NOT (<condition>)`: nothing is inserted while the condition holds;
-- when it fails the named CHECK aborts the whole batch, and the D1 runtime classifies that constraint as drift.
CREATE TABLE unit_assertion (
  ok INTEGER NOT NULL,
  CONSTRAINT unit_assertion_holds CHECK (ok = 1)
) STRICT;
