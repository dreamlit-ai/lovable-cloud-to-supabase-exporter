import { describe, expect, it } from "vitest";
import {
  buildExporterJobAnalyticsSummary,
  classifyExporterFailureOwner,
  type JobDebug,
  type JobRecord,
} from "../index";

const debug = (overrides: Partial<JobDebug> = {}): JobDebug => ({
  task: "export",
  source: null,
  target: null,
  source_project_url: null,
  target_project_url: null,
  storage_copy_concurrency: 4,
  data_restore_mode: "replace",
  storage_copy_mode: "full",
  hard_timeout_seconds: 600,
  pgsslmode: "require",
  container_start_invoked: true,
  monitor_raw_error: null,
  monitor_exit_code: null,
  failure_class: null,
  failure_hint: null,
  ...overrides,
});

const record = (overrides: Partial<JobRecord> = {}): JobRecord => ({
  status: "succeeded",
  run_id: "run-1",
  started_at: "2026-05-07T12:00:00.000Z",
  finished_at: "2026-05-07T12:02:30.000Z",
  error: null,
  events: [],
  debug: debug(),
  ...overrides,
});

describe("buildExporterJobAnalyticsSummary", () => {
  it("builds sanitized success metrics from job events", () => {
    const summary = buildExporterJobAnalyticsSummary(
      record({
        events: [
          {
            at: "2026-05-07T12:00:05.000Z",
            level: "info",
            phase: "db_clone.started",
            message: "DB clone started.",
            data: { table_count: 12 },
          },
          {
            at: "2026-05-07T12:02:00.000Z",
            level: "info",
            phase: "storage_copy.succeeded",
            message: "Storage copied.",
            data: {
              bucket_ids: ["avatars", "documents"],
              objects_total: 30,
              objects_copied: 28,
              objects_failed: 0,
              objects_skipped_existing: 2,
            },
          },
        ],
      }),
      {
        action: "transfer",
        variant: "full",
        jobIdHash: "job-hash",
        runIdHash: "run-hash",
      },
    );

    expect(summary).toMatchObject({
      action: "transfer",
      variant: "full",
      task: "export",
      outcome: "succeeded",
      duration_ms: 150_000,
      db_table_count: 12,
      storage_buckets_total: 2,
      storage_objects_total: 30,
      storage_objects_copied: 28,
      storage_objects_failed: 0,
      storage_objects_skipped_existing: 2,
      storage_copy_concurrency: 4,
      hard_timeout_seconds: 600,
      failure_owner: null,
      job_id_hash: "job-hash",
      run_id_hash: "run-hash",
    });
  });

  it("classifies storage failures by failing project role", () => {
    const summary = buildExporterJobAnalyticsSummary(
      record({
        status: "failed",
        error: "Storage copy failed.",
        debug: debug({
          failure_class: "storage_copy_failed",
          failure_hint: "Check storage permissions.",
          monitor_exit_code: 63,
        }),
        events: [
          {
            at: "2026-05-07T12:01:00.000Z",
            level: "error",
            phase: "storage_copy.failed",
            message: "Upload failed.",
            data: {
              storage_action: "upload_object",
              bucket_id: "avatars",
              object_path: "logo.png",
              prefix: null,
              project_host: "target.example",
              project_role: "target",
              status_code: 403,
              attempts: 2,
              retryable: false,
              request_body_kind: "web_stream",
              object_size_bytes: 1234,
              error_name: "TypeError",
              error_message: "fetch failed",
              error_code: "ERR_FETCH_FAILED",
              error_cause_name: "Error",
              error_cause_message: "socket closed before response",
              error_cause_code: "UND_ERR_SOCKET",
              objects_total: 10,
              objects_copied: 8,
              objects_failed: 2,
            },
          },
        ],
      }),
    );

    expect(summary).toMatchObject({
      outcome: "failed",
      failure_phase: "storage_copy.failed",
      failure_class: "storage_copy_failed",
      failure_owner: "target_project",
      storage_failure_action: "upload_object",
      storage_failure_project_role: "target",
      storage_failure_status_code: 403,
      storage_failure_retryable: false,
      storage_failure_request_body_kind: "web_stream",
      storage_failure_object_size_bytes: 1234,
      storage_failure_error_name: "TypeError",
      storage_failure_error_message: "fetch failed",
      storage_failure_error_code: "ERR_FETCH_FAILED",
      storage_failure_error_cause_name: "Error",
      storage_failure_error_cause_message: "socket closed before response",
      storage_failure_error_cause_code: "UND_ERR_SOCKET",
      storage_objects_total: 10,
      storage_objects_copied: 8,
      storage_objects_failed: 2,
      monitor_exit_code: 63,
    });
  });
});

describe("classifyExporterFailureOwner", () => {
  it("maps target-db-not-empty to user input", () => {
    expect(classifyExporterFailureOwner("target_db_not_empty")).toBe("user_input");
  });

  it("maps source edge helper failures to the source project", () => {
    expect(classifyExporterFailureOwner("source_edge_function_resolve_failed")).toBe(
      "source_project",
    );
  });

  it("maps missing target extension setup to the target project", () => {
    expect(classifyExporterFailureOwner("target_extension_missing")).toBe("target_project");
  });

  it("maps target database storage exhaustion to the target project", () => {
    expect(classifyExporterFailureOwner("target_db_storage_exhausted")).toBe("target_project");
  });

  it("maps runtime dependency failures to Dreamlit tooling", () => {
    expect(classifyExporterFailureOwner("runtime_dependency_missing")).toBe("dreamlit_tool");
  });

  it("maps artifact stream aborts to Dreamlit tooling", () => {
    expect(classifyExporterFailureOwner("artifact_delivery_stream_aborted")).toBe("dreamlit_tool");
  });

  it("maps runtime monitor timeouts to Dreamlit tooling", () => {
    expect(classifyExporterFailureOwner("runtime_monitor_timeout")).toBe("dreamlit_tool");
  });
});
