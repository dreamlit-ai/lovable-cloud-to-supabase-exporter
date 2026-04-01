import type { JobRecord, StorageFailureEventData } from "./types.js";

const STORAGE_FAILURE_ACTIONS: StorageFailureEventData["storage_action"][] = [
  "list_source_buckets",
  "list_target_buckets",
  "create_target_bucket",
  "download_object",
  "upload_object",
];

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const asBoolean = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

export const asStorageFailureEventData = (value: unknown): StorageFailureEventData | null => {
  const record = asRecord(value);
  if (!record) return null;

  const storageAction = asString(record.storage_action);
  const projectHost = asString(record.project_host);
  const projectRole = asString(record.project_role);
  const attempts = asNumber(record.attempts);
  const retryable = asBoolean(record.retryable);

  if (
    !storageAction ||
    !STORAGE_FAILURE_ACTIONS.includes(storageAction as StorageFailureEventData["storage_action"]) ||
    !projectHost ||
    (projectRole !== "source" && projectRole !== "target") ||
    attempts === null ||
    retryable === null
  ) {
    return null;
  }

  return {
    storage_action: storageAction as StorageFailureEventData["storage_action"],
    bucket_id: asString(record.bucket_id),
    object_path: asString(record.object_path),
    prefix: asString(record.prefix),
    project_host: projectHost,
    project_role: projectRole,
    status_code: asNumber(record.status_code),
    attempts,
    retryable,
  };
};

export const formatStorageFailureContext = (
  details: StorageFailureEventData | null,
): string | null => {
  if (!details) return null;

  const location =
    details.bucket_id && details.object_path
      ? `${details.bucket_id}/${details.object_path}`
      : details.object_path || details.bucket_id;

  const parts: string[] = [details.storage_action.replaceAll("_", " ")];
  if (location) parts.push(location);
  if (details.status_code !== null) parts.push(`HTTP ${details.status_code}`);
  if (details.attempts > 1) parts.push(`${details.attempts} attempts`);

  return parts.length > 0 ? parts.join(" • ") : null;
};

export const getLatestStorageFailureEventData = (
  job: Pick<JobRecord, "events"> | null,
): StorageFailureEventData | null => {
  for (const event of [...(job?.events ?? [])].reverse()) {
    const parsed = asStorageFailureEventData(event.data);
    if (parsed) return parsed;
  }
  return null;
};
