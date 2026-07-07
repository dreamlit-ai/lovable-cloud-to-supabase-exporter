import { getLatestStorageFailureEventData } from "./job-failures.js";
import type {
  AuthUserMigrationSummary,
  JobRecord,
  MigrationSummary,
  RowCountVerificationSummary,
} from "./types.js";

const LOVABLE_MANUAL_ACTIONS = [
  "Reconfigure auth provider redirect URLs in your Supabase project.",
  "Validate login/password reset flow on Supabase.",
  "Reconfigure external service secrets in your Supabase project.",
  "Rotate Lovable Cloud DB credentials after cutover.",
  "Verify storage file access and auth flows end-to-end.",
  "Review Lovable post-cutover docs: https://docs.lovable.dev",
];

const POSTGRES_URL_MANUAL_ACTIONS = [
  "Point your app's DATABASE_URL at the new Supabase database.",
  "Swap your app's sign-in to Supabase Auth and validate the login flow.",
  "Recreate your app's secrets in the new hosting environment.",
  "Rotate the source database credentials after cutover.",
];

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
};

const asNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
};

const asAuthUserMigrationSummary = (value: unknown): AuthUserMigrationSummary | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const migrated = asNumber(record.migrated);
  const skippedNoEmail = asNumber(record.skipped_no_email);
  const skippedDuplicate = asNumber(record.skipped_duplicate);
  if (migrated === null || skippedNoEmail === null || skippedDuplicate === null) return null;
  return {
    migrated,
    skipped_no_email: skippedNoEmail,
    skipped_duplicate: skippedDuplicate,
  };
};

const asVerificationSummary = (value: unknown): RowCountVerificationSummary | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.ok !== "boolean" || !Array.isArray(record.tables)) return null;

  const tables = record.tables
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const tableRecord = item as Record<string, unknown>;
      const table = typeof tableRecord.table === "string" ? tableRecord.table : null;
      const sourceRows = asNumber(tableRecord.source_rows);
      const targetRows = asNumber(tableRecord.target_rows);
      if (!table || sourceRows === null || targetRows === null) return null;
      return {
        table,
        source_rows: sourceRows,
        target_rows: targetRows,
      };
    })
    .filter((item): item is RowCountVerificationSummary["tables"][number] => item !== null);

  return {
    ok: record.ok,
    tables,
  };
};

export const buildMigrationSummary = (job: JobRecord): MigrationSummary => {
  const buckets = new Set<string>();
  const tableRowHints: Array<{ table: string; rows: number | null }> = [];
  const skipped: Array<{ item: string; reason: string }> = [];
  const rlsEnabledTables = new Set<string>();

  let objectsCopied: number | null = null;
  let authUserMigration: AuthUserMigrationSummary | null = null;
  let verification: RowCountVerificationSummary | null = null;
  let isPostgresUrlSource = false;

  for (const event of job.events) {
    if (!event.data) continue;

    if (event.data.source_type === "postgres_url") {
      isPostgresUrlSource = true;
    }

    if (
      event.phase === "storage_copy.succeeded" ||
      event.phase === "storage_copy.partial" ||
      (event.phase === "storage_copy.failed" && asNumber(event.data.objects_total) !== null)
    ) {
      for (const bucket of asStringArray(event.data.bucket_ids)) {
        buckets.add(bucket);
      }
      const copied = asNumber(event.data.objects_copied);
      if (copied !== null) objectsCopied = copied;
      const failed = asNumber(event.data.objects_failed);
      if (failed && failed > 0) {
        skipped.push({ item: `storage objects (${failed})`, reason: "copy_failed" });
      }
      const existing = asNumber(event.data.objects_skipped_existing);
      if (existing && existing > 0) {
        skipped.push({ item: `storage objects (${existing})`, reason: "target_existing" });
      }
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

    for (const rlsTable of asStringArray(event.data.rls_enabled_tables)) {
      rlsEnabledTables.add(rlsTable);
    }

    const authSummary = asAuthUserMigrationSummary(event.data.auth_user_migration);
    if (authSummary) {
      authUserMigration = authSummary;
    }

    const verificationSummary = asVerificationSummary(event.data.verification);
    if (verificationSummary) {
      verification = verificationSummary;
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
    rls_enabled_tables: [...rlsEnabledTables],
    auth_user_migration: authUserMigration,
    verification,
    skipped,
    manualActions: isPostgresUrlSource ? POSTGRES_URL_MANUAL_ACTIONS : LOVABLE_MANUAL_ACTIONS,
    errors: {
      message: job.error,
      hint: job.debug?.failure_hint ?? null,
      class: job.debug?.failure_class ?? null,
      details: getLatestStorageFailureEventData(job),
    },
  };
};
