# VPS Operations Observability API

Fastify and TypeScript API for collecting and querying infrastructure observability data.

## Scope

- VPS and backup indicators
- Database measurements and tenant-scoped samples
- Token usage, workflow execution, and error events
- Security and restore-test observations

## Local setup

1. Copy the root `.env.example` to `.env` and configure a local database.
2. Apply the migrations in `migrations/` in order.
3. Install dependencies with `pnpm install`.
4. Start the API with `pnpm dev`.

## Example endpoints

- `GET /health`
- `GET /api/v1/tenants`
- `GET /api/v1/vps?from=&to=`
- `GET /api/v1/backups?from=&to=`
- `GET /api/v1/database?from=&to=&tenant=`
- `GET /api/v1/tokens?from=&to=&tenant=`
- `GET /api/v1/errors?from=&to=&tenant=`
- `POST /api/v1/ingest/errors`
- `POST /api/v1/ingest/workflow-executions`

Tenant identifiers in the public examples are placeholders only.

## Scope note

This public copy contains implementation examples and migrations, not production records or deployment credentials.

## Docker

Keep `.env` outside images and use a local reverse proxy if exposing the API in a private environment.
