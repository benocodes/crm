# Vibase

**Vibase is an open-source, self-managed, headless CRM backend with native interfaces for AI agents.**

Every interaction (email today, more channels over time) lands in one database alongside your contacts, companies, notes, tasks and deals. The agents you bring read it and act on it through a command line, a remote MCP server or a REST API, and you decide what each agent may do. Vibase has no app of its own: it is the durable system of record that your agents, scripts and custom front ends share.

It is for small firms, and the consultants and IT teams who build for them, who want their customer data in their own Cloudflare account and their own agents on top of it.

- **You own the instance.** Each organisation deploys its own instance in its own Cloudflare account: the API, the data and the sign-in.
- **Agents act within the authority you grant.** For each resource an owner grants an agent `read`, `request_approval` or `write`. An agent with `write` can act directly, including sending email; one with `request_approval` can only propose, and a person or another authorised agent approves. Provider credentials stay in the instance.
- **Discoverable.** The command line, the MCP tools and the OpenAPI documents all come from one registry of operations, so an agent can discover what exists and what it may do.

## Documentation

**Full documentation: https://docs.vibase.ai** (concepts, quickstart, guides, API reference).

## Install

The command line is `@vibase/cli` (the `vibase` program); running an instance is the separate package `@vibase/server-d1` (the `vibase-server` program). Both need Node 22 or newer.

```bash
npm install -g @vibase/cli
npm install -g @vibase/server-d1
vibase --version
```

## Quickstart

Stand up an instance (needs a Cloudflare account). The `init` command belongs to `vibase-server`, the program `@vibase/server-d1` installs, not to `vibase`. With no flags it asks for the instance name, API host, owner email and the sign-in and email providers, writes a settings file and a secrets file outside the package, and prints the command to run next:

```bash
vibase-server init
vibase-server setup --env <name>     # the command init prints for you
vibase-server status --env <name>
```

Then sign in and use it from the command line:

```bash
vibase login --server https://<your-api-host>   # prints a URL and a code; approve in a browser
vibase me get                                   # who you are and what you may do
vibase contacts create --name "Ada"
vibase contacts list --all --limit 100          # one record per line
vibase --help                                   # every operation of your instance, as a command
```

The commands are discovered from the instance you log in to, so `vibase --help` always matches its server. Step-by-step guides are at https://docs.vibase.ai.

## Sign-in

Vibase supports Better Auth (built into the instance) and Clerk for sign-in. You choose one when you set up the instance.

## How agents connect

An agent is its own account with its own audit trail. There are three ways to connect one:

1. **MCP.** Agents and clients that speak the Model Context Protocol connect to the instance's remote MCP server.
2. **The CLI with device login.** Works with any agent that has a browser and a CLI, and needs no human to approve the login. An owner creates an invitation with the agent role; the link is shown once, and the owner hands it to the agent over any channel (WhatsApp or Telegram, for example). The agent opens it in a browser, signs up with an email address to claim the invitation, then runs `vibase login --server <url>`.
3. **The CLI with an API key.** Works with any agent that has a CLI: `printf '%s' "$KEY" | vibase login --api-key --server <url>`.

A new agent account starts with no permissions. The owner then grants it per-resource `read`, `request_approval` or `write`.

## Status

The first release. Vibase runs on Cloudflare D1, one database per organisation. The CLI, the REST and MCP interfaces, permissions and approvals, and the Gmail connection are available. Expect breaking changes while the version is `0.x`.

## Roadmap

- Custom objects and columns.
- More channels: WhatsApp, iMessage and others.
- Calendar sync. This is not available yet.

## Contributing

Contributor and agent guidance is in [AGENTS.md](https://github.com/benocodes/crm/blob/main/AGENTS.md). The source is at https://github.com/benocodes/crm.

## License

[MIT](LICENSE)
