# Host the web app

Run the exporter through a browser, keep everything local, or self-host it instead of using the shared hosted deployment.

If you just want the hosted version, it's [hosted on Dreamlit](https://dreamlit.ai/tools/lovable-cloud-to-supabase-exporter).

## Architecture overview

At a high level, the app has four parts:

- **Browser UI**: The frontend is a standalone React app built with Vite. It collects the migration inputs, starts jobs, polls status, and handles ZIP downloads.
- **Exporter API**: The UI talks to an HTTP API. Locally, that API is the `packages/cli` server on `127.0.0.1:8799`. In the hosted setup, the same UI can talk to the Cloudflare Worker instead.
- **Job runtime**: The frontend does not run the migration itself. The API starts the actual job runtime. Locally that is the Docker-based runtime from `packages/container-runtime`. In the hosted path, the Worker starts one Cloudflare Container per export job and uses a Durable Object as the control plane and job-state store.
- **Optional sign-in**: Supabase Auth is optional for the standalone app. If you provide `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, the UI enables the magic-link sign-in flow. If you also provide `VITE_TURNSTILE_SITE_KEY`, the sign-in flow adds an optional Cloudflare Turnstile check. In the hosted Worker path, the frontend can send the signed-in Supabase bearer token and the Worker can validate it before allowing job start or status access.

## Repository layout

- `packages/web-ui`: React and Vite frontend for the standalone app.
- `packages/cli`: CLI plus the local API server that powers the transfer flow.
- `packages/core`: Shared migration logic.
- `packages/container-runtime`: Docker runtime used when a job actually starts.
- `packages/cloudflare-exporter-worker`: Hosted Cloudflare option if you want a managed control plane later.

## Run locally

1. Install dependencies.

   ```bash
   pnpm install
   ```

2. Create a local env file for the web UI.

   ```bash
   cp packages/web-ui/.env.example packages/web-ui/.env.local
   ```

3. Keep this API setting:

   ```env
   VITE_LOVABLE_EXPORTER_API_BASE_URL=http://127.0.0.1:8799
   ```

4. Set these only if you want the standalone app to require Supabase sign-in:

   ```env
   VITE_SUPABASE_URL=https://your-project-ref.supabase.co
   VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
   VITE_SUPABASE_REDIRECT_URL=http://localhost:5173
   VITE_TURNSTILE_SITE_KEY=your-turnstile-site-key
   ```

5. Start the full local stack.

   ```bash
   pnpm web:dev:full
   ```

6. Open the app at `http://localhost:5173/`.

The local exporter API runs on `http://127.0.0.1:8799`. If the auth envs are unset, the app loads normally and skips the sign-in gate.

## Useful variants

- `pnpm web:dev`: Frontend only.
- `pnpm web:api`: API only.
- `pnpm web:dev:full`: Frontend plus local API, both with watch mode.
- `pnpm web:check`: Web UI typecheck.
- `pnpm web:build`: Build the reusable web UI package.
- `pnpm web:build:app`: Build the standalone app into `packages/web-ui/app-dist`.
- `pnpm web:preview`: Preview the built app output.

## Build for static hosting

Build the standalone app:

```bash
pnpm web:build:app
```

The output lands in `packages/web-ui/app-dist`.

If you are serving the app under a subpath, set `VITE_APP_BASE_PATH` with a trailing slash before the build. Example:

```env
VITE_APP_BASE_PATH=/tools/lovable-cloud-to-supabase-exporter/
```

If a reverse proxy mounts the app at a subpath, strip that public prefix when forwarding requests to the standalone origin so `/tools/lovable-cloud-to-supabase-exporter/assets/*` resolves to `/assets/*`.

## Good to know

- Docker isn't required to boot the web app or local API. It becomes relevant once a transfer or ZIP export job starts.
- The app defaults to `http://127.0.0.1:8799` for the exporter API if `VITE_LOVABLE_EXPORTER_API_BASE_URL` isn't set.
- If `VITE_SUPABASE_REDIRECT_URL` is omitted, the app uses the current page URL as the magic-link redirect target.
- To integrate the exporter into another host app instead of the standalone page, use the reusable package `@dreamlit/lovable-cloud-to-supabase-exporter-web-ui`.
