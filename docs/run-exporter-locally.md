# Run the exporter locally

Run the Lovable Cloud to Supabase backend migration from your own machine using the CLI.

Once the data is moved, see [Choosing How You Build and Host](choosing-how-you-build-and-host.md) for your development and hosting options.

## Before you start

- Install dependencies with `pnpm install`.
- Make sure Docker is available. Export and download jobs run inside the local container runtime.
- Create a fresh target Supabase project. The DB clone path expects the target database to be blank.
- Access to your Lovable Cloud project you're looking to move

## What you'll need

- Target Supabase database URL
- Target Supabase project URL
- Target Supabase admin key

Get these three target values from the **target Supabase project**, not the source Lovable project:

- **Target Supabase database URL**: In the target Supabase dashboard, click `Connect` in the top bar. In the `Connection String` tab, choose `Type = URI`, `Source = Primary Database`, and `Method = Direct connection`, then copy the Postgres URI.
- **Target Supabase project URL**: This is the base project URL in the form `https://<project-ref>.supabase.co`. If you already copied the direct database connection string, you can derive it from the host. Example: if the DB host is `db.qicvuexedqhfkkyntpeh.supabase.co`, then the project URL is `https://qicvuexedqhfkkyntpeh.supabase.co`.
- **Target Supabase admin key**: In the target Supabase dashboard, go to `Settings -> API Keys` and copy a key from the `Secret keys` section. If your project still shows legacy keys, use the privileged `service_role` key. Do **not** use the publishable or anon key.

The source edge function is how the exporter securely gets the source `SUPABASE_DB_URL` and `SUPABASE_SERVICE_ROLE_KEY` for the migration.

## Quick start

1. Install dependencies.

   ```bash
   pnpm install
   ```

2. Generate the helper edge function source and a one-time access key.

   ```bash
   pnpm exporter -- setup edge-function
   ```

   Note down the `Generated access key`.

3. Deploy that helper to the source Lovable project.
   - In your source project, ask Lovable to create an empty edge function named `migrate-helper`.
   - Paste in the generated source from step 2.
   - Tell Lovable to deploy it. This makes your Lovable project accessible for transfer or export.
   - In Lovable UI, go to the Cloud -> Edge Functions -> migrate-helper -> Copy URL to get the edge function URL.

4. **If you want to transfer to your fresh Supabase**: Use the function URL from step 3 and the access key generated from step 2.

   ```bash
   pnpm exporter -- export run \
     --source-edge-function-url <source-edge-function-url> \
     --source-edge-function-access-key <source-edge-function-access-key> \
     --target-db-url <target-db-url> \
     --target-project-url <target-project-url> \
     --target-admin-key <target-admin-key> \
     --confirm-target-blank
   ```

   Before you run this, replace every placeholder value:
   - `<source-edge-function-url>`: replace this with the actual `migrate-helper` URL you copied from your source Lovable project in step 3. Example: `https://source-ref.supabase.co/functions/v1/migrate-helper`
   - `<source-edge-function-access-key>`: replace this with the access key printed by `pnpm exporter -- setup edge-function` in step 2.
   - `<target-db-url>`: replace this with the **target** Supabase Postgres connection string for the fresh project you are migrating into. Example: `postgresql://postgres:<password>@db.target-ref.supabase.co:5432/postgres`
   - `<target-project-url>`: replace this with the **target** Supabase project URL. Example: `https://target-ref.supabase.co`
   - `<target-admin-key>`: replace this with the **target** Supabase admin key.

   This command will call `migrate-helper` for you using the function URL and access key, and initiate the transfer to your target Supabase project.

5. Check status later with the printed `job_id` if needed.

   ```bash
   pnpm exporter -- job status --job-id <job-id>
   ```

6. **If you want a source-only ZIP instead of transferring to a fresh Supabase instance**, use the same source function details from steps 2 and 3.

   Before you run this, replace every placeholder value:
   - `<source-edge-function-url>`: replace this with the actual `migrate-helper` URL you copied from your source Lovable project in step 3. Example: `https://source-ref.supabase.co/functions/v1/migrate-helper`
   - `<source-edge-function-access-key>`: replace this with the access key printed by `pnpm exporter -- setup edge-function` in step 2. Example: the generated one-time key shown by the CLI

   Again, do not paste this command exactly as written. It is a template.

   ```bash
   pnpm exporter -- export download \
     --source-edge-function-url <source-edge-function-url> \
     --source-edge-function-access-key <source-edge-function-access-key>
   ```

`pnpm exporter -- ...` bootstraps the workspace CLI from this repo clone. `export run` and `export download` auto-generate a `job_id` when omitted.

7.  Transfer over configs

- [ ] Update the Supabase's env vars as well in Edge Function Secrets
- [ ] Reconfigure auth providers against the new Supabase project, including redirect URLs and any OAuth provider setup. And email templates.

## Useful variants

- `pnpm exporter -- db clone ...`: DB-only escape hatch.
- `pnpm exporter -- storage copy ...`: Storage-only escape hatch.
- `pnpm exporter -- job summary --job-id <id>`: Summary-only compatibility command.
- `pnpm exporter -- serve ...`: Local exporter API for the web UI or custom hosted flows.

## Good to know

- `--source-project-url` is optional for export and storage commands. If you omit it, it's derived from `--source-edge-function-url`.
- The exporter handles the supported migration path in this repo. It isn't a generic "copy every possible Supabase setting and metadata table" tool.
- By default, it skips bookkeeping tables (`auth.schema_migrations`, `storage.migrations`, `supabase_functions.migrations`) and ephemeral auth session and token tables. These are transient, regenerated, or environment-specific.
- Docker isn't required to inspect the repo or boot the frontend. It's required when the export or download job actually runs.
- In some environments, direct `db.<project-ref>.supabase.co` connections resolve to IPv6 only. If local clone runs fail with `Network unreachable`, enable IPv6 reachability or use the Supabase session pooler connection string instead.
- This tool moves data. You still need a separate deployment and cutover plan for code, env vars, auth provider setup, and hosting.
