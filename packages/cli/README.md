# Lovable Cloud to Supabase Exporter CLI

Move a Lovable Cloud backend into a Supabase project from your own machine.

## Requirements

- Node.js 22.x
- pnpm 10.x for the examples below, or `npx` with the same package name
- Docker, for export and download jobs
- A fresh target Supabase project for live transfers

## Quick start

Generate the temporary source-project helper:

```bash
pnpm dlx lovable-cloud-to-supabase-exporter@latest setup edge-function
```

Deploy that helper to the source Lovable Cloud project, then run a transfer:

```bash
pnpm dlx lovable-cloud-to-supabase-exporter@latest export run \
  --source-edge-function-url <source-edge-function-url> \
  --source-edge-function-access-key <source-edge-function-access-key> \
  --target-db-url <target-db-url> \
  --target-project-url <target-project-url> \
  --target-admin-key <target-admin-key> \
  --confirm-target-blank
```

To download a source-only ZIP instead:

```bash
pnpm dlx lovable-cloud-to-supabase-exporter@latest export download \
  --source-edge-function-url <source-edge-function-url> \
  --source-edge-function-access-key <source-edge-function-access-key>
```

Export jobs run the released runtime image that matches the CLI package version. From a repo clone, add `--build-local-runtime` when you are developing changes to `packages/container-runtime`.

Full docs: https://github.com/dreamlit-ai/lovable-cloud-to-supabase-exporter
