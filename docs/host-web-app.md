# Host the web app

Run the exporter through a browser, keep everything local, or self-host it instead of using the shared hosted deployment.

If you just want the hosted version, it's [hosted on Dreamlit](https://dreamlit.ai/tools/lovable-cloud-to-supabase-exporter).

## Architecture overview

At a high level, the app has four parts:

- **Browser UI**: The frontend is a standalone React app built with Vite. It collects the migration inputs, starts jobs, polls status, and handles ZIP downloads.
- **Exporter API**: The UI talks to an HTTP API. Locally, that API is the `packages/cli` server on `127.0.0.1:8799`. In the hosted setup, the same UI can talk to the Cloudflare Worker instead.
- **Job runtime**: The frontend does not run the migration itself. The API starts the actual job runtime. Locally that is the Docker-based runtime from `packages/container-runtime`. In the hosted path, the Worker starts one Cloudflare Container per export job and uses a Durable Object as the control plane and job-state store.
- **Optional sign-in and Brand Style**: Supabase Auth is optional for the standalone app. If you provide `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, the UI enables the magic-link sign-in flow. If you also provide `VITE_TURNSTILE_SITE_KEY`, the sign-in flow adds an optional Cloudflare Turnstile check. The signed-in Supabase user token is also used for the optional Brand Style profile.
- **Brand Style storage**: Brand Style extractions are stored by the Dreamlit webapp as leads keyed by the signed-in user's id and email. The exporter keeps no Brand Style database of its own; the exporter host's Supabase project is used only for magic-link sign-in.

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

5. Optional: configure Brand Style extraction for signed-in users. These values are read by the local exporter API and should not be exposed as `VITE_*` browser env vars.

   ```env
   SUPABASE_URL=https://your-project-ref.supabase.co
   SUPABASE_ANON_KEY=your-supabase-anon-key
   SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
   BRAND_STYLE_EXTRACTOR_API=https://app.dreamlit.ai/api/exporter/brand-style
   LANDING_TO_WEBAPP_HMAC_SECRET=shared-secret-from-the-dreamlit-webapp
   ```

6. Start the full local stack.

   ```bash
   pnpm web:dev:full
   ```

7. Open the app at `http://localhost:5173/`.

The local exporter API runs on `http://127.0.0.1:8799`. If the auth envs are unset, the app loads normally and skips the sign-in gate.

## Brand Style storage

Brand Style extractions are stored by the Dreamlit webapp (the `ExporterBrandStyleLead` table), keyed by the signed-in exporter user id and email. The exporter API holds no Brand Style data: extraction requests are forwarded to the webapp, and on sign-in the exporter API asks the webapp for the user's latest stored lead.

The extractor API is called only from the exporter API with the `x-landing-secret` header (the same shared secret the Dreamlit landing page uses for webapp callbacks). The Dreamlit webapp extracts the brand style and also stores it as a claimable lead alongside the signed-in user's email. If `BRAND_STYLE_EXTRACTOR_API` or `LANDING_TO_WEBAPP_HMAC_SECRET` is unset, the Brand Style route returns a configuration error and no website URL is sent to Dreamlit.

## Useful variants

- `pnpm web:dev`: Frontend only.
- `pnpm web:api`: API only.
- `pnpm web:dev:full`: Frontend plus local API, both with watch mode.
- `pnpm web:check`: Web UI typecheck.
- `pnpm web:build`: Build the reusable web UI package.
- `pnpm web:build:app`: Build the standalone app into `packages/web-ui/app-dist`.
- `pnpm web:preview`: Preview the built app output.
- `pnpm db:migrate`: Create and run local Prisma migrations for exporter-owned metadata.
- `pnpm db:deploy`: Apply checked-in Prisma migrations to the exporter host database.

## Build for static hosting

Build the standalone app:

```bash
pnpm web:build:app
```

The output lands in `packages/web-ui/app-dist`.

The build output is prerendered at build time, so `index.html` includes the
actual app markup plus canonical, Open Graph, Twitter, and JSON-LD SEO tags
before any JavaScript runs.

If you are serving the app under a subpath, set `VITE_APP_BASE_PATH` with a trailing slash before the build. Example:

```env
VITE_APP_BASE_PATH=/tools/lovable-cloud-to-supabase-exporter/
```

If you are self-hosting under your own domain, also set one of these so the
canonical URL points at your deployment instead of the Dreamlit-hosted route:

```env
VITE_PUBLIC_SITE_URL=https://your-domain.com
# Optional explicit override:
VITE_CANONICAL_URL=https://your-domain.com/tools/lovable-cloud-to-supabase-exporter
```

If a reverse proxy mounts the app at a subpath, strip that public prefix when forwarding requests to the standalone origin so `/tools/lovable-cloud-to-supabase-exporter/assets/*` resolves to `/assets/*`.

## Good to know

- Docker isn't required to boot the web app or local API. It becomes relevant once a transfer or ZIP export job starts.
- The app defaults to `http://127.0.0.1:8799` for the exporter API if `VITE_LOVABLE_EXPORTER_API_BASE_URL` isn't set.
- If `VITE_SUPABASE_REDIRECT_URL` is omitted, the app uses the current page URL as the magic-link redirect target.
- To integrate the exporter into another host app instead of the standalone page, use the reusable package `@dreamlit/lovable-cloud-to-supabase-exporter-web-ui`.
