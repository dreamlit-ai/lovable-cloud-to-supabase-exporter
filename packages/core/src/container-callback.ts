import { sanitizeLogText, sanitizeLogValue, sanitizeStoredLogText } from "./logging.js";

export type ContainerCallbackBody = {
  callback_token?: string;
  run_id?: string;
  level?: "info" | "warn" | "error";
  phase?: string;
  message?: string;
  data?: Record<string, unknown>;
  status?: "running" | "succeeded" | "failed";
  error?: string | null;
  finished_at?: string | null;
  debug_patch?: Record<string, unknown>;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const isJobEventLevel = (value: unknown): value is "info" | "warn" | "error" =>
  value === "info" || value === "warn" || value === "error";

const sanitizeDebugPatch = (
  debugPatch: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!debugPatch) return undefined;

  const sanitized = sanitizeLogValue(debugPatch) as Record<string, unknown>;
  if (typeof sanitized.monitor_raw_error === "string") {
    sanitized.monitor_raw_error = sanitizeStoredLogText(sanitized.monitor_raw_error);
  }
  return sanitized;
};

export const normalizeContainerCallbackBody = (
  body: Record<string, unknown>,
): ContainerCallbackBody | null => {
  const callbackToken = asNonEmptyString(body.callback_token);
  const runId = asNonEmptyString(body.run_id);
  const level = isJobEventLevel(body.level) ? body.level : null;
  const phase = asNonEmptyString(body.phase);
  const message = asNonEmptyString(body.message);
  const status =
    body.status === "running" || body.status === "succeeded" || body.status === "failed"
      ? body.status
      : undefined;
  const rawData = asRecord(body.data);
  const data = rawData ? (sanitizeLogValue(rawData) as Record<string, unknown>) : undefined;
  const rawDebugPatch = asRecord(body.debug_patch);
  const debugPatch = rawDebugPatch ? sanitizeDebugPatch(rawDebugPatch) : undefined;
  const errorValue =
    body.error === null
      ? null
      : typeof body.error === "string"
        ? sanitizeLogText(body.error)
        : undefined;
  const finishedAt =
    body.finished_at === null
      ? null
      : typeof body.finished_at === "string"
        ? body.finished_at
        : undefined;

  if (!callbackToken || !runId || !level || !phase || !message) {
    return null;
  }

  return {
    callback_token: callbackToken,
    run_id: runId,
    level,
    phase,
    message: sanitizeLogText(message),
    data,
    status,
    error: errorValue,
    finished_at: finishedAt,
    debug_patch: debugPatch,
  };
};
