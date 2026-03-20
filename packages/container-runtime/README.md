# @dreamlit/lovable-cloud-to-supabase-exporter-container-runtime

Shared container runtime for combined export jobs, ZIP exports, and DB clone work.

## Includes

- `Dockerfile`
- `run-clone.sh`

Build locally:

```bash
docker build -f packages/container-runtime/Dockerfile -t lovable-cloud-to-supabase-exporter-runtime:local .
```
