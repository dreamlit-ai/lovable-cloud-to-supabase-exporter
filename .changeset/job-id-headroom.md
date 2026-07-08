---
"lovable-cloud-to-supabase-exporter": patch
---

Raise the job id length limit from 80 to 120 characters and shorten the worker's runner-size routing suffixes to `--rl` / `--rx`. Proxy-namespaced job ids (per-user digests plus a runner marker) exceeded 80 characters and were rejected with "Invalid Job ID" before the run could start.
