# migrate-helper

This edge function securely shares two source-project credentials during migration:
`SUPABASE_DB_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

## What this does

You call this endpoint from your migration tool.
If the request includes the correct `x-access-key`, the function returns the source DB URL and source service role key.
Use a fresh random key for this migration only, then remove or rotate it after migration is complete.

## Why these Supabase secrets are needed

- `SUPABASE_DB_URL`: lets the migration tool connect to the source database.
- `SUPABASE_SERVICE_ROLE_KEY`: lets the migration tool read source project data that requires admin access.

## Why `ACCESS_KEY` is separate

`ACCESS_KEY` is not a Supabase project secret.
It is a temporary shared key between your caller and this function, used only to authorize this one migration request flow.

## Supabase built-ins

`SUPABASE_DB_URL` and `SUPABASE_SERVICE_ROLE_KEY` are native Supabase Edge Function env vars.
This function only gates access to them for migration.

- https://supabase.com/docs/guides/functions/secrets
- https://supabase.com/docs/guides/api/api-keys
- https://supabase.com/docs/reference/postgres/connection-strings

## Precautions in this setup

- `ACCESS_KEY` must be long, random, and one-time for this migration.
- Requests fail unless `x-access-key` exactly matches `ACCESS_KEY`.
- Rotate/remove `ACCESS_KEY` after migration.

## Deploy with Lovable

1. Create an empty edge function named `migrate-helper` in your source project.
2. Copy/paste this repo's `edge-function/index.ts` into that function.
3. Set `ACCESS_KEY` in the file to a random one-time value.
4. In Lovable, ask it to deploy the latest edge functions.
5. Confirm `SUPABASE_DB_URL` and `SUPABASE_SERVICE_ROLE_KEY` exist in your source project secrets.

## Call example

```bash
curl -sS -X POST \
  -H "x-access-key: <ACCESS_KEY>" \
  -H "Content-Type: application/json" \
  "https://<source-project-ref>.supabase.co/functions/v1/migrate-helper"
```
