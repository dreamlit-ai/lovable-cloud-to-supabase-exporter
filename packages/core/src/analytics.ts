import { getLatestStorageFailureEventData } from "./job-failures.js";
import type { JobRecord, JobTask, StorageCopyMode, StorageFailureAction } from "./types.js";

export type ExporterAnalyticsAction = "transfer" | "download";
export type ExporterAnalyticsVariant = "full" | "storage-only";
export type ExporterAnalyticsFailureOwner =
  | "user_input"
  | "auth_session"
  | "source_project"
  | "target_project"
  | "dreamlit_tool"
  | "unknown";

export type ExporterAnalyticsContext = {
  posthog_distinct_id: string | null;
  posthog_session_id: string | null;
  posthog_project_key: string | null;
  posthog_host: string | null;
};

export type ExporterJobAnalyticsSummary = {
  action: ExporterAnalyticsAction | null;
  variant: ExporterAnalyticsVariant | null;
  task: JobTask | null;
  outcome: JobRecord["status"];
  duration_ms: number | null;
  db_table_count: number | null;
  storage_buckets_total: number | null;
  storage_objects_total: number | null;
  storage_objects_copied: number | null;
  storage_objects_failed: number | null;
  storage_objects_skipped_existing: number | null;
  storage_objects_skipped_missing: number | null;
  storage_copy_mode: StorageCopyMode | null;
  storage_copy_concurrency: number | null;
  hard_timeout_seconds: number | null;
  failure_phase: string | null;
  failure_class: string | null;
  failure_owner: ExporterAnalyticsFailureOwner | null;
  storage_failure_action: StorageFailureAction | null;
  storage_failure_project_role: "source" | "target" | null;
  storage_failure_status_code: number | null;
  storage_failure_retryable: boolean | null;
  monitor_exit_code: number | null;
  job_id_hash: string | null;
  run_id_hash: string | null;
};

export type BuildExporterJobAnalyticsSummaryOptions = {
  action?: ExporterAnalyticsAction | null;
  variant?: ExporterAnalyticsVariant | null;
  jobIdHash?: string | null;
  runIdHash?: string | null;
};

const USER_INPUT_FAILURE_CLASSES = new Set(["runtime_config_invalid", "target_db_not_empty"]);
const SOURCE_PROJECT_FAILURE_CLASSES = new Set([
  "schema_dump_failed",
  "data_dump_failed",
  "source_edge_function_resolve_failed",
  "source_admin_key_missing",
]);
const TARGET_PROJECT_FAILURE_CLASSES = new Set([
  "schema_restore_failed",
  "data_restore_failed",
  "session_replication_role_permission_denied",
  "target_db_connection_failed",
  "target_db_inspection_failed",
]);
const DREAMLIT_TOOL_FAILURE_CLASSES = new Set([
  "progress_callback_failed",
  "runtime_dependency_missing",
  "runtime_disk_exhausted",
  "local_runtime_error",
]);

const asFiniteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const parseTimestamp = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const getDurationMs = (record: JobRecord): number | null => {
  const startedAt = parseTimestamp(record.started_at);
  const finishedAt = parseTimestamp(record.finished_at);
  if (startedAt === null || finishedAt === null || finishedAt < startedAt) return null;
  return finishedAt - startedAt;
};

const getLatestNumericEventValue = (
  record: JobRecord,
  fieldNames: readonly string[],
): number | null => {
  for (const event of [...record.events].reverse()) {
    for (const fieldName of fieldNames) {
      const value = asFiniteNumber(event.data?.[fieldName]);
      if (value !== null) return value;
    }
  }
  return null;
};

