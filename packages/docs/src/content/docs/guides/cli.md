---
title: Command line
description: Sign in, discover commands, and manage agent access with the Vibase CLI.
---

The CLI discovers operations from the instance you connect to. The examples use `pnpm vibase` from the repository root.

## Sign in to an instance

```bash
pnpm vibase login --server https://api.example.com
pnpm vibase me get
```

The CLI prints a URL and a code. Open the URL in a browser and approve the device login. Your instance must have its authentication provider (Better Auth, built in, or Clerk) and device login configured.

For API-key authentication, pass the key over stdin. With `VIBASE_API_KEY` supplied by your environment or secret manager:

```bash
printf '%s' "$VIBASE_API_KEY" | pnpm vibase login --api-key --server https://api.example.com
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

A device login by an owner holds the owner's permissions, and the CLI says so on stderr after login. Anything that uses that profile acts as the owner, so an agent should not share it.

For an agent account using device login:

1. As an owner, create an invitation with the agent role. The link is shown once; hand it to the agent over any channel.
2. The agent opens the link in a browser and signs up with an email address to claim the invitation.
3. The agent runs `pnpm vibase --profile agent login --server https://api.example.com`. Device login needs no human approval.
4. Use the agent ID printed at login to grant scopes from an owner session:

```bash
pnpm vibase agents update <agent-id> \
  --data '{"scopes":["contacts:read","contacts:write"]}'
```

New agent accounts start without scopes (permissions) until an owner grants them. On a Clerk instance, invite the agent in your Clerk application with public metadata `{"vibase_role":"agent"}` instead of creating an invitation. An owner can add or remove individual grants:

```bash
pnpm vibase agents update <agent-id> \
  --add-scopes '["tasks:read"]' \
  --remove-scopes '["contacts:write"]'
```

To stop an agent's access:

```bash
pnpm vibase agents update <agent-id> --data '{"disabled":true}'
```

## Use profiles and sign out

Use `--profile work` or `--profile agent` to keep identities separate. Profiles are stored under `$XDG_CONFIG_HOME/vibase/`, falling back to the platform's default config location.

```bash
pnpm vibase logout
```

OAuth logout revokes the refresh token and removes the saved profile. An already issued access token remains valid until expiry unless backend authorization blocks it.
