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

The command line is `@vibase/cli`; running an instance is the separate package `@vibase/server-d1`. Both need Node 22 or newer.

```bash
npm install -g @vibase/cli
vibase --version
```

## Quickstart

Stand up an instance (needs a Cloudflare account; the settings and secrets files it writes live outside the package):

```bash
npx @vibase/server-d1 init --env <name> --api-host <host> --owner-email <email>
npx @vibase/server-d1 setup --env <name>
npx @vibase/server-d1 status --env <name>
```

Then sign in and use it from the command line:

```bash
vibase login --server https://<your-api-host>   # prints a URL and a code; approve in a browser
vibase me get                                   # who you are and what you may do
vibase contacts create --name "Ada"
vibase contacts list --all --limit 100          # one record per line
vibase --help                                   # every operation of your instance, as a command
```

The commands are discovered from the instance you log in to, so `vibase --help` always matches its server. Step-by-step guides, including connecting an agent over MCP or REST, are at https://docs.vibase.ai.

## Status

The first release. Vibase runs on Cloudflare D1, one database per organisation. The CLI, the REST and MCP interfaces, permissions and approvals, and the Gmail connection are available. Expect breaking changes while the version is `0.x`.

## Contributing

Contributor and agent guidance is in [AGENTS.md](https://github.com/benocodes/crm/blob/main/AGENTS.md). The source is at https://github.com/benocodes/crm.

## License

[MIT](LICENSE)
