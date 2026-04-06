const POSTGRES_PROTOCOL_PATTERN = /^(postgres(?:ql)?):\/\//i;
const AUTHORITY_DELIMITER_PATTERN = /[/?#]/;
const HOST_AUTHORITY_PATTERN = /^(?:\[[^\]]+\]|[^\s/?#:@]+)(?::\d+)?$/;

const isPostgresProtocol = (protocol: string): boolean =>
  protocol === "postgres:" || protocol === "postgresql:";

const parseNormalizedPostgresUrl = (input: string): string | null => {
  try {
    const parsed = new URL(input);
    if (!isPostgresProtocol(parsed.protocol) || parsed.hash) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
};

const encodeUserInfoComponent = (value: string): string => {
  let encoded = "";

  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    if (current === "%" && /^[0-9a-fA-F]{2}$/.test(value.slice(index + 1, index + 3))) {
      encoded += value.slice(index, index + 3);
      index += 2;
      continue;
    }
    encoded += encodeURIComponent(current);
  }

  return encoded;
};

export const normalizePostgresUrl = (value: string): string => {
  const raw = value.trim();
  if (!raw) return "";

  const direct = parseNormalizedPostgresUrl(raw);
  if (direct) {
    return direct;
  }

  const protocolMatch = raw.match(POSTGRES_PROTOCOL_PATTERN);
  if (!protocolMatch) {
    return "";
  }

  const prefix = raw.slice(0, protocolMatch[0].length);
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
    const username =
      credentialSeparatorIndex === -1 ? userInfo : userInfo.slice(0, credentialSeparatorIndex);
    const password =
      credentialSeparatorIndex === -1 ? null : userInfo.slice(credentialSeparatorIndex + 1);
    if (!username) {
      continue;
    }

    const encodedUserInfo =
      encodeUserInfoComponent(username) +
      (password === null ? "" : `:${encodeUserInfoComponent(password)}`);
    const normalized = parseNormalizedPostgresUrl(`${prefix}${encodedUserInfo}@${hostAndSuffix}`);
    if (normalized) {
      return normalized;
    }
  }

  return "";
};

export const extractSupabaseProjectRefFromPostgresUrl = (value: string): string => {
  const normalized = normalizePostgresUrl(value);
  if (!normalized) {
    return "";
  }

  try {
    const parsed = new URL(normalized);
    const directHostMatch = parsed.hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i);
    if (directHostMatch?.[1]) {
      return directHostMatch[1];
    }

    const isPoolerHost = /\.pooler\.supabase\.com$/i.test(parsed.hostname);
    if (!isPoolerHost) {
      return "";
    }

    const poolerUsernameMatch = parsed.username.match(/\.([a-z0-9-]+)$/i);
    return poolerUsernameMatch?.[1] ?? "";
  } catch {
    return "";
  }
};