const getLatestStorageMetrics = (record: JobRecord) => {
  for (const event of [...record.events].reverse()) {
    if (
      event.phase !== "storage_copy.succeeded" &&
      event.phase !== "storage_copy.partial" &&
      event.phase !== "storage_copy.failed" &&
      event.phase !== "storage_copy.progress"
    ) {
      continue;
    }

    const objectsTotal = asFiniteNumber(event.data?.objects_total);
    const objectsCopied = asFiniteNumber(event.data?.objects_copied);
    if (objectsTotal === null && objectsCopied === null) continue;

    const bucketIds = Array.isArray(event.data?.bucket_ids)
      ? event.data.bucket_ids.filter((bucketId): bucketId is string => typeof bucketId === "string")
      : [];

    return {
      bucketsTotal:
        asFiniteNumber(event.data?.buckets_total) ??
        (bucketIds.length > 0 ? bucketIds.length : null),
      objectsTotal,
      objectsCopied,
      objectsFailed: asFiniteNumber(event.data?.objects_failed) ?? 0,
      objectsSkippedExisting: asFiniteNumber(event.data?.objects_skipped_existing) ?? 0,
      objectsSkippedMissing: asFiniteNumber(event.data?.objects_skipped_missing) ?? 0,
    };
  }

  return null;
};

const getLatestFailureEvent = (record: JobRecord) =>
  [...record.events].reverse().find((event) => event.level === "error") ?? null;

export const classifyExporterFailureOwner = (
  failureClass: string | null,
  record?: Pick<JobRecord, "events"> | null,
): ExporterAnalyticsFailureOwner | null => {
  if (!failureClass) return null;

  const storageFailure = getLatestStorageFailureEventData(record ?? null);
  if (storageFailure) {
    return storageFailure.project_role === "source" ? "source_project" : "target_project";
  }

  if (USER_INPUT_FAILURE_CLASSES.has(failureClass)) return "user_input";
  if (SOURCE_PROJECT_FAILURE_CLASSES.has(failureClass)) return "source_project";
  if (TARGET_PROJECT_FAILURE_CLASSES.has(failureClass)) return "target_project";
  if (DREAMLIT_TOOL_FAILURE_CLASSES.has(failureClass)) return "dreamlit_tool";

  return "unknown";
};

export const buildExporterJobAnalyticsSummary = (
  record: JobRecord,
  options: BuildExporterJobAnalyticsSummaryOptions = {},
): ExporterJobAnalyticsSummary => {
  const storageMetrics = getLatestStorageMetrics(record);
  const failureEvent = getLatestFailureEvent(record);
  const failureClass = record.debug?.failure_class ?? null;
  const storageFailure = getLatestStorageFailureEventData(record);

  return {
    action: options.action ?? null,
    variant: options.variant ?? null,
    task: record.debug?.task ?? null,
    outcome: record.status,
    duration_ms: getDurationMs(record),
    db_table_count: getLatestNumericEventValue(record, ["table_count", "source_table_count"]),
    storage_buckets_total: storageMetrics?.bucketsTotal ?? null,
    storage_objects_total: storageMetrics?.objectsTotal ?? null,
    storage_objects_copied: storageMetrics?.objectsCopied ?? null,
    storage_objects_failed: storageMetrics?.objectsFailed ?? null,
    storage_objects_skipped_existing: storageMetrics?.objectsSkippedExisting ?? null,
    storage_objects_skipped_missing: storageMetrics?.objectsSkippedMissing ?? null,
    storage_copy_mode: record.debug?.storage_copy_mode ?? null,
    storage_copy_concurrency: record.debug?.storage_copy_concurrency ?? null,
    hard_timeout_seconds: record.debug?.hard_timeout_seconds ?? null,
    failure_phase: failureEvent?.phase ?? null,
    failure_class: failureClass,
    failure_owner: classifyExporterFailureOwner(failureClass, record),
    storage_failure_action: storageFailure?.storage_action ?? null,
    storage_failure_project_role: storageFailure?.project_role ?? null,
    storage_failure_status_code: storageFailure?.status_code ?? null,
    storage_failure_retryable: storageFailure?.retryable ?? null,
    monitor_exit_code: record.debug?.monitor_exit_code ?? null,
    job_id_hash: options.jobIdHash ?? null,
    run_id_hash: options.runIdHash ?? null,
  };
};
