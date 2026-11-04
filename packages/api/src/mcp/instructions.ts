/**
 * [[API106]] D18: the `initialize` instructions, sent to every client. Every tool name it mentions is pinned to the registry by a
 * test, so a renamed operation cannot leave the text pointing at nothing. At most about 1,200 characters.
 */
export const INSTRUCTIONS = `This is a CRM: the system of record for a team's people, companies, conversations, notes and tasks.

Start with me_get to see who you are and what you may do, then schema_get to learn the record types and fields before you read or write records.

Search before you create, so records are not duplicated: identities_resolve finds a person by email, companies_list with the domain filter finds a company. Update what exists instead of creating a second copy.

Link records with associations (associations_create), and record where a fact came from as a note linked to the record it is about.

Lists page: pass the next_cursor of one answer as after in the next call.

Every write is attributed to you and shows in the record's history. Only the tools you are shown are open to you; a refusal names the scope you lack.`
