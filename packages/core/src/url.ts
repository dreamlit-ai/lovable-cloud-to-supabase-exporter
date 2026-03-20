import type { DbUrlSummary } from "./types.js";

const authorityFromUrlString = (input: string): string => {
  const noScheme = input.includes("://") ? input.split("://", 2)[1] : input;
  return noScheme.split("/", 1)[0] ?? "";
};

const countChar = (input: string, ch: string): number => [...input].filter((c) => c === ch).length;

export const summarizeDbUrl = (input: string): DbUrlSummary => {
  const authority = authorityFromUrlString(input);
  const atCount = countChar(authority, "@");
  const malformedAuthority = atCount > 1;

  try {
    const u = new URL(input);
    const queryKeys = [...new Set([...u.searchParams.keys()].map((k) => k.toLowerCase()))]
      .sort()
      .slice(0, 20);
    const dbNameRaw = u.pathname.replace(/^\/+/, "");

    return {
      parse_ok: true,
      scheme: u.protocol ? u.protocol.replace(/:$/, "") : null,
      host: u.hostname || null,
      port: u.port || null,
      database: dbNameRaw || null,
      username: u.username ? decodeURIComponent(u.username) : null,
      sslmode: u.searchParams.get("sslmode"),
      authority_at_count: atCount,
      looks_malformed_authority: malformedAuthority,
      query_keys: queryKeys,
    };
  } catch {
    return {
      parse_ok: false,
      scheme: null,
      host: null,
      port: null,
      database: null,
      username: null,
      sslmode: null,
      authority_at_count: atCount,
      looks_malformed_authority: malformedAuthority,
      query_keys: [],
    };
  }
};
