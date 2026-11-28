# Vibase

**Vibase is an open-source, self-managed, headless CRM backend with native interfaces for AI agents.**

Every interaction (email today, more channels over time) lands in one database alongside your contacts, companies, notes, tasks and deals. The agents you bring read it and act on it through a command line, a remote MCP server or a REST API, and you decide what each agent may do. Vibase has no app of its own: it is the durable system of record that your agents, scripts and custom front ends share.

It is for small firms, and the consultants and IT teams who build for them, who want one shared record of every customer interaction that their own agents can work from, safely.

- **One place for every interaction.** Email and your CRM records sit together, so every agent and person works from the same history. Email is supported today; more channels are on the roadmap below.
- **Agents act within the authority you grant.** For each resource an owner grants an agent `read`, `request_approval` or `write`. An agent can act directly or propose for approval, and every write is attributed to the agent or person who made it.
- **Discoverable.** The schema is made of typed tables with real names and declared foreign keys, so agents and people can query and understand it. The instance publishes a discovery document and OpenAPI descriptions that list its operations.
- **Customizable.** It is headless (REST, MCP and the CLI), so you build the interface you want on top of it, agentically: dashboards, reports or whole apps, a generative UI. A typed TypeScript SDK (`@vibase/sdk`) helps you build them. You can also shape the data model to your business: custom objects and custom fields on contacts, companies, deals and tasks, declared in one schema file, plus a free-form property bag on every record.

## Documentation

**Full documentation: https://docs.vibase.ai** (concepts, quickstart, guides, API reference).

## Install

The command line is `@vibase/cli` (the `vibase` program); running an instance is the separate package `@vibase/server-d1` (the `vibase-server` program). Both need Node 22 or newer.

```bash
npm install -g @vibase/cli
npm install -g @vibase/server-d1
vibase --version
```

## Runs on Cloudflare

Cloudflare is the deployment target. Vibase deploys as a Cloudflare Worker with two D1 databases (one for CRM data, one for sign-in and access data), one instance per organisation, and also uses R2 (message bodies), Workflows (mail sync) and scheduled triggers. You run your own instance. The quickstart needs a Cloudflare account and a wrangler login; account details are handled during setup.

## Quickstart

Stand up an instance. The `init` command belongs to `vibase-server`, the program `@vibase/server-d1` installs, not to `vibase`. With no flags it asks for the instance name, API host, owner email and the sign-in and email providers, writes a settings file and a secrets file outside the package, and prints the command to run next:

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

Sign-in uses Better Auth, built into the instance. It is the default and the preferred way to authenticate: there is no external service to create, people join by owner invitation, and it provides sign-in, OAuth consent for MCP clients and CLI device login. Setup, Google sign-in and password reset are in https://docs.vibase.ai/deployment/self-hosting/.

Better Auth is designed for the Cloudflare Workers Paid plan. Password hashing may exceed the Free plan's 10 ms CPU limit on cold starts, and that cost has not been measured. Clerk is available as an alternative (`--auth clerk` at setup) and is known to work on the Free plan, but it needs your own Clerk application. An instance keeps the provider it was set up with.

## How agents connect

An agent is its own account with its own audit trail. There are three ways to connect one:

1. **MCP.** Agents and clients that speak the Model Context Protocol connect to the instance's remote MCP server.
2. **The CLI with device login.** Works with any agent that has a browser and a CLI, and needs no human to approve the login. An owner creates the agent, then an invitation for it (`vibase invitations create --agent-id <id> --email <agent-email> --delivery link`); the link is shown once, and the owner hands it to the agent over any channel (WhatsApp or Telegram, for example). The agent opens it in a browser, signs up with that email address to claim the invitation, then runs `vibase login --server <url>`. Device login works the same way on a Clerk instance.
3. **The CLI with an API key.** Works with any agent that has a CLI: `printf '%s' "$KEY" | vibase login --api-key --server <url>`.

An agent starts with the permissions the owner gave it at creation (none if no scopes were given). The owner grants or changes them per-resource `read`, `request_approval` or `write`.

## Status

Vibase is still in alpha. We will make every effort to avoid breaking changes. It runs on Cloudflare D1, with one CRM database and one control database per organisation. The CLI, the REST and MCP interfaces, permissions and approvals, custom objects and fields, aggregation, owner-managed OAuth clients for browser apps, the TypeScript SDK, and the Gmail connection are available today. What is coming is under Roadmap below.

## Roadmap

- More channels: WhatsApp, iMessage and others.
- Calendar sync. This is not available yet.

## Contributing

Contributor and agent guidance is in [AGENTS.md](https://github.com/benocodes/crm/blob/main/AGENTS.md). The source is at https://github.com/benocodes/crm.

## License

[MIT](LICENSE).
