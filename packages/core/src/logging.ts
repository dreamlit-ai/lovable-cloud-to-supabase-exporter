export type LogVerbosity = "normal" | "debug";

const REDACTED = "<redacted>";
const REDACTED_POSTGRES_URL = "<redacted-postgres-url>";
const DEFAULT_MAX_STORED_LOG_CHARS = 32_000;
const DEFAULT_MAX_ERROR_EXCERPT_CHARS = 4_000;

export type FailureDiagnostics = {
  monitor_raw_error: string;
  error_excerpt: string | null;
  monitor_exit_code: number | null;
};

const SECRET_FIELD_NAMES = new Set([
  "access_token",
  "anon_key",
  "apikey",
  "api_bearer_token",
  "authorization",
  "callback_token",
  "db_password",
  "extra_secrets",
  "jwt",
  "password",
  "progress_callback_token",
  "secret",
  "service_role_key",
  "source_admin_key",
  "source_db_url",
  "source_edge_function_access_key",
  "supabase_db_url",
  "supabase_service_role_key",
  "target_admin_key",
  "target_db_url",
  "token",
  "x-access-key",
  "x-callback-token",
]);

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SECRET_FIELD_PATTERN = [...SECRET_FIELD_NAMES].map(escapeRegex).join("|");
const IPV6_ADDRESS_PATTERN =
  /(?<![A-Za-z0-9_:])(?:(?:[A-Fa-f0-9]{0,4}:){1,7}:[A-Fa-f0-9]{0,4}|(?:[A-Fa-f0-9]{1,4}:){4,7}[A-Fa-f0-9]{1,4})(?![A-Za-z0-9_:])/g;
const PUBLIC_HOST_SUFFIXES = new Set([
  "ai",
  "app",
  "biz",
  "cloud",
  "co",
  "com",
  "dev",
  "eu",
  "info",
  "io",
  "me",
  "net",
  "org",
  "tech",
  "uk",
  "us",
  "xyz",
]);

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

const sanitizeLikelyPublicHostnames = (input: string): string =>
  input.replace(/\b(?:[a-z0-9-]+\.){2,}[a-z]{2,}\b/gi, (hostname) => {
    const suffix = hostname.slice(hostname.lastIndexOf(".") + 1).toLowerCase();
    return PUBLIC_HOST_SUFFIXES.has(suffix) ? "<redacted-host>" : hostname;
  });

