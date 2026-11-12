# crm

A headless CRM for small firms and the consultants who serve them. One database holds every
interaction; agents read it and propose actions; people approve them from their email client.

Product thinking and architecture live in the private knowledge repo (`benocodes/crm-knowledge`).
Contributor and agent guidance is in [AGENTS.md](AGENTS.md).

The public documentation site uses Astro and Starlight in [packages/docs](packages/docs/README.md).
Run it locally with `pnpm -C packages/docs dev`.

Status: pre-code. The first cycles build the tenancy, schema and service layer.

## License

[GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).
