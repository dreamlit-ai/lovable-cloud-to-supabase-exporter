---
"lovable-cloud-to-supabase-exporter": patch
---

Run local job containers on a dedicated dual-stack Docker network so psql can reach IPv6-only Supabase database hosts. Docker's default bridge has no IPv6, which made local exports and source inspection fail with "Network unreachable" on projects whose direct database host only publishes AAAA records. Falls back to the default bridge when the network cannot be created.