export const sanitizeLogText = (input: string): string => {
  let sanitized = input;

  sanitized = sanitized.replace(/\bpostgres(?:ql)?:\/\/[^\s"`<>]+/gi, REDACTED_POSTGRES_URL);
  sanitized = sanitized.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, "Bearer <redacted>");
  sanitized = sanitized.replace(
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    "<redacted-jwt>",
  );
  sanitized = sanitizeSecretFieldAssignments(sanitized);
  sanitized = sanitized.replace(
    /\b(host|hostaddr|user|password|dbname)=([^\s]+)/gi,
    "$1=<redacted>",
  );
  sanitized = sanitized.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<redacted-email>");
  sanitized = sanitized.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<redacted-ip>");
  sanitized = sanitized.replace(IPV6_ADDRESS_PATTERN, "<redacted-ip>");
  sanitized = sanitized.replace(
    /\b(server at|host(?: name)?|connection to)\s*(?:=|:)?\s*["'][^"']+["']/gi,
    '$1 "<redacted-host>"',
  );
  sanitized = sanitized.replace(
    /\b((?:(?:getaddrinfo\s+)?(?:ENOTFOUND|EAI_AGAIN)|(?:connect\s+)?(?:ECONNREFUSED|ETIMEDOUT)|connection to|server at|host(?:name| name)?)\s*(?:=|:)?\s*)[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?\b/gi,
    "$1<redacted-host>",
  );
  sanitized = sanitizeLikelyPublicHostnames(sanitized);

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

  const markerFor = (omittedChars: number) => `\n[truncated ${omittedChars} chars]\n`;
  let marker = markerFor(trimmed.length - maxChars);
  let availableChars = maxChars - marker.length;
  if (availableChars <= 0) {
    return marker.trim().slice(0, maxChars);
  }

  const headChars = Math.ceil(availableChars * 0.35);
  let tailChars = availableChars - headChars;
  const omittedChars = trimmed.length - headChars - tailChars;
  marker = markerFor(omittedChars);
  availableChars = maxChars - marker.length;
  tailChars = Math.max(0, availableChars - headChars);

  return `${trimmed.slice(0, headChars).trimEnd()}${marker}${trimmed
    .slice(trimmed.length - tailChars)
    .trimStart()}`;
};

export const sanitizeStoredLogText = (
  input: string,
  maxChars = DEFAULT_MAX_STORED_LOG_CHARS,
): string => truncateLogText(sanitizeLogText(input), maxChars);

const LOG_ERROR_LINE_PATTERN = /\b(?:error|fatal|panic):\s/i;
const EXTENSION_FAILURE_SUMMARY_PATTERN =
  /^\[clone\] target database is missing required extension setup:/;
const POLICY_ROLE_FAILURE_SUMMARY_PATTERN =
  /^\[clone\] target database is missing roles referenced by RLS policies:/;

export const extractLogErrorExcerpt = (
  input: string,
  maxChars = DEFAULT_MAX_ERROR_EXCERPT_CHARS,
): string | null => {
  const sanitized = sanitizeLogText(input).trim();
  if (!sanitized) {
    return null;
  }

  const lines = sanitized
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("[clone][warn]"));
  const extensionSummaryIndex = lines.findIndex((line) =>
    EXTENSION_FAILURE_SUMMARY_PATTERN.test(line),
  );
  if (extensionSummaryIndex >= 0) {
    let endIndex = Math.min(lines.length, extensionSummaryIndex + 12);
    for (let index = extensionSummaryIndex + 1; index < lines.length; index += 1) {
      if (lines[index]?.includes("Enable these extensions")) {
        endIndex = Math.min(lines.length, index + 1);
        break;
      }
    }

    const excerpt = lines.slice(extensionSummaryIndex, endIndex).join("\n");
    const labeledExcerpt =
      extensionSummaryIndex > 0 || endIndex < lines.length
        ? `[excerpt lines ${extensionSummaryIndex + 1}-${endIndex} of ${lines.length}]\n${excerpt}`
        : excerpt;

    return truncateLogText(labeledExcerpt, maxChars);
  }

  const policyRoleSummaryIndex = lines.findIndex((line) =>
    POLICY_ROLE_FAILURE_SUMMARY_PATTERN.test(line),
  );
  if (policyRoleSummaryIndex >= 0) {
    const endIndex = Math.min(lines.length, policyRoleSummaryIndex + 14);
    const excerpt = lines.slice(policyRoleSummaryIndex, endIndex).join("\n");
    return truncateLogText(excerpt, maxChars);
  }

  let errorLineIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (LOG_ERROR_LINE_PATTERN.test(lines[index] ?? "")) {
      errorLineIndex = index;
      break;
    }
  }

  if (errorLineIndex < 0) {
    return null;
  }

  let startIndex = errorLineIndex;
  for (let index = errorLineIndex - 1; index >= 0 && errorLineIndex - index <= 2; index -= 1) {
    if (LOG_ERROR_LINE_PATTERN.test(lines[index] ?? "")) {
      break;
    }
    startIndex = index;
  }
  const endIndex = Math.min(lines.length, errorLineIndex + 4);
  const excerpt = lines.slice(startIndex, endIndex).join("\n");
  const labeledExcerpt =
    startIndex > 0 || endIndex < lines.length
      ? `[excerpt lines ${startIndex + 1}-${endIndex} of ${lines.length}]\n${excerpt}`
      : excerpt;

  return truncateLogText(labeledExcerpt, maxChars);
};

export const buildFailureDiagnostics = (
  input: string,
  options: { exitCode?: number | null } = {},
): FailureDiagnostics => ({
  monitor_raw_error: sanitizeStoredLogText(input),
  error_excerpt: extractLogErrorExcerpt(input),
  monitor_exit_code: options.exitCode ?? null,
});

export const parseLogVerbosity = (value: unknown): LogVerbosity =>
  typeof value === "string" && value.trim().toLowerCase() === "debug" ? "debug" : "normal";
