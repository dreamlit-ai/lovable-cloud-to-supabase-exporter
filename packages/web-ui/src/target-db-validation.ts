import { normalizePostgresUrl } from "./postgres-url";

const DB_PASSWORD_PLACEHOLDER = "[YOUR-PASSWORD]";
const POSTGRES_PROTOCOL_PATTERN = /^(postgres(?:ql)?):\/\//i;
const AUTHORITY_DELIMITER_PATTERN = /[/?#]/;
const HOST_AUTHORITY_PATTERN = /^(?:\[[^\]]+\]|[^\s/?#:@]+)(?::\d+)?$/;

export type TargetDbPasswordIssue = "placeholder" | "wrapped-in-brackets";

const decodeUrlComponent = (value: string): string => {
  if (!value) return "";

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const getDecodedTargetDbPassword = (value: string): string | null => {
  const normalized = normalizePostgresUrl(value);
  if (!normalized) return null;

  try {
    return decodeUrlComponent(new URL(normalized).password);
  } catch {
    return null;
  }
};

const getRawTargetDbPassword = (value: string): string | null => {
  const raw = value.trim();
  const protocolMatch = raw.match(POSTGRES_PROTOCOL_PATTERN);
  if (!protocolMatch) {
    return null;
  }

  const remainder = raw.slice(protocolMatch[0].length);

  for (let index = 0; index < remainder.length; index += 1) {
    if (remainder[index] !== "@") continue;

    const userInfo = remainder.slice(0, index);
    const hostAndSuffix = remainder.slice(index + 1);
    if (!userInfo || !hostAndSuffix || /^[/?#]/.test(hostAndSuffix)) {
      continue;
    }

    const authorityEnd = hostAndSuffix.search(AUTHORITY_DELIMITER_PATTERN);
    const authority = authorityEnd === -1 ? hostAndSuffix : hostAndSuffix.slice(0, authorityEnd);
    if (!authority || !HOST_AUTHORITY_PATTERN.test(authority)) {
      continue;
    }

    const credentialSeparatorIndex = userInfo.indexOf(":");
    if (credentialSeparatorIndex === -1) {
      return null;
    }

    const username = userInfo.slice(0, credentialSeparatorIndex);
    if (!username) {
      continue;
    }

    return userInfo.slice(credentialSeparatorIndex + 1);
  }

  return null;
};

export function detectTargetDbPasswordIssue(value: string): TargetDbPasswordIssue | null {
  const raw = value.trim();
  if (!raw) return null;

  const rawPassword = getRawTargetDbPassword(raw);
  if (rawPassword === DB_PASSWORD_PLACEHOLDER) {
    return "placeholder";
  }

  const password = getDecodedTargetDbPassword(raw);
  if (!password) return null;

  if (password === DB_PASSWORD_PLACEHOLDER) {
    return "placeholder";
  }

  if (
    rawPassword &&
    rawPassword.length > 2 &&
    rawPassword.startsWith("[") &&
    rawPassword.endsWith("]")
  ) {
    return "wrapped-in-brackets";
  }

  return null;
}

export function getTargetDbValidationError({
  targetDbUrl,
  targetDbUrlInput,
  targetProjectUrl,
}: {
  targetDbUrl: string;
  targetDbUrlInput: string;
  targetProjectUrl: string;
}) {
  const passwordIssue = detectTargetDbPasswordIssue(targetDbUrlInput || targetDbUrl);
  if (passwordIssue === "placeholder") {
    return "Password placeholder detected. Replace [YOUR-PASSWORD] above with your database password. You can reset your password if you forgot it in your project's Database Settings.";
  }

  if (passwordIssue === "wrapped-in-brackets") {
    return "Your DB password still looks wrapped in square brackets. Supabase shows [YOUR-PASSWORD] as a placeholder, so replace the whole bracketed value with your real password, without the brackets.";
  }

  if (targetDbUrlInput && !targetDbUrl) {
    return "Paste a valid Postgres connection string.";
  }

  if (targetDbUrl && !targetProjectUrl) {
    return "Paste a Supabase direct connection or session pooler connection string.";
  }

  return "";
}
