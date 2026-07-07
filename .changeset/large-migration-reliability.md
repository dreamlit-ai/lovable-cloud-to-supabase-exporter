---
"lovable-cloud-to-supabase-exporter": minor
---

Reliability improvements for larger migrations:

- Hosted runs route to bigger Cloudflare container instances by job-id suffix (`--runner-large` / `--runner-xl`); the default instance moves from lite to basic.
- The target database connection test now also reports whether the target is empty, so a non-empty project is caught before a run starts instead of failing it.
- Schema restore switched to `pg_restore` with a TOC list: non-data-bearing objects (functions, triggers, policies, views, indexes, constraints) that fail to create are skipped and reported on the run instead of failing the whole migration. Tables, sequences, and types remain fatal.
- Storage copy: upload retries no longer resend a consumed body stream (small objects buffer, large objects re-download per retry); objects the target rejects as exceeding its upload size limit are skipped and reported instead of failing the run.
- Hard timeout ceiling raised to two hours so larger runs can request more wall-clock.
