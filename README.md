# Lovable Cloud to Supabase Exporter

Move your Lovable Cloud project onto your own Supabase backend: data tables, users, and storage.

This repo gives you the CLI and runtime for running the transfer yourself, locally. It's also [hosted on Dreamlit](https://dreamlit.ai/tools/lovable-cloud-to-supabase-exporter) if you don't want to set anything up.

[![Lovable Cloud to Supabase Exporter hosted on Dreamlit](docs/images/hosted-site-screenshot.png)](https://dreamlit.ai/tools/lovable-cloud-to-supabase-exporter)

Once your data is on Supabase, you get to pick how you work. Lovable still works great for building and deploying. But if you want to develop in Claude Code, Cursor, or something else, that's on the table too. See the [Choosing How You Build and Host](docs/choosing-how-you-build-and-host.md).

## Why does this project exist?

Lovable has [documentation](https://docs.lovable.dev/tips-tricks/external-deployment-hosting#what-migrates-and-how) for moving to your own Supabase, but the process is rough:

1. Every user needs to reset their password. If you have real users, that's a non-starter.
2. You're exporting and importing table data via CSV, one table at a time, in the right dependency order.
3. Storage files need to be downloaded and re-uploaded individually.
4. The whole process is incomplete and easy to get wrong.

This tool handles the data move: tables, users, and storage move to your Supabase backend without password resets or manual work.

## Why move off Lovable Cloud?

Lovable Cloud is great for prototyping, but you might outgrow it:

- Costs add up as usage grows.
- You want direct ownership of your database, storage, and secrets.
- You want to connect external services like [Dreamlit](https://dreamlit.ai) or custom tooling.
- You want less vendor lock-in and more portability over the long term.

This doesn't mean leaving Lovable. You can keep building there while running the backend on your own Supabase, or move your whole workflow to Claude Code, Cursor, or whatever you prefer.

## What doesn't this tool cover?

- Supabase Edge Function deployments or other app code. Edge Functions are code, not database data. Bring their source over with your app code if you have it, then deploy them to the new Supabase project.
- API keys, secrets, or third-party service credentials. You'll set these up in your new environment.
- Login provider settings like OAuth configuration or redirect URLs.
- Temporary internal tables (session tokens, migration bookkeeping). These get regenerated automatically.
- App deployment, DNS, or hosting setup.
- The broader app setup. Moving data is usually one step in a larger migration.

## Get started

The fastest way to run the export is the [hosted app](https://dreamlit.ai/tools/lovable-cloud-to-supabase-exporter). No setup needed.

If you'd rather run it yourself:

### Requirements

- Node.js 22.x
- Docker, for export and download jobs
- pnpm 10.17.1 or a compatible pnpm 10.x release if you use the `pnpm dlx` examples

### Published CLI

```bash
pnpm dlx lovable-cloud-to-supabase-exporter@latest setup edge-function
```

Then follow [Run the Exporter Locally](docs/run-exporter-locally.md) for the full exporter flow.

### Develop from a repo clone

```bash
pnpm install
pnpm exporter -- setup edge-function
```

Use `pnpm exporter -- ...` when working inside this repository. Add `--build-local-runtime` to export or download commands when you are developing changes to `packages/container-runtime`.

### ZIP export

If you just want the raw data as an artifact instead of a live transfer, the tool supports downloading a ZIP export.

After the export, see the [Choosing How You Build and Host](docs/choosing-how-you-build-and-host.md) for development and hosting options.

## Repository layout

- `packages/cli`: CLI plus a local HTTP API for running exporter flows.
- `packages/core`: Shared migration contracts, summaries, log redaction, and failure handling.
- `packages/container-runtime`: Docker runtime used when export or download jobs actually run.
- `packages/cloudflare-exporter-worker`: Cloudflare Worker/container adapter used by the hosted path.
- `edge-function`: Source-project helper function that securely returns source credentials during migration.

This repo publishes the user-facing CLI package and the runtime image used by exporter jobs. The other workspace packages are shared code used by this repository.

## Validate and contribute

If you only want to validate the repo or get oriented:

```bash
pnpm install
pnpm check
pnpm test
pnpm build
```

For local API development, run `pnpm api:dev`.

Contribution guidelines live in [CONTRIBUTING.md](CONTRIBUTING.md).
