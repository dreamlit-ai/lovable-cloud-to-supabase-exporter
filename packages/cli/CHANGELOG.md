# lovable-cloud-to-supabase-exporter

## 0.3.1

### Patch Changes

- 1cc9108: Run local job containers on a dedicated dual-stack Docker network so psql can reach IPv6-only Supabase database hosts. Docker's default bridge has no IPv6, which made local exports and source inspection fail with "Network unreachable" on projects whose direct database host only publishes AAAA records. Falls back to the default bridge when the network cannot be created.

  Source inspection no longer swallows measurement failures: when a count cannot be measured, the failure reason is logged and reported on the `source_inspect.succeeded` event as `inspect_errors` instead of silently returning unknown counts.

## 0.3.0

### Minor Changes

- Add source-inspect job mode: measure a Lovable Cloud source (app schemas, app table count, storage object count) without running a migration, via the new start-source-inspect job action.

## 0.2.0

### Minor Changes

- Add support for using direct Postgres URLs as migration sources.
