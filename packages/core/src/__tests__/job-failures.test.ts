import { describe, expect, it } from "vitest";
import {
  asStorageFailureEventData,
  formatStorageFailureContext,
  getLatestStorageFailureEventData,
  type JobRecord,
} from "../index";

describe("storage failure helpers", () => {
  it("parses and formats structured storage failure event data", () => {
    const details = asStorageFailureEventData({
      storage_action: "upload_object",
      bucket_id: "avatars",
      object_path: "logo.png",
      prefix: null,
      project_host: "target.example",
      project_role: "target",
      status_code: 403,
      attempts: 2,
      retryable: false,
    });

    expect(details).not.toBeNull();
    expect(formatStorageFailureContext(details)).toBe(
      "upload object • avatars/logo.png • HTTP 403 • 2 attempts",
    );
  });

  it("finds the latest structured storage failure on a job", () => {
    const job: Pick<JobRecord, "events"> = {
      events: [
        {
          at: new Date().toISOString(),
          level: "error",
          phase: "export.failed",
          message: "generic",
        },
        {
          at: new Date().toISOString(),
          level: "error",
          phase: "storage_copy.failed",
          message: "upload failed",
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

    expect(getLatestStorageFailureEventData(job)?.object_path).toBe("logo.png");
  });
});
