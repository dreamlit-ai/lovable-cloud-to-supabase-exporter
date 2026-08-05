import { describe, expect, it } from "vitest";
import {
  buildFailureDiagnostics,
  extractLogErrorExcerpt,
  parseLogVerbosity,
  sanitizeLogText,
  sanitizeLogValue,
  sanitizeStoredLogText,
  truncateLogText,
} from "../index";

describe("sanitizeLogText", () => {
  it("redacts postgres urls and bearer tokens", () => {
    const sanitized = sanitizeLogText(
      "connecting to postgresql://user:secret@db.example.com:5432/app?sslmode=require Authorization: Bearer abc123",
    );

    expect(sanitized).toContain("<redacted-postgres-url>");
    expect(sanitized).toContain("Authorization: Bearer <redacted>");
    expect(sanitized).not.toContain("secret@db.example.com");
    expect(sanitized).not.toContain("abc123");
  });

  it("redacts secret key assignments", () => {
    const sanitized = sanitizeLogText(
      "SOURCE_EDGE_FUNCTION_ACCESS_KEY=shhh target_admin_key:\"super-secret\" callback_token='abc'",
    );

    expect(sanitized).toContain("SOURCE_EDGE_FUNCTION_ACCESS_KEY=<redacted>");
    expect(sanitized).toContain('target_admin_key:"<redacted>"');
    expect(sanitized).toContain("callback_token='<redacted>'");
  });

  it("redacts libpq hostnames and IPv6 addresses", () => {
    const sanitized = sanitizeLogText(
      'connection to server at "db.secret-project.supabase.co" (2a05:d018:1234:5678::9), port 5432 failed',
    );

    expect(sanitized).toContain('server at "<redacted-host>" (<redacted-ip>)');
    expect(sanitized).not.toContain("secret-project");
    expect(sanitized).not.toContain("2a05:d018");
  });
});

describe("sanitizeLogValue", () => {
  it("redacts nested secret fields and string values", () => {
    const sanitized = sanitizeLogValue({
      target_admin_key: "secret",
      nested: {
        callback_token: "token",
        message: "postgresql://user:pw@host:5432/db",
      },
    }) as Record<string, unknown>;

    expect(sanitized.target_admin_key).toBe("<redacted>");
    expect((sanitized.nested as Record<string, unknown>).callback_token).toBe("<redacted>");
    expect((sanitized.nested as Record<string, unknown>).message).toBe("<redacted-postgres-url>");
  });
});

describe("sanitizeStoredLogText", () => {
  it("truncates long values after redaction", () => {
    const sanitized = sanitizeStoredLogText(`target_admin_key=secret\n${"x".repeat(160)}`, 100);

    expect(sanitized).toContain("target_admin_key=<redacted>");
    expect(sanitized).not.toContain("secret");
    expect(sanitized).toContain("[truncated");
    expect(sanitized.length).toBeLessThanOrEqual(100);
  });

  it("preserves tail context when truncating long logs", () => {
    const truncated = truncateLogText(
      `start\n${"x".repeat(200)}\npsql:/tmp/schema.sql:99: ERROR: could not create database object`,
      120,
    );

    expect(truncated).toContain("start");
    expect(truncated).toContain("[truncated");
    expect(truncated).toContain("ERROR: could not create database object");
    expect(truncated.length).toBeLessThanOrEqual(120);
  });
});

describe("extractLogErrorExcerpt", () => {
  it("extracts the final database error with nearby context", () => {
    const excerpt = extractLogErrorExcerpt(
      [
        "[clone] restore schema",
        "CREATE TABLE",
        "psql:/tmp/schema.sql:99: ERROR: could not create database object",
        "LINE 21:     field public.custom_type,",
        "                       ^",
        "exit code: 43",
      ].join("\n"),
    );

    expect(excerpt).toContain("psql:/tmp/schema.sql:99: ERROR: could not create database object");
    expect(excerpt).toContain("LINE 21");
    expect(excerpt).toContain("^");
  });

  it("redacts secrets from extracted excerpts", () => {
    const excerpt = extractLogErrorExcerpt(
      "target_admin_key=super-secret\npsql:/tmp/schema.sql:99: ERROR: postgresql://user:pw@host/db failed",
    );

    expect(excerpt).toContain("target_admin_key=<redacted>");
    expect(excerpt).toContain("<redacted-postgres-url>");
    expect(excerpt).not.toContain("super-secret");
    expect(excerpt).not.toContain("postgresql://user:pw");
  });

  it("extracts missing extension summaries before lower-level psql errors", () => {
    const excerpt = extractLogErrorExcerpt(
      [
        "psql: ERROR: extension is not available on target",
        "[clone] target database is missing required extension setup:",
        "[clone]   - extension pg_trgm in schema public (source version 1.6)",
        "[clone]   - extension unaccent in schema public (source version 1.1)",
        "[clone] Enable these extensions in Supabase, then retry. If a previous attempt created app tables, reset the target database first.",
        "exit code: 45",
      ].join("\n"),
    );

    expect(excerpt).toContain("target database is missing required extension setup");
    expect(excerpt).toContain("extension pg_trgm in schema public (source version 1.6)");
    expect(excerpt).toContain("extension unaccent in schema public (source version 1.1)");
  });

  it("extracts missing RLS policy roles with the actionable SQL", () => {
    const excerpt = extractLogErrorExcerpt(
      [
        "[clone] target database is missing roles referenced by RLS policies:",
        "[clone]   - workspace_member",
        "[clone] Create matching roles in the Supabase SQL Editor, then retry:",
        '[clone]   CREATE ROLE "workspace_member" NOLOGIN;',
        "exit code: 43",
      ].join("\n"),
    );

    expect(excerpt).toContain("workspace_member");
    expect(excerpt).toContain("CREATE ROLE");
  });

  it("omits non-blocking extension warnings from generic error excerpts", () => {
    const excerpt = extractLogErrorExcerpt(
      [
        'ERROR: permission denied to create extension "pg_cron"',
        "[clone][warn] target extension setup incomplete; continuing migration.",
        "[clone][warn]   - extension pg_cron in schema pg_catalog",
        "[clone] restore schema",
        'psql:/tmp/schema.sql:12: ERROR: schema "cron" does not exist',
        "[clone] schema restore failed.",
      ].join("\n"),
    );

    expect(excerpt).toContain('ERROR: schema "cron" does not exist');
    expect(excerpt).not.toContain("permission denied to create extension");
    expect(excerpt).not.toContain("[clone][warn]");
    expect(excerpt).not.toContain("extension pg_cron");
  });
});

describe("buildFailureDiagnostics", () => {
  it("builds sanitized raw logs and a compact error excerpt", () => {
    const diagnostics = buildFailureDiagnostics(
      [
        "target_admin_key=super-secret",
        "[clone] restore data",
        "psql:/tmp/data.sql:12: ERROR: could not restore database object",
        "exit code: 44",
      ].join("\n"),
      { exitCode: 44 },
    );

    expect(diagnostics.monitor_exit_code).toBe(44);
    expect(diagnostics.monitor_raw_error).toContain("target_admin_key=<redacted>");
    expect(diagnostics.monitor_raw_error).not.toContain("super-secret");
    expect(diagnostics.error_excerpt).toContain("ERROR: could not restore database object");
  });
});

describe("parseLogVerbosity", () => {
  it("defaults to normal and accepts debug", () => {
    expect(parseLogVerbosity(undefined)).toBe("normal");
    expect(parseLogVerbosity("DEBUG")).toBe("debug");
  });
});
