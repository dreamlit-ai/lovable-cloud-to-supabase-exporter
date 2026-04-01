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
    expect(result.hint).toContain("bucket/object");
  });

  it("classifies target database connection failures", () => {
    const result = classifyContainerFailure("container exited with exit code: 67");
    expect(result.failureClass).toBe("target_db_connection_failed");
    expect(result.hint).toContain("Supabase Postgres connection string");
  });

  it("classifies missing runtime dependency before generic exit-code handling", () => {
    const result = classifyContainerFailure(
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@dreamlit/lovable-cloud-to-supabase-exporter-core'\nexit code: 1",
    );
    expect(result.failureClass).toBe("runtime_dependency_missing");
    expect(result.hint).toContain("Rebuild");
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
