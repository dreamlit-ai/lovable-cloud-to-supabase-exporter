import { describe, expect, it } from "vitest";
import {
  parseSupabaseProjectRefFromProjectUrl,
  renderSupabaseEdgeFunctionsDeployScript,
  resolveDeployTargetFromJob,
  SUPABASE_EDGE_FUNCTIONS_DEPLOY_SCRIPT_FILENAME,
  tryInferSupabaseProjectUrlFromDbHost,
  type DeployScriptTarget,
} from "../supabase-edge-functions-deploy-script.js";
import type { JobRecord } from "../types.js";

describe("parseSupabaseProjectRefFromProjectUrl", () => {
  it("parses ref from project URL host", () => {
    expect(parseSupabaseProjectRefFromProjectUrl("https://abcdxyz.supabase.co")).toBe("abcdxyz");
    expect(parseSupabaseProjectRefFromProjectUrl("https://abcdxyz.supabase.co/foo")).toBe(
      "abcdxyz",
    );
  });

  it("returns null for non-supabase hosts", () => {
    expect(parseSupabaseProjectRefFromProjectUrl("https://example.com")).toBeNull();
    expect(parseSupabaseProjectRefFromProjectUrl("not-a-url")).toBeNull();
  });
});

describe("tryInferSupabaseProjectUrlFromDbHost", () => {
  it("maps db.<ref>.supabase.co to https project URL", () => {
    expect(tryInferSupabaseProjectUrlFromDbHost("db.abcdxyz.supabase.co")).toBe(
      "https://abcdxyz.supabase.co",
    );
  });

  it("returns null for pooler or unknown hosts", () => {
    expect(tryInferSupabaseProjectUrlFromDbHost("aws-0-us-east-1.pooler.supabase.com")).toBeNull();
    expect(tryInferSupabaseProjectUrlFromDbHost(null)).toBeNull();
  });
});

describe("resolveDeployTargetFromJob", () => {
  const baseJob = (overrides: Partial<JobRecord>): JobRecord => ({
    status: "succeeded",
    run_id: "r1",
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    error: null,
    events: [],
    debug: null,
    ...overrides,
  });

  it("prefers target_project_url", () => {
    const job = baseJob({
      debug: {
        task: "export",
        source: null,
        target: null,
        source_project_url: null,
        target_project_url: "https://myproj.supabase.co/custom",
        storage_copy_concurrency: 4,
        data_restore_mode: "replace",
        storage_copy_mode: "full",
        hard_timeout_seconds: null,
        pgsslmode: "require",
        container_start_invoked: true,
        monitor_raw_error: null,
        monitor_exit_code: null,
        failure_class: null,
        failure_hint: null,
      },
    });
    expect(resolveDeployTargetFromJob(job)).toEqual({
      targetProjectUrl: "https://myproj.supabase.co",
      targetProjectRef: "myproj",
    } satisfies DeployScriptTarget);
  });

  it("infers from db host when target_project_url missing", () => {
    const job = baseJob({
      debug: {
        task: "db",
        source: null,
        target: {
          parse_ok: true,
          scheme: "postgresql",
          host: "db.myproj.supabase.co",
          port: "5432",
          database: "postgres",
          username: "postgres",
          sslmode: null,
          authority_at_count: 1,
          looks_malformed_authority: false,
          query_keys: [],
        },
        source_project_url: null,
        target_project_url: null,
        storage_copy_concurrency: 32,
        data_restore_mode: "replace",
        storage_copy_mode: "off",
        hard_timeout_seconds: null,
        pgsslmode: "require",
        container_start_invoked: true,
        monitor_raw_error: null,
        monitor_exit_code: null,
        failure_class: null,
        failure_hint: null,
      },
    });
    expect(resolveDeployTargetFromJob(job)).toEqual({
      targetProjectUrl: "https://myproj.supabase.co",
      targetProjectRef: "myproj",
    });
  });

  it("returns null when nothing can be resolved", () => {
    const job = baseJob({
      debug: {
        task: "download",
        source: null,
        target: null,
        source_project_url: null,
        target_project_url: null,
        storage_copy_concurrency: 32,
        data_restore_mode: "replace",
        storage_copy_mode: "off",
        hard_timeout_seconds: null,
        pgsslmode: "require",
        container_start_invoked: true,
        monitor_raw_error: null,
        monitor_exit_code: null,
        failure_class: null,
        failure_hint: null,
      },
    });
    expect(resolveDeployTargetFromJob(job)).toBeNull();
  });
});

describe("renderSupabaseEdgeFunctionsDeployScript", () => {
  it("includes CLI commands and project ref", () => {
    const script = renderSupabaseEdgeFunctionsDeployScript({
      targetProjectUrl: "https://abc.supabase.co",
      targetProjectRef: "abc",
    });
    expect(script).toContain("#!/usr/bin/env bash");
    expect(script).toContain("supabase login");
    expect(script).toContain("supabase link --project-ref");
    expect(script).toContain(`'https://abc.supabase.co'`);
    expect(script).toContain("'abc'");
    expect(script).toContain("supabase functions deploy");
    expect(script).toContain(SUPABASE_EDGE_FUNCTIONS_DEPLOY_SCRIPT_FILENAME);
  });
});
