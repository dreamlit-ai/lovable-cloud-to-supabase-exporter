export type LogVerbosity = "normal" | "debug";

const REDACTED = "<redacted>";
const REDACTED_POSTGRES_URL = "<redacted-postgres-url>";
const DEFAULT_MAX_STORED_LOG_CHARS = 4000;

const SECRET_FIELD_NAMES = new Set([
  "apikey",
  "api_bearer_token",
  "callback_token",
  "progress_callback_token",
  "service_role_key",
  "source_admin_key",
  "source_db_url",
  "source_edge_function_access_key",
  "supabase_db_url",
  "supabase_service_role_key",
  "target_admin_key",
  "target_db_url",
  "x-access-key",
  "x-callback-token",
]);

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SECRET_FIELD_PATTERN = [...SECRET_FIELD_NAMES].map(escapeRegex).join("|");

const sanitizeSecretFieldAssignments = (input: string): string => {
  const doubleQuoted = new RegExp(
    `((?:"|')?(?:${SECRET_FIELD_PATTERN})(?:"|')?\\s*[:=]\\s*)"([^"\\r\\n]*)"`,
    "gi",
  );
  const singleQuoted = new RegExp(
    `((?:"|')?(?:${SECRET_FIELD_PATTERN})(?:"|')?\\s*[:=]\\s*)'([^'\\r\\n]*)'`,
    "gi",
  );
  const unquoted = new RegExp(
    `((?:"|')?(?:${SECRET_FIELD_PATTERN})(?:"|')?\\s*[:=]\\s*)([^"'\\s,}\\]]+)`,
    "gi",
  );

  return input
    .replace(doubleQuoted, `$1"${REDACTED}"`)
    .replace(singleQuoted, `$1'${REDACTED}'`)
    .replace(unquoted, `$1${REDACTED}`);
};

export const sanitizeLogText = (input: string): string => {
  let sanitized = input;

  sanitized = sanitized.replace(/\bpostgres(?:ql)?:\/\/[^\s"'`<>]+/gi, REDACTED_POSTGRES_URL);
  sanitized = sanitized.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, "Bearer <redacted>");
  sanitized = sanitizeSecretFieldAssignments(sanitized);

  return sanitized;
};

export const sanitizeLogValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    return sanitizeLogText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_FIELD_NAMES.has(key.toLowerCase())) {
      result[key] = REDACTED;
      continue;
    }
    result[key] = sanitizeLogValue(nested);
  }
  return result;
};

export const truncateLogText = (input: string, maxChars = DEFAULT_MAX_STORED_LOG_CHARS): string => {
  const trimmed = input.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  const omittedChars = trimmed.length - maxChars;
  const suffix = `\n[truncated ${omittedChars} chars]`;
  return `${trimmed.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd()}${suffix}`;
};

export const sanitizeStoredLogText = (
  input: string,
  maxChars = DEFAULT_MAX_STORED_LOG_CHARS,
): string => truncateLogText(sanitizeLogText(input), maxChars);

export const parseLogVerbosity = (value: unknown): LogVerbosity =>
  typeof value === "string" && value.trim().toLowerCase() === "debug" ? "debug" : "normal";
