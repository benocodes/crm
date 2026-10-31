// API63 D6, D16: the code-owned meaning of the built-in tables. Physical facts (types, nullability, keys) come from the database;
// this module adds what the database cannot declare. A migration that adds a table or column adds its text here, in the same
// change: the completeness test (schema.storage.integration.test.ts) fails otherwise. At runtime the database still wins: a
// table or column missing here is listed without a description.

/** A column's text: a bare string is the description; an object also overrides the default label. */
export interface ColumnText {
  label?: string
  description: string
}
export interface TableText {
  label: string
  description: string
  columns: Record<string, string | ColumnText>
}
export interface Catalog {
  tables: Record<string, TableText>
  /** Shared bookkeeping columns, used by every catalogued table that has the column and no text of its own. */
  common: Record<string, string>
}

/**
 * D9: tables that are engine or channel mechanism, never listed: the D1 tenancy marker, the runtime's assertion table, and
 * the channel provider-id maps ([[CORE25]] D17). `_cf_*`, `sqlite_*` and `d1_migrations` are excluded in SQL, by prefix.
 */
export const HIDDEN_TABLES: readonly string[] = ['deployment', 'unit_assertion', 'message_sources', 'thread_sources']

/** D6: a column's default label is its name with `_` as spaces and the first letter capitalised (`due_at` -> "Due at"). */
export const defaultLabel = (name: string): string => {
  const spaced = name.replaceAll('_', ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export const CATALOG: Catalog = {
  common: {
    id: 'Unique id (UUIDv7).',
    organization_id: 'The organisation that owns the row; always the deployment\'s single organisation.',
    created_by: 'The principal (user or agent) that created the row.',
    created_at: 'When the row was created.',
    updated_at: 'When the row last changed.',
    deleted_at: 'When the row was deleted (soft delete); null while the row is live.',
  },
  tables: {
    organizations: {
      label: 'Organizations',
      description: 'The organisation this workspace database belongs to. A D1 deployment holds exactly one.',
      columns: {
        id: 'The organisation id; equals the deployment marker.',
        name: 'Display name of the organisation.',
        auth_provider: 'The sign-in provider that owns the organisation link (for example clerk); null until linked.',
        auth_org_id: "The provider's id for this organisation; null until linked.",
        created_at: 'When the organisation was created.',
        updated_at: 'When the organisation last changed.',
      },
    },
    principals: {
      label: 'Principals',
      description: 'Everyone and everything that can act and be recorded as an actor: users, agents and the system. Read through the users and agents resources; no operation lists principals directly.',
      columns: {
        id: 'The principal id; users and agents reuse it as their own id.',
        kind: 'What kind of actor: user, agent or system.',
        created_at: 'When the principal was created.',
      },
    },
    events: {
      label: 'Events',
      description: 'The outbox: one row per change to a record, written in the same unit as the change. Hooks and the agent cursor read it; no operation lists it yet.',
      columns: {
        id: 'Event id (UUIDv7); ids increase with time, so the id is the cursor.',
        created_at: 'When the event was recorded.',
        type: 'Event type, resource.action (for example task.created).',
        resource_type: 'The kind of record that changed (for example task).',
        resource_id: 'The id of the record that changed.',
        actor_id: 'The principal that made the change.',
        before: 'The record before the change as JSON; null for a creation.',
        after: 'The record after the change as JSON; null for a deletion.',
      },
    },
    tasks: {
      label: 'Tasks',
      description: 'Something to do, optionally assigned and with a due date. Completion is derived from status.',
      columns: {
        title: 'What needs doing.',
        notes: "The task's own description. Research and context belong in associated notes.",
        status: 'open or done. Setting done stamps completed_at; setting open clears it.',
        due_at: 'When the task is due.',
        completed_at: 'When the task was marked done; null while open.',
        assignee_id: 'The principal responsible for the task, if any.',
      },
    },
    companies: {
      label: 'Companies',
      description: 'An organisation the workspace deals with. Contacts point at their primary company; further links are associations.',
      columns: {
        name: 'The company name.',
        domain: 'Its web or email domain, lowercase; unique among live companies.',
      },
    },
    contacts: {
      label: 'Contacts',
      description: 'A person the organisation deals with. Addresses live in identities.',
      columns: {
        name: 'The contact name; may be empty when only an address is known.',
        company_id: { label: 'Primary company', description: "The contact's primary company; further affiliations are associations." },
        merged_into_id: 'Set when this contact was merged into another; the row is then deleted and this points at the survivor.',
      },
    },
    identities: {
      label: 'Identities',
      description: 'An address (email or phone) that resolves to a contact, or to the organisation itself when own.',
      columns: {
        kind: 'email or phone.',
        value: 'The address; emails are stored lowercase.',
        contact_id: 'The contact the address belongs to; null for an address of the organisation itself.',
        own: "True for the organisation's own addresses (no contact); false for a contact's.",
      },
    },
    users: {
      label: 'Users',
      description: 'People who can sign in. Listed by the users operations (members:read); membership in the organisation is in memberships.',
      columns: {
        id: 'The user id; equals the principal id.',
        created_at: 'When the user was first seen.',
        updated_at: 'When the profile last changed.',
        email: 'Sign-in email, lowercase.',
        name: 'Display name from the sign-in provider.',
        auth_provider: 'The sign-in provider (for example clerk); null for a seeded user.',
        auth_subject: "The provider's id for the user; null for a seeded user.",
        email_verified: 'Whether the provider verified the email.',
      },
    },
    memberships: {
      label: 'Memberships',
      description: 'Which users belong to the organisation, and with which role. Kept in step with the sign-in provider.',
      columns: {
        user_id: 'The member.',
        role: 'owner (every scope) or member (the member-flagged scopes).',
        deleted_at: 'When the membership ended; null while the user is a member.',
      },
    },
    agents: {
      label: 'Agents',
      description: 'Software principals that read the vault and propose actions, each with a fixed list of scopes and its own API keys.',
      columns: {
        id: 'The agent id; equals the principal id.',
        name: 'Display name of the agent.',
        scopes: 'The scopes granted to the agent, as a JSON array of strings (for example tasks:read).',
        disabled_at: 'When the agent was disabled; null while enabled.',
      },
    },
    api_keys: {
      label: 'API keys',
      description: 'Credentials of agents. Only a hash is stored; the key itself is shown once, at creation.',
      columns: {
        agent_id: 'The agent the key authenticates as.',
        key_hash: 'Secret: hash of the key. Never returned by any operation.',
        prefix: 'The first characters of the key, to recognise it.',
        last_used_at: 'When the key last authenticated a request (approximate: stamped at most once a minute).',
        revoked_at: 'When the key was revoked; null while valid.',
        expires_at: 'When the key stops working; null for no expiry.',
      },
    },
    threads: {
      label: 'Threads',
      description: 'A conversation: the messages that belong together, on one channel.',
      columns: {
        channel: 'Where the conversation happens (email today).',
        subject: 'The conversation subject, if the channel has one.',
      },
    },
    messages: {
      label: 'Messages',
      description: 'One captured message (or reaction) in a thread. The body is not in the database: content_key points at stored content.',
      columns: {
        thread_id: 'The thread the message belongs to.',
        channel: 'The channel the message arrived on (email today).',
        kind: 'message or reaction.',
        external_id: "The channel's own id for the message (for email, the Message-ID header).",
        in_reply_to: 'The external id of the message this one replies to, if any.',
        author: "Who wrote it, as JSON (the author's user id, name and whether it is a bot).",
        occurred_at: 'When the message was sent or received.',
        preview: 'A short plain-text excerpt of the body.',
        content_key: 'Secret: the object-store key of the stored body. Never returned; read content through the message content operations.',
        version: 'Increases when the stored content of the message is replaced.',
        retracted_at: 'When the message was retracted by its author or the channel; null otherwise.',
      },
    },
    interactions: {
      label: 'Interactions',
      description: 'Something that happened between the organisation and others, on a timeline. Today each interaction is a message or reaction.',
      columns: {
        kind: 'message or reaction.',
        channel: 'The channel it happened on (email today).',
        direction: 'inbound or outbound, from the organisation\'s point of view.',
        occurred_at: 'When it happened.',
        thread_id: 'The thread of the underlying message.',
        message_id: 'The underlying message.',
      },
    },
    interaction_participants: {
      label: 'Interaction participants',
      description: 'Who took part in an interaction, by identity and role.',
      columns: {
        interaction_id: 'The interaction.',
        identity_id: 'The address that took part.',
        role: 'from, to, cc or bcc.',
      },
    },
    files: {
      label: 'Files',
      description: 'A stored file (an attachment or an upload). The bytes live in the object store; this row describes them.',
      columns: {
        name: 'The file name.',
        mime_type: 'The media type.',
        size_bytes: 'Size in bytes.',
        sha256: 'SHA-256 of the content, lowercase hex.',
        storage_key: 'Secret: the object-store key of the bytes. Never returned; download through the file content operations.',
      },
    },
    message_attachments: {
      label: 'Message attachments',
      description: 'The attachments of a message, in order, with the state of fetching each file.',
      columns: {
        message_id: 'The message the attachment belongs to.',
        position: 'The attachment\'s place in the message, from 0.',
        file_id: 'The stored file; null until the bytes are fetched.',
        type: 'image, file, video or audio.',
        name: 'The attachment name as sent.',
        mime_type: 'The media type as sent.',
        size_bytes: 'Size in bytes as sent.',
        inline: 'True when the attachment is embedded in the body (for example an inline image).',
        content_id: 'The Content-ID that the body uses to refer to an inline attachment.',
        fetch_status: 'stored, pending, failed or skipped.',
        fetch_metadata: 'Provider details about the fetch, as JSON.',
        fetch_error: 'Why the fetch failed, when it did.',
      },
    },
    contact_files: {
      label: 'Contact files',
      description: 'Links a file to a contact.',
      columns: {
        contact_id: 'The contact.',
        file_id: 'The file.',
      },
    },
    company_files: {
      label: 'Company files',
      description: 'Links a file to a company.',
      columns: {
        company_id: 'The company.',
        file_id: 'The file.',
      },
    },
    notes: {
      label: 'Notes',
      description: 'A Markdown note: research, context or a record of a conversation. A note belongs to nothing by itself; link it to other records through associations.',
      columns: {
        title: 'Optional short title.',
        content: 'The note body, Markdown.',
      },
    },
    associations: {
      label: 'Associations',
      description: 'Links between any two records of associable tables, stored once and undirected. Each end is a table name plus a record id (there is no foreign key; the vault checks both ends exist).',
      columns: {
        a_type: 'Table of the first end; the lower of the two ends in canonical order.',
        a_id: 'Record id of the first end.',
        b_type: 'Table of the second end.',
        b_id: 'Record id of the second end.',
        relation: 'The kind of link; only related_to exists today.',
      },
    },
  },
}
