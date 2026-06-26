# CLI and API usage

The primary public interface is the CLI. The HTTP API exists to exercise the same exporter job flow locally and in the Worker/runtime adapter.

This repo contains the exporter components that are shared by CLI and Worker-backed runs:

- `packages/core`: shared job contracts, summaries, log redaction, and failure classification.
- `packages/cli`: the local CLI and local development API.
- `packages/cloudflare-exporter-worker`: the Cloudflare Worker and Durable Object adapter.
- `packages/container-runtime`: the Docker/Cloudflare Container runtime that performs export jobs.
- `edge-function`: the helper function users deploy temporarily into their source Lovable Cloud project.

When the API is not limited to loopback development, protect it as infrastructure:

1. Require `Authorization: Bearer <API_BEARER_TOKEN>`.
2. Call protected exporter endpoints only from trusted runtime environments.
3. The exporter Worker/container runs the migration job and stores transient job state.

Do not expose `API_BEARER_TOKEN` to browsers or untrusted clients.

## Local API development

Start the local exporter API from this repo:

```bash
pnpm install
pnpm api:dev
```

The local exporter API runs on `http://127.0.0.1:8799`.

Loopback development does not require a bearer token. If you bind the local API to a non-loopback host, pass `--token` or set:

```env
API_BEARER_TOKEN=shared-server-only-token
```

For the Cloudflare Worker, configure the same bearer secret:

```env
API_BEARER_TOKEN=shared-server-only-token
```

`SENTRY_DSN` is optional for worker/runtime error reporting.

Docker is not required to boot the local API. It becomes relevant once a transfer or ZIP export job starts.

## Published artifacts

The release workflow publishes the CLI package through Changesets and publishes the runtime image to GHCR.

- npm package / CLI binary: `lovable-cloud-to-supabase-exporter`
- container image: `ghcr.io/dreamlit-ai/supabase-migrate-runtime:<version>`

The HTTP API and CLI package are separate surfaces. Worker-backed jobs should be pinned to a released runtime image digest after release.

## Boundary

The API is a generic migration adapter. It owns exporter job execution, transient job state, callback validation, artifacts, summaries, diagnostics, and optional runtime error reporting.

Trusted server-side callers own concerns such as request authorization, user ownership, analytics events, onboarding flow, and user-facing error copy. Keep those concerns outside browser-exposed code before calling this API with `API_BEARER_TOKEN`.
