# lovable-cloud-to-supabase-exporter

## 0.4.0

### Minor Changes

- 49467c6: Reliability improvements for larger migrations:
  - Hosted runs route to bigger Cloudflare container instances by job-id suffix (`--runner-large` / `--runner-xl`); the default instance moves from lite to basic.
  - The target database connection test now also reports whether the target is empty, so a non-empty project is caught before a run starts instead of failing it.
  - Schema restore switched to `pg_restore` with a TOC list: non-data-bearing objects (functions, triggers, policies, views, indexes, constraints) that fail to create are skipped and reported on the run instead of failing the whole migration. Tables, sequences, and types remain fatal.
  - Storage copy: upload retries no longer resend a consumed body stream (small objects buffer, large objects re-download per retry); objects the target rejects as exceeding its upload size limit are skipped and reported instead of failing the run.
  - Hard timeout ceiling raised to two hours so larger runs can request more wall-clock.

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
