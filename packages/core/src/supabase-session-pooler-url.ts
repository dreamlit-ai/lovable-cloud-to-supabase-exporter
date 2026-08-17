/**
 * Supabase "direct" DB hostnames are often IPv6-only on the free tier. Session pooler
 * hostnames under *.pooler.supabase.com are reachable over IPv4. These helpers build
 * session-pooler URLs from a direct `db.<ref>.supabase.co` connection string so callers
 * can probe fallbacks with psql.
 *
 * Pooler fleet + shard (`aws-0` vs `aws-1`) is per project/region and cannot be derived
 * from the project ref alone; we try a wide default set and honor SUPABASE_SESSION_POOLER_HOSTS.
 */

const dedupePoolerHostsPreserveOrder = (hosts: readonly string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const host of hosts) {
    const key = host.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(host);
  }

  return out;
};

/**
 * AWS regions commonly used for Supabase hosted projects (shared Supavisor poolers).
 * Both `aws-0-<region>` and `aws-1-<region>` are generated where Supabase uses dual shards.
 */
const SUPABASE_AWS_POOLER_COVERED_REGIONS: readonly string[] = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ca-central-1",
  "ca-west-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
  "ap-east-1",
  "ap-south-1",
  "ap-south-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "me-central-1",
  "me-south-1",
  "af-south-1",
  "sa-east-1",
  "il-central-1",
];

const buildAwsShardPoolerHostsForRegions = (regions: readonly string[]): string[] => {
  const out: string[] = [];
  for (const region of regions) {
    for (const shard of [0, 1] as const) {
      out.push(`aws-${shard}-${region}.pooler.supabase.com`);
    }
  }
  return out;
};

/** Tried first before the generated grid (matches frequent Supabase + user reports). */
const SUPABASE_SESSION_POOLER_PRIORITY_HOSTS: readonly string[] = [
  "aws-1-us-east-2.pooler.supabase.com",
  "aws-0-us-east-2.pooler.supabase.com",
  "aws-1-us-east-1.pooler.supabase.com",
  "aws-0-us-east-1.pooler.supabase.com",
];

export const DEFAULT_SUPABASE_SESSION_POOLER_HOSTS: readonly string[] =
  dedupePoolerHostsPreserveOrder([
    ...SUPABASE_SESSION_POOLER_PRIORITY_HOSTS,
    ...buildAwsShardPoolerHostsForRegions(SUPABASE_AWS_POOLER_COVERED_REGIONS),
  ]);

const POOLER_HOSTNAME_SUFFIX = ".pooler.supabase.com";

/**
 * True for hostnames that look like Supabase shared pooler endpoints (strict: no spaces,
 * no URL junk). Used to filter SUPABASE_SESSION_POOLER_HOSTS so prose is never used as a host.
 */
export const isValidSharedSupabasePoolerHostname = (host: string): boolean => {
  const trimmed = host.trim();
  if (!trimmed || trimmed.length > 253) {
    return false;
  }

  if (/\s/.test(trimmed) || /[/:?#@]/.test(trimmed)) {
    return false;
  }

  const lower = trimmed.toLowerCase();
  if (!lower.endsWith(POOLER_HOSTNAME_SUFFIX)) {
    return false;
  }

  const prefix = lower.slice(0, -POOLER_HOSTNAME_SUFFIX.length);
  if (!prefix || prefix.includes("..") || prefix.startsWith(".") || prefix.endsWith(".")) {
    return false;
  }

  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(prefix);
};

/**
 * Parses SUPABASE_SESSION_POOLER_HOSTS: comma, newline, or semicolon separated.
 * Only tokens that pass {@link isValidSharedSupabasePoolerHostname} are returned (host only;
 * optional `:port` is stripped from the token before validation).
 */
export const parseSupabaseSessionPoolerHostList = (raw: string | null | undefined): string[] => {
  if (!raw) {
    return [];
  }

  const out: string[] = [];
  const seen = new Set<string>();

  const tokens = raw
    .split(/[\s,;\n]+/u)
    .map((token) => token.trim())
    .filter(Boolean);

  for (const token of tokens) {
    const withoutScheme = token.replace(/^https?:\/\//iu, "");
    const hostPort = withoutScheme.split("/")[0]?.trim() ?? "";
    if (!hostPort) {
      continue;
    }

    const hostOnly = hostPort.includes(":") ? (hostPort.split(":")[0]?.trim() ?? "") : hostPort;
    if (!isValidSharedSupabasePoolerHostname(hostOnly)) {
      continue;
    }

    const key = hostOnly.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(hostOnly);
  }

  return out;
};

export const isSupabaseDirectDatabaseHostname = (hostname: string): boolean =>
  /^db\.[a-z0-9-]+\.supabase\.co$/i.test(hostname);

export const isSupabasePoolerTenantOrUserNotFoundMessage = (text: string): boolean => {
  const message = text.toLowerCase();
  return (
    message.includes("tenant or user not found") ||
    (message.includes("tenant/user") && message.includes("not found"))
  );
};

export const buildSupabaseSessionPoolerPostgresUrl = (input: {
  directPostgresUrl: string;
  poolerHost: string;
}): string | null => {
  if (!isValidSharedSupabasePoolerHostname(input.poolerHost)) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(input.directPostgresUrl);
  } catch {
    return null;
  }

  if (!/^postgres(ql)?:$/i.test(parsed.protocol)) {
    return null;
  }

  const hostMatch = parsed.hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i);
  if (!hostMatch?.[1]) {
    return null;
  }

  const projectRef = hostMatch[1];
  const usernameDecoded = decodeURIComponent(parsed.username || "postgres");
  const passwordDecoded = decodeURIComponent(parsed.password);

  const poolerUsername = usernameDecoded.toLowerCase().endsWith(`.${projectRef.toLowerCase()}`)
    ? usernameDecoded
    : `${usernameDecoded}.${projectRef}`;

  const pathname = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "/postgres";
  const port = 5432;
  const search = new URLSearchParams(parsed.search);
  search.set("sslmode", "prefer");
  const query = search.toString();

  return `postgresql://${encodeURIComponent(poolerUsername)}:${encodeURIComponent(passwordDecoded)}@${input.poolerHost}:${port}${pathname}?${query}`;
};

/**
 * Returns URLs to try in order: the original string first, then session pooler URLs
 * derived from it when the hostname is a Supabase direct DB host.
 */
export const buildSupabaseSessionPoolerFallbackCandidateUrls = (
  normalizedPostgresUrl: string,
  options?: { preferredPoolerHosts?: string[] },
): string[] => {
  let parsed: URL;
  try {
    parsed = new URL(normalizedPostgresUrl);
  } catch {
    return [normalizedPostgresUrl];
  }

  if (!isSupabaseDirectDatabaseHostname(parsed.hostname)) {
    return [normalizedPostgresUrl];
  }

  const preferred = (options?.preferredPoolerHosts ?? []).filter((host) =>
    isValidSharedSupabasePoolerHostname(host),
  );
  const seen = new Set<string>();
  const hosts: string[] = [];

  for (const host of [...preferred, ...DEFAULT_SUPABASE_SESSION_POOLER_HOSTS]) {
    const key = host.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    hosts.push(host);
  }

  const candidates: string[] = [normalizedPostgresUrl];
  for (const poolerHost of hosts) {
    const built = buildSupabaseSessionPoolerPostgresUrl({
      directPostgresUrl: normalizedPostgresUrl,
      poolerHost,
    });
    if (built && !candidates.includes(built)) {
      candidates.push(built);
    }
  }

  return candidates;
};
