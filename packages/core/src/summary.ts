import type { JobRecord, MigrationSummary } from "./types.js";

const MANUAL_ACTIONS = [
  "Reconfigure auth provider redirect URLs in the target project.",
  "Validate login/password reset flow on target.",
  "Reconfigure external service secrets in the target project.",
  "Rotate source DB credentials after cutover.",
  "Verify storage file access and auth flows end-to-end.",
  "Review Lovable post-cutover docs: https://docs.lovable.dev",
];

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
};

const asNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
};

export const buildMigrationSummary = (job: JobRecord): MigrationSummary => {
  const buckets = new Set<string>();
  const tableRowHints: Array<{ table: string; rows: number | null }> = [];
  const skipped: Array<{ item: string; reason: string }> = [];

  let objectsCopied: number | null = null;

  for (const event of job.events) {
    if (!event.data) continue;

    if (event.phase === "storage_copy.succeeded" || event.phase === "storage_copy.partial") {
      for (const bucket of asStringArray(event.data.bucket_ids)) {
        buckets.add(bucket);
      }
      const copied = asNumber(event.data.objects_copied);
      if (copied !== null) objectsCopied = copied;
      const missing = asNumber(event.data.objects_skipped_missing);
      if (missing && missing > 0) {
        skipped.push({ item: `storage objects (${missing})`, reason: "source_missing" });
      }
    }

    const table = typeof event.data.table === "string" ? event.data.table : null;
    const rows = asNumber(event.data.rows);
    if (table) {
      tableRowHints.push({ table, rows });
    }
  }

  return {
    status: job.status,
    task: job.debug?.task ?? null,
    moved: {
      schemas: [],
      buckets: [...buckets],
      tableRowHints,
      objectsCopied,
    },
    skipped,
    manualActions: MANUAL_ACTIONS,
    errors: {
      message: job.error,
      hint: job.debug?.failure_hint ?? null,
      class: job.debug?.failure_class ?? null,
    },
  };
};
