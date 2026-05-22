import type {
  JobRecord,
  StorageFailureAttemptError,
  StorageFailureEventData,
  StorageFailureRequestBodyKind,
} from "./types.js";

const STORAGE_FAILURE_ACTIONS: StorageFailureEventData["storage_action"][] = [
  "list_source_buckets",
  "list_target_buckets",
  "create_target_bucket",
  "download_object",
  "upload_object",
];

const STORAGE_FAILURE_REQUEST_BODY_KINDS: StorageFailureRequestBodyKind[] = [
  "none",
  "string",
  "array_buffer",
  "typed_array",
  "blob",
  "form_data",
  "url_search_params",
  "web_stream",
  "node_stream",
  "unknown",
];

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const asBoolean = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

const asRequestBodyKind = (value: unknown): StorageFailureRequestBodyKind | null =>
  typeof value === "string" &&
  STORAGE_FAILURE_REQUEST_BODY_KINDS.includes(value as StorageFailureRequestBodyKind)
    ? (value as StorageFailureRequestBodyKind)
    : null;

const asAttemptError = (value: unknown): StorageFailureAttemptError | null => {
  const record = asRecord(value);
  if (!record) return null;
  const attempt = asNumber(record.attempt);
  if (attempt === null) return null;
  return {
    attempt,
    error_name: asString(record.error_name),
    error_message: asString(record.error_message),
    error_code: asString(record.error_code),
    error_cause_name: asString(record.error_cause_name),
    error_cause_message: asString(record.error_cause_message),
    error_cause_code: asString(record.error_cause_code),
  };
};

const asAttemptErrorSample = (value: unknown): StorageFailureAttemptError[] | null => {
  if (!Array.isArray(value)) return null;
  return value
    .map(asAttemptError)
    .filter((item): item is StorageFailureAttemptError => Boolean(item));
};

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
    response_body_sample: asString(record.response_body_sample),
    request_body_kind: asRequestBodyKind(record.request_body_kind),
    object_size_bytes: asNumber(record.object_size_bytes),
    error_name: asString(record.error_name),
    error_message: asString(record.error_message),
    error_code: asString(record.error_code),
    error_cause_name: asString(record.error_cause_name),
    error_cause_message: asString(record.error_cause_message),
    error_cause_code: asString(record.error_cause_code),
    attempt_errors_sample: asAttemptErrorSample(record.attempt_errors_sample),
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
