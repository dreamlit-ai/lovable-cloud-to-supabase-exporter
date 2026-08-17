import { describe, expect, it } from "vitest";
import {
  buildSupabaseSessionPoolerFallbackCandidateUrls,
  buildSupabaseSessionPoolerPostgresUrl,
  DEFAULT_SUPABASE_SESSION_POOLER_HOSTS,
  isSupabaseDirectDatabaseHostname,
  isSupabasePoolerTenantOrUserNotFoundMessage,
  isValidSharedSupabasePoolerHostname,
  parseSupabaseSessionPoolerHostList,
} from "../supabase-session-pooler-url";

describe("isSupabaseDirectDatabaseHostname", () => {
  it("matches db.<ref>.supabase.co", () => {
    expect(isSupabaseDirectDatabaseHostname("db.abc123xyz45678901234.supabase.co")).toBe(true);
  });

  it("rejects pooler hosts", () => {
    expect(isSupabaseDirectDatabaseHostname("aws-0-us-east-1.pooler.supabase.com")).toBe(false);
  });
});

describe("isValidSharedSupabasePoolerHostname", () => {
  it("accepts Supabase shared pooler subdomains", () => {
    expect(isValidSharedSupabasePoolerHostname("aws-0-ap-southeast-2.pooler.supabase.com")).toBe(
      true,
    );
  });

  it("rejects prose and non-pooler domains", () => {
    expect(isValidSharedSupabasePoolerHostname("comma-separated pooler hostnames")).toBe(false);
    expect(isValidSharedSupabasePoolerHostname("a.example.com")).toBe(false);
    expect(isValidSharedSupabasePoolerHostname("")).toBe(false);
  });
});

describe("buildSupabaseSessionPoolerPostgresUrl", () => {
  it("builds postgres.<ref> session pooler URL with sslmode=prefer", () => {
    const direct =
      "postgresql://postgres:my%40secret@db.abcdefghijklmnopqrs.supabase.co:5432/postgres";
    const built = buildSupabaseSessionPoolerPostgresUrl({
      directPostgresUrl: direct,
      poolerHost: "aws-1-us-east-2.pooler.supabase.com",
    });
    expect(built).toBeTruthy();
    const parsed = new URL(built!);
    expect(parsed.hostname).toBe("aws-1-us-east-2.pooler.supabase.com");
    expect(parsed.username).toBe("postgres.abcdefghijklmnopqrs");
    expect(decodeURIComponent(parsed.password)).toBe("my@secret");
    expect(parsed.searchParams.get("sslmode")).toBe("prefer");
  });

  it("preserves username that already includes project ref", () => {
    const direct =
      "postgresql://postgres.abcdefghijklmnopqrs:secret@db.abcdefghijklmnopqrs.supabase.co/postgres";
    const built = buildSupabaseSessionPoolerPostgresUrl({
      directPostgresUrl: direct,
      poolerHost: "aws-0-eu-west-1.pooler.supabase.com",
    });
    expect(built).toBeTruthy();
    expect(new URL(built!).username).toBe("postgres.abcdefghijklmnopqrs");
  });

  it("returns null for invalid pooler host tokens", () => {
    const direct = "postgresql://postgres:secret@db.abcdefghijklmnopqrs.supabase.co/postgres";
    expect(
      buildSupabaseSessionPoolerPostgresUrl({
        directPostgresUrl: direct,
        poolerHost: "not a hostname",
      }),
    ).toBeNull();
  });
});

describe("buildSupabaseSessionPoolerFallbackCandidateUrls", () => {
  it("prepends preferred pooler hosts", () => {
    const direct = "postgresql://postgres:secret@db.abcdefghijklmnopqrs.supabase.co/postgres";
    const candidates = buildSupabaseSessionPoolerFallbackCandidateUrls(direct, {
      preferredPoolerHosts: ["aws-1-us-east-2.pooler.supabase.com"],
    });
    expect(candidates[0]).toBe(direct);
    expect(candidates[1]).toContain("aws-1-us-east-2.pooler.supabase.com");
  });

  it("returns only the original URL for non-direct hosts", () => {
    const pooler =
      "postgresql://postgres.abc:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
    expect(buildSupabaseSessionPoolerFallbackCandidateUrls(pooler)).toEqual([pooler]);
  });

  it("includes many regional pooler hosts for direct URLs", () => {
    const direct = "postgresql://postgres:secret@db.abcdefghijklmnopqrs.supabase.co/postgres";
    const candidates = buildSupabaseSessionPoolerFallbackCandidateUrls(direct);
    expect(candidates.length).toBeGreaterThan(40);
    expect(candidates.some((c) => c.includes("ap-southeast-2.pooler.supabase.com"))).toBe(true);
  });
});

describe("parseSupabaseSessionPoolerHostList", () => {
  it("parses comma-separated valid pooler hostnames", () => {
    expect(
      parseSupabaseSessionPoolerHostList(
        "aws-0-ap-southeast-2.pooler.supabase.com, aws-1-us-east-1.pooler.supabase.com",
      ),
    ).toEqual(["aws-0-ap-southeast-2.pooler.supabase.com", "aws-1-us-east-1.pooler.supabase.com"]);
  });

  it("strips optional port and http scheme", () => {
    expect(
      parseSupabaseSessionPoolerHostList("https://aws-0-eu-west-1.pooler.supabase.com:5432"),
    ).toEqual(["aws-0-eu-west-1.pooler.supabase.com"]);
  });

  it("ignores instructional text and invalid domains", () => {
    expect(
      parseSupabaseSessionPoolerHostList(
        "comma-separated pooler hostnames, aws-0-us-west-2.pooler.supabase.com, see dashboard",
      ),
    ).toEqual(["aws-0-us-west-2.pooler.supabase.com"]);
  });
});

describe("isSupabasePoolerTenantOrUserNotFoundMessage", () => {
  it("detects tenant routing failures", () => {
    expect(isSupabasePoolerTenantOrUserNotFoundMessage("FATAL:  Tenant or user not found")).toBe(
      true,
    );
    expect(
      isSupabasePoolerTenantOrUserNotFoundMessage(
        "FATAL:  (ENOTFOUND) tenant/user postgres.abc not found",
      ),
    ).toBe(true);
  });
});

describe("DEFAULT_SUPABASE_SESSION_POOLER_HOSTS", () => {
  it("lists unique aws shard hosts across regions", () => {
    expect(DEFAULT_SUPABASE_SESSION_POOLER_HOSTS.length).toBeGreaterThanOrEqual(50);
    const lowered = new Set(DEFAULT_SUPABASE_SESSION_POOLER_HOSTS.map((h) => h.toLowerCase()));
    expect(lowered.size).toBe(DEFAULT_SUPABASE_SESSION_POOLER_HOSTS.length);
  });
});
