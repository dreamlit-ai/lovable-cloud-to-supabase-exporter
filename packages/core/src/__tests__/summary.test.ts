import { describe, expect, it } from "vitest";
import { buildMigrationSummary, type JobRecord } from "../index";

describe("buildMigrationSummary", () => {
  it("builds summary from debug and events", () => {
    const record: JobRecord = {
      status: "succeeded",
      run_id: "run-1",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      error: null,
      debug: {
        task: "storage",
        source: null,
        target: null,
        source_project_url: null,
        target_project_url: null,
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
      events: [
        {
          at: new Date().toISOString(),
          level: "info",
          phase: "storage_copy.succeeded",
          message: "done",
          data: {
            bucket_ids: ["avatars"],
            objects_copied: 10,
            objects_skipped_existing: 2,
          },
        },
      ],
    };

    const summary = buildMigrationSummary(record);
    expect(summary.moved.buckets).toContain("avatars");
    expect(summary.moved.schemas).toEqual([]);
    expect(summary.skipped).toEqual([{ item: "storage objects (2)", reason: "target_existing" }]);
    expect(summary.errors.details).toBeNull();
  });

  it("includes structured storage failure details from events", () => {
    const record: JobRecord = {
      status: "failed",
      run_id: "run-2",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      error: "Upload failed",
      debug: {
        task: "export",
        source: null,
        target: null,
        source_project_url: null,
        target_project_url: null,
        storage_copy_concurrency: 4,
        data_restore_mode: "replace",
        storage_copy_mode: "full",
        hard_timeout_seconds: null,
        pgsslmode: "require",
        container_start_invoked: true,
        monitor_raw_error: "Upload failed",
        monitor_exit_code: 63,
        failure_class: "storage_copy_failed",
        failure_hint: "Check permissions.",
      },
      events: [
        {
          at: new Date().toISOString(),
          level: "error",
          phase: "storage_copy.failed",
          message: "Upload failed",
          data: {
            storage_action: "upload_object",
            bucket_id: "avatars",
            object_path: "logo.png",
            prefix: null,
            project_host: "target.example",
            project_role: "target",
            status_code: 403,
            attempts: 1,
            retryable: false,
          },
        },
      ],
    };

    const summary = buildMigrationSummary(record);
    expect(summary.errors.details?.storage_action).toBe("upload_object");
    expect(summary.errors.details?.bucket_id).toBe("avatars");
    expect(summary.errors.details?.object_path).toBe("logo.png");
  });

  it("keeps failed object counts when storage finishes with errors", () => {
    const record: JobRecord = {
      status: "failed",
      run_id: "run-3",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      error: "Storage copy completed with 2 object failures.",
      debug: {
        task: "export",
        source: null,
        target: null,
        source_project_url: null,
        target_project_url: null,
        storage_copy_concurrency: 4,
        data_restore_mode: "replace",
        storage_copy_mode: "retry_skip_existing",
        hard_timeout_seconds: null,
        pgsslmode: "require",
        container_start_invoked: true,
        monitor_raw_error: "Download failed for avatars/logo.png from source.example (403).",
        monitor_exit_code: 63,
        failure_class: "storage_copy_partial_failure",
        failure_hint: "Check the source admin key and source bucket/object permissions.",
      },
      events: [
        {
          at: new Date().toISOString(),
          level: "error",
          phase: "storage_copy.failed",
          message: "Storage copy completed with 2 object failures.",
          data: {
            bucket_ids: ["avatars"],
            objects_total: 10,
            objects_copied: 8,
            objects_failed: 2,
            objects_skipped_existing: 1,
            storage_action: "download_object",
            bucket_id: "avatars",
            object_path: "logo.png",
            prefix: null,
            project_host: "source.example",
            project_role: "source",
            status_code: 403,
            attempts: 1,
            retryable: false,
          },
        },
      ],
    };

    const summary = buildMigrationSummary(record);
    expect(summary.moved.buckets).toContain("avatars");
    expect(summary.skipped).toEqual([
      { item: "storage objects (2)", reason: "copy_failed" },
      { item: "storage objects (1)", reason: "target_existing" },
    ]);
    expect(summary.errors.details?.storage_action).toBe("download_object");
  });
});
