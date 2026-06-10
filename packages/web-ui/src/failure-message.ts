import type { MigrationJobRecord } from "./job-polling";

export const isArtifactDeliveryTimeoutRecord = (record: MigrationJobRecord | null) =>
  record?.debug?.failure_class === "artifact_delivery_timeout";

const TARGET_DATABASE_STORAGE_EXHAUSTED_MESSAGE =
  "Supabase ran out of database storage while restoring data.";
const TARGET_DATABASE_STORAGE_EXHAUSTED_HINT =
  "Increase target database storage or retry into a larger fresh Supabase project.";

function looksLikeTargetDatabaseStorageExhaustion(value: string | null | undefined) {
  const lowered = normalizeFailureText(value).toLowerCase();
  return (
    lowered.includes("no space left on device") &&
    (lowered.includes("pg_wal/") ||
      lowered.includes("xlogtemp") ||
      lowered.includes("psql:/tmp/pg-clone/clone-data.pipe") ||
      (lowered.includes("writing block") && lowered.includes("relation base/")))
  );
}

export function isTargetDatabaseStorageExhaustionRecord(record: MigrationJobRecord | null) {
  const failureClass = record?.debug?.failure_class;
  if (failureClass === "target_db_storage_exhausted") return true;

  return (
    failureClass === "runtime_disk_exhausted" &&
    (looksLikeTargetDatabaseStorageExhaustion(record?.debug?.error_excerpt) ||
      looksLikeTargetDatabaseStorageExhaustion(record?.debug?.monitor_raw_error) ||
      looksLikeTargetDatabaseStorageExhaustion(record?.error))
  );
}

const GENERIC_FAILURE_PATTERNS = [
  /inspect status events/i,
  /status debug fields/i,
  /monitor_raw_error/i,
  /^export failed\.?$/i,
  /^storage copy failed\.?$/i,
  /^combined export failed.*$/i,
  /^zip export failed.*$/i,
  /inspect runtime logs/i,
  /internal server error/i,
];

function normalizeFailureText(value: string | null | undefined) {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

function textIncludesIgnoreCase(left: string, right: string) {
  const leftClean = normalizeFailureText(left).toLowerCase();
  const rightClean = normalizeFailureText(right).toLowerCase();
  return Boolean(leftClean && rightClean && leftClean.includes(rightClean));
}

function isGenericFailureMessage(message: string) {
  const cleaned = normalizeFailureText(message);
  if (!cleaned) return true;
  return GENERIC_FAILURE_PATTERNS.some((pattern) => pattern.test(cleaned));
}

export function getLatestFailureEvent(record: MigrationJobRecord | null) {
  return [...(record?.events ?? [])]
    .reverse()
    .find(
      (event) =>
        event.level === "error" &&
        (event.phase === "target_validation.failed" ||
          event.phase === "target_db_connection.failed" ||
          event.phase === "db_clone.failed" ||
          event.phase === "storage_copy.failed" ||
          event.phase === "download.failed" ||
          event.phase === "container.start_failed" ||
          event.phase === "monitor.failed" ||
          event.phase === "export.failed"),
    );
}

function formatFailureContext(data: Record<string, unknown> | undefined) {
  const storageAction = typeof data?.storage_action === "string" ? data.storage_action : "";
  const bucketId = typeof data?.bucket_id === "string" ? data.bucket_id : "";
  const objectPath = typeof data?.object_path === "string" ? data.object_path : "";
  const statusCode = typeof data?.status_code === "number" ? data.status_code : null;
  const attempts = typeof data?.attempts === "number" ? data.attempts : null;

  const location = bucketId && objectPath ? `${bucketId}/${objectPath}` : objectPath || bucketId;
  const parts: string[] = [];
  if (storageAction) parts.push(storageAction.replaceAll("_", " "));
  if (location) parts.push(location);
  if (statusCode !== null) parts.push(`HTTP ${statusCode}`);
  if (attempts !== null && attempts > 1) parts.push(`${attempts} attempts`);
  return parts.length > 0 ? `Context: ${parts.join(" - ")}` : "";
}

function joinMessageAndHint(message: string | null | undefined, hint: string | null | undefined) {
  const cleanedMessage = message?.trim() || "";
  const cleanedHint = hint?.trim() || "";

  if (cleanedMessage && cleanedHint) {
    if (cleanedMessage.toLowerCase() === cleanedHint.toLowerCase()) {
      return cleanedMessage;
    }
    return `${cleanedMessage} ${cleanedHint}`;
  }

  return cleanedMessage || cleanedHint || "";
}

export function buildFailureMessage(
  record: MigrationJobRecord | null,
  preferredMessage?: string | null,
  eventData?: Record<string, unknown>,
) {
  if (isArtifactDeliveryTimeoutRecord(record)) {
    return "Your ZIP was ready, but the temporary download stream expired before it was opened. Dreamlit did not store the ZIP. Start a new ZIP export and keep this tab open; if the download does not start automatically, click Download ZIP.";
  }

  if (isTargetDatabaseStorageExhaustionRecord(record)) {
    return `${TARGET_DATABASE_STORAGE_EXHAUSTED_MESSAGE} ${TARGET_DATABASE_STORAGE_EXHAUSTED_HINT}`;
  }

  const failureClass = record?.debug?.failure_class ?? null;
  const primaryMessage = normalizeFailureText(preferredMessage ?? record?.error);
  const diagnosticMessage =
    failureClass === "schema_restore_failed"
      ? normalizeFailureText(record?.debug?.error_excerpt) ||
        normalizeFailureText(record?.debug?.psql_diagnostic) ||
        normalizeFailureText(record?.debug?.restore_error_excerpt) ||
        normalizeFailureText(record?.debug?.monitor_raw_error)
      : normalizeFailureText(record?.debug?.psql_diagnostic) ||
        normalizeFailureText(record?.debug?.error_excerpt) ||
        normalizeFailureText(record?.debug?.restore_error_excerpt) ||
        normalizeFailureText(record?.debug?.monitor_raw_error);
  const hint = normalizeFailureText(record?.debug?.failure_hint);
  const targetDbGenericFailure =
    failureClass === "target_db_connection_failed" &&
    primaryMessage === "Could not connect to the Supabase database.";
  const shouldPreferDiagnostic =
    Boolean(diagnosticMessage) &&
    (isGenericFailureMessage(primaryMessage) ||
      !primaryMessage ||
      targetDbGenericFailure ||
      failureClass === "schema_restore_failed" ||
      failureClass === "target_extension_missing");
  const chosenMessage =
    shouldPreferDiagnostic && diagnosticMessage ? diagnosticMessage : primaryMessage;
  const diagnosticAlreadyHasExtensionGuidance =
    Boolean(diagnosticMessage) &&
    (textIncludesIgnoreCase(diagnosticMessage, "Enable these extensions") ||
      textIncludesIgnoreCase(diagnosticMessage, "Enable the listed extensions") ||
      textIncludesIgnoreCase(diagnosticMessage, "Enable the missing database extensions"));
  const effectiveHint =
    failureClass === "target_extension_missing" &&
    diagnosticMessage &&
    chosenMessage === diagnosticMessage &&
    diagnosticAlreadyHasExtensionGuidance
      ? null
      : hint;

  let message = joinMessageAndHint(chosenMessage, effectiveHint);
  const context = formatFailureContext(eventData);
  if (context && !textIncludesIgnoreCase(message, context.replace(/^Context:\s*/, ""))) {
    message = message ? `${message} ${context}` : context;
  }

  return message || "Export failed.";
}
