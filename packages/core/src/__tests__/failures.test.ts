import { describe, expect, it } from "vitest";
import { classifyContainerFailure, summarizeDbUrl } from "../index";

describe("classifyContainerFailure", () => {
  it("classifies schema dump failure", () => {
    const result = classifyContainerFailure("container exited with exit code: 41");
    expect(result.failureClass).toBe("schema_dump_failed");
    expect(result.hint).toContain("schema");
  });

  it("classifies target-db-not-empty preflight failures", () => {
    const result = classifyContainerFailure("container exited with exit code: 68");
    expect(result.failureClass).toBe("target_db_not_empty");
    expect(result.hint).toContain("fresh or reset");
  });

  it("classifies source-edge-function resolution failures", () => {
    const result = classifyContainerFailure("container exited with exit code: 61");
    expect(result.failureClass).toBe("source_edge_function_resolve_failed");
    expect(result.hint).toContain("edge function");
  });

  it("classifies storage copy failures", () => {
    const result = classifyContainerFailure("container exited with exit code: 63");
    expect(result.failureClass).toBe("storage_copy_failed");
    expect(result.hint).toContain("reach out via chat");
  });

  it("classifies target database connection failures", () => {
    const result = classifyContainerFailure("container exited with exit code: 67");
    expect(result.failureClass).toBe("target_db_connection_failed");
    expect(result.hint).toContain("connection string");
  });

  it("classifies Supabase Direct IPv6 connection failures with a pooler hint", () => {
    const result = classifyContainerFailure(
      'psql: error: connection to server at "db.ref.supabase.co" (2600:1f16::1), port 5432 failed: Address not available\nexit code: 67',
    );
    expect(result.failureClass).toBe("target_db_connection_failed");
    expect(result.message).toContain("Direct connection requires IPv6");
    expect(result.hint).toContain("Session pooler");
  });

  it("classifies Supabase Direct network-unreachable failures with a pooler hint", () => {
    const result = classifyContainerFailure(
      'psql: error: connection to server at "db.ref.supabase.co" (2a05:d018::1), port 5432 failed: Network is unreachable\nexit code: 67',
    );
    expect(result.failureClass).toBe("target_db_connection_failed");
    expect(result.message).toContain("Direct connection requires IPv6");
    expect(result.hint).toContain("Session pooler");
  });

  it("classifies missing runtime dependency before generic exit-code handling", () => {
    const result = classifyContainerFailure(
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@dreamlit/lovable-cloud-to-supabase-exporter-core'\nexit code: 1",
    );
    expect(result.failureClass).toBe("runtime_dependency_missing");
    expect(result.hint).toContain("Try again");
  });

  it("classifies CommonJS missing module failures before generic exit-code handling", () => {
    const result = classifyContainerFailure(
      "Error: Cannot find module '@sentry/node'\ncode: 'MODULE_NOT_FOUND'\nexit code: 1",
    );
    expect(result.failureClass).toBe("runtime_dependency_missing");
    expect(result.message).toContain("internal setup");
  });

  it("classifies extension-owned type restore failures as generic extension failures", () => {
    const result = classifyContainerFailure(
      "ERROR: type public.geography does not exist\nexit code: 43",
    );
    expect(result.failureClass).toBe("target_extension_missing");
    expect(result.message).toContain("database extensions");
    expect(result.hint).toContain("Enable");
  });

  it("classifies extension availability failures as generic extension failures", () => {
    const result = classifyContainerFailure(
      'ERROR: extension "hstore" is not available\nDETAIL: Could not open extension control file.\nexit code: 43',
    );

    expect(result.failureClass).toBe("target_extension_missing");
    expect(result.message).toContain("database extensions");
  });

  it("uses non-blocking extension warnings to enrich extension restore failures", () => {
    const result = classifyContainerFailure(
      [
        "[clone] inspect extensions",
        'ERROR: permission denied to create extension "vector"',
        "[clone][warn] target extension setup incomplete; continuing migration.",
        "[clone][warn]   - extension vector in schema extensions",
        "[clone] restore schema",
        'psql:/tmp/pg-clone/clone-schema.filtered.sql:12: ERROR: type "vector" does not exist',
        "[clone] schema restore failed.",
        "exit code: 43",
      ].join("\n"),
    );

    expect(result.failureClass).toBe("target_extension_missing");
    expect(result.hint).toContain("tried to prepare");
    expect(result.hint).toContain("extension vector in schema extensions");
  });

  it("does not treat non-blocking extension warnings as the root cause of unrelated restore failures", () => {
    const result = classifyContainerFailure(
      [
        "[clone] inspect extensions",
        'ERROR: permission denied to create extension "pg_cron"',
        "[clone][warn] target extension setup incomplete; continuing migration.",
        "[clone][warn]   - extension pg_cron in schema pg_catalog",
        "[clone] restore schema",
        'psql:/tmp/pg-clone/clone-schema.filtered.sql:99: ERROR: relation "public.demo" already exists',
        "[clone] schema restore failed.",
        "exit code: 43",
      ].join("\n"),
    );

    expect(result.failureClass).toBe("schema_restore_failed");
  });

  it("classifies generic missing objects tied to warned extension setup", () => {
    const result = classifyContainerFailure(
      [
        "[clone] inspect extensions",
        'ERROR: permission denied to create extension "pg_cron"',
        "[clone][warn] target extension setup incomplete; continuing migration.",
        "[clone][warn]   - extension pg_cron in schema pg_catalog",
        "[clone] restore schema",
        'psql:/tmp/pg-clone/clone-schema.filtered.sql:99: ERROR: schema "cron" does not exist',
        "[clone] schema restore failed.",
        "exit code: 43",
      ].join("\n"),
    );

    expect(result.failureClass).toBe("target_extension_missing");
    expect(result.hint).toContain("extension pg_cron in schema pg_catalog");
  });

  it("does not match warned extension terms as arbitrary substrings", () => {
    const result = classifyContainerFailure(
      [
        "[clone] inspect extensions",
        'ERROR: permission denied to create extension "pg_net"',
        "[clone][warn] target extension setup incomplete; continuing migration.",
        "[clone][warn]   - extension pg_net in schema extensions",
        "[clone] restore schema",
        'psql:/tmp/pg-clone/clone-schema.filtered.sql:99: ERROR: type "internet_status" does not exist',
        "[clone] schema restore failed.",
        "exit code: 43",
      ].join("\n"),
    );

    expect(result.failureClass).toBe("schema_restore_failed");
  });

  it("classifies extension preflight failures", () => {
    const result = classifyContainerFailure(
      [
        "[clone] target database is missing required extension setup:",
        "[clone]   - extension pg_trgm in schema public",
        "[clone]   - extension unaccent in schema public",
        "exit code: 45",
      ].join("\n"),
    );

    expect(result.failureClass).toBe("target_extension_missing");
    expect(result.message).toContain("database features");
    expect(result.hint).toContain("extension pg_trgm in schema public");
  });

  it("classifies extension-shaped restore failures before generic data dump failures", () => {
    const result = classifyContainerFailure(
      [
        "COPY 0",
        "psql:/tmp/pg-clone/clone-data.pipe:2648: ERROR:  function public.unaccent(unknown, text) does not exist",
        "LINE 2:   SELECT public.unaccent('public.unaccent', $1)",
        "[clone] data dump failed.",
        "exit code: 42",
      ].join("\n"),
    );

    expect(result.failureClass).toBe("target_extension_missing");
    expect(result.message).toContain("database extensions");
  });

  it("does not classify harmless extension notices as missing extension failures", () => {
    const result = classifyContainerFailure(
      [
        'psql:/tmp/pg-clone/clone-schema.filtered.sql:1: NOTICE:  extension "pg_trgm" already exists, skipping',
        "CREATE EXTENSION",
        'psql:/tmp/pg-clone/clone-schema.filtered.sql:99: ERROR:  relation "public.demo" already exists',
        "exit code: 43",
      ].join("\n"),
    );

    expect(result.failureClass).toBe("schema_restore_failed");
  });

  it("classifies missing Vector restore failures", () => {
    const result = classifyContainerFailure(
      "ERROR: type public.vector does not exist\nexit code: 43",
    );
    expect(result.failureClass).toBe("target_extension_missing");
    expect(result.message).toContain("database extensions");
    expect(result.hint).toContain("missing database extensions");
  });

  it("classifies missing target extension preflight failures with the required setup list", () => {
    const result = classifyContainerFailure(
      [
        "[clone] target database is missing required extension setup:",
        "[clone]   - extension pgmq in schema pgmq",
        "[clone]   - Supabase Queue webhook_jobs (creates pgmq.q_webhook_jobs)",
        "exit code: 45",
      ].join("\n"),
    );
    expect(result.failureClass).toBe("target_extension_missing");
    expect(result.message).toContain("database features");
    expect(result.hint).toContain("extension pgmq in schema pgmq");
    expect(result.hint).toContain("Supabase Queue webhook_jobs");
  });

  it("classifies missing pgmq queue restore failures", () => {
    const result = classifyContainerFailure(
      'ERROR: relation "pgmq.q_webhook_jobs" does not exist\nexit code: 43',
    );
    expect(result.failureClass).toBe("target_extension_missing");
    expect(result.message).toContain("Supabase Queues");
    expect(result.hint).toContain("missing queue");
  });

  it("classifies disk exhaustion before generic exit-code handling", () => {
    const result = classifyContainerFailure(
      "pg_dump: error: could not write to file: No space left on device\nexit code: 42",
    );
    expect(result.failureClass).toBe("runtime_disk_exhausted");
    expect(result.hint).toContain("streaming dump");
  });

  it("classifies target database storage exhaustion during restore", () => {
    const result = classifyContainerFailure(
      [
        "psql:/tmp/pg-clone/clone-data.pipe:3233039: SSL SYSCALL error: EOF detected",
        'PANIC: could not write to file "pg_wal/xlogtemp.32516": No space left on device',
        "CONTEXT: writing block 49708 of relation base/5/19221",
        "COPY background_heartbeat, line 3028555",
        "[clone][diag] stage=restore_data.failed elapsed_ms=288000 tmp_free_kb=1695944 work_dir_kb=452",
        "[clone] data dump failed.",
        "exit code: 42",
      ].join("\n"),
    );
    expect(result.failureClass).toBe("target_db_storage_exhausted");
    expect(result.message).toContain("Supabase ran out of database storage");
    expect(result.hint).toContain("larger fresh Supabase project");
  });

  it("classifies timeout", () => {
    const result = classifyContainerFailure("operation timeout while waiting");
    expect(result.failureClass).toBe("timeout");
  });
});

describe("summarizeDbUrl", () => {
  it("detects malformed authority", () => {
    const summary = summarizeDbUrl("postgresql://user:p@ss@host:5432/db");
    expect(summary.looks_malformed_authority).toBe(true);
  });
});
