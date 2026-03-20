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
          },
        },
      ],
    };

    const summary = buildMigrationSummary(record);
    expect(summary.moved.buckets).toContain("avatars");
    expect(summary.moved.schemas).toEqual([]);
  });
});
