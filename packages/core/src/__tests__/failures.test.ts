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

  it("classifies missing PostGIS restore failures", () => {
    const result = classifyContainerFailure(
      "ERROR: type public.geography does not exist\nexit code: 43",
    );
    expect(result.failureClass).toBe("target_postgis_not_enabled");
    expect(result.message).toContain("PostGIS");
    expect(result.hint).toContain("Enable PostGIS");
  });

  it("classifies missing Vector restore failures", () => {
    const result = classifyContainerFailure(
      "ERROR: type public.vector does not exist\nexit code: 43",
    );
    expect(result.failureClass).toBe("target_extension_missing");
    expect(result.message).toContain("Vector");
    expect(result.hint).toContain("Enable Vector");
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
