---
title: Command line
description: Sign in, discover commands, and work with records from the Vibase CLI.
---

The CLI discovers operations from the instance you connect to. The examples use `pnpm vibase` from the repository root.

## Sign in to an instance

```bash
pnpm vibase login --server https://crm.mycompany.com
pnpm vibase me get
```

The CLI prints a URL and a code. Open the URL in a browser and approve the device login. On a Better Auth instance a plain `login` asks for full access as you: your role, read on every request, including permissions added to the instance later, so a new custom object needs no new sign-in. A login made before this version keeps its list, so run `vibase login` once to get full access. `--scope contacts:read,contacts:write` limits a login to that list instead. An agent account that signs in is given what it was granted at that moment, never full access. Device login is built into every Better Auth instance, so there is nothing to configure. (A Clerk instance needs device authorization enabled in Clerk; see [using Clerk](/deployment/clerk/).)

For API-key authentication, pass the key over stdin. With `VIBASE_API_KEY` supplied by your environment or secret manager:

```bash
printf '%s' "$VIBASE_API_KEY" | pnpm vibase login --api-key --server https://crm.mycompany.com
```

## Work with records

```bash
pnpm vibase --help
pnpm vibase contacts list --limit 10
pnpm vibase contacts create --name "Ada Lovelace"
pnpm vibase contacts get <contact-id>
```

Put command words before flags. Body properties become flags in kebab case; `--data` accepts a JSON body, `@file.json`, or `-` for stdin. Use `--all` to follow list pagination.

Output is JSON, or one record per line for lists. Errors go to stderr. Exit codes are `0` for success, `1` for an API or network failure, and `2` for usage or configuration errors.

## Give an agent its own identity

A device login by an owner holds the owner's permissions, and the CLI says so on stderr after login. Anything that uses that profile acts as the owner, so an agent should not share it. Give each agent its own identity and grant it only the scopes it needs. Create the agent first (`vibase agents create`), then give it a credential. An agent that can use a browser takes an invitation (`vibase invitations create --agent-id <id> --email <agent-email>`): it claims the link in a browser, then runs `vibase login` as itself. A headless agent takes an API key (`vibase api-keys create --agent-id <id>`, then `vibase login --api-key --server <url>`). Keep each in its own `--profile`, and grant scopes with `vibase agents update <agent-id>`. See [create agents and manage permissions](/guides/agents/).

## Use profiles and sign out

Use `--profile work` or `--profile agent` to keep identities separate. Profiles are stored under `$XDG_CONFIG_HOME/vibase/`, falling back to the platform's default config location.

```bash
pnpm vibase logout
```

OAuth logout revokes the refresh token and removes the saved profile. An already issued access token remains valid until expiry unless backend authorization blocks it.
