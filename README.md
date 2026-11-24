# Vibase

**Vibase is an open-source, self-managed, headless CRM backend with native interfaces for AI agents.**

Every interaction (email today, more channels over time) lands in one database alongside your contacts, companies, notes, tasks and deals. The agents you bring read it and act on it through a command line, a remote MCP server or a REST API, and you decide what each agent may do. Vibase has no app of its own: it is the durable system of record that your agents, scripts and custom front ends share.

It is for small firms, and the consultants and IT teams who build for them, who want one shared record of every customer interaction that their own agents can work from, safely.

- **One place for every interaction.** Email and your CRM records sit together, so every agent and person works from the same history. Email is supported today; more channels are on the roadmap below.
- **Agents act within the authority you grant.** For each resource an owner grants an agent `read`, `request_approval` or `write`. An agent can act directly or propose for approval, and every write is attributed to the agent or person who made it.
- **Discoverable.** The schema is made of typed tables with real names and declared foreign keys, so agents and people can query and understand it. The instance publishes a discovery document and OpenAPI descriptions that list its operations.
- **Customizable.** It is headless (REST, MCP and the CLI), so you build the interface you want on top of it, agentically: dashboards, reports or whole apps, a generative UI. That works today. Shaping the data model to your business with custom objects and columns does not exist yet: it is coming (see Roadmap below).

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

Cloudflare is the deployment target. Vibase deploys as a Cloudflare Worker with a D1 database, one instance per organisation, and also uses R2 (message bodies), Workflows (mail sync) and scheduled triggers. You run your own instance. The quickstart needs a Cloudflare account and a wrangler login; account details are handled during setup.

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

Vibase supports Better Auth (built into the instance) and Clerk for sign-in. You choose one when you set up the instance.

On the Cloudflare Workers Free plan (10 ms CPU limit), Better Auth may exceed the limit on cold starts and password sign-in; its cost has not been measured. Clerk does not do Better Auth's work (building the instance, hashing passwords), so it is the safer choice on Free. Workers Paid is the safe plan for Better Auth. Details: https://docs.vibase.ai/deployment/self-hosting/.

## How agents connect

An agent is its own account with its own audit trail. There are three ways to connect one:

1. **MCP.** Agents and clients that speak the Model Context Protocol connect to the instance's remote MCP server.
2. **The CLI with device login.** Works with any agent that has a browser and a CLI, and needs no human to approve the login. An owner creates an invitation with the agent role; the link is shown once, and the owner hands it to the agent over any channel (WhatsApp or Telegram, for example). The agent opens it in a browser, signs up with an email address to claim the invitation, then runs `vibase login --server <url>`.
3. **The CLI with an API key.** Works with any agent that has a CLI: `printf '%s' "$KEY" | vibase login --api-key --server <url>`.

A new agent account starts with no permissions. The owner then grants it per-resource `read`, `request_approval` or `write`.

## Status

Vibase is still in alpha, before version 1, so expect breaking changes. It runs on Cloudflare D1, one database per organisation. The CLI, the REST and MCP interfaces, permissions and approvals, and the Gmail connection are available today. What is coming is under Roadmap below.

## Roadmap

- Custom objects and columns.
- More channels: WhatsApp, iMessage and others.
- Calendar sync. This is not available yet.

## Contributing

Contributor and agent guidance is in [AGENTS.md](https://github.com/benocodes/crm/blob/main/AGENTS.md). The source is at https://github.com/benocodes/crm.

## License

[MIT](LICENSE)
