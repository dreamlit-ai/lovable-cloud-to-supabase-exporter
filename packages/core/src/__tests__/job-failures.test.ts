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
      response_body_sample: "permission denied",
      request_body_kind: "web_stream",
      object_size_bytes: 1234,
      error_name: "TypeError",
      error_message: "fetch failed",
      error_code: "ERR_FETCH_FAILED",
      error_cause_name: "Error",
      error_cause_message: "socket closed before response",
      error_cause_code: "UND_ERR_SOCKET",
      attempt_errors_sample: [
        {
          attempt: 1,
          error_name: "TypeError",
          error_message: "fetch failed",
          error_code: "ERR_FETCH_FAILED",
          error_cause_name: "Error",
          error_cause_message: "socket closed before response",
          error_cause_code: "UND_ERR_SOCKET",
        },
      ],
    });

    expect(details).not.toBeNull();
    expect(details?.response_body_sample).toBe("permission denied");
    expect(details?.request_body_kind).toBe("web_stream");
    expect(details?.object_size_bytes).toBe(1234);
    expect(details?.error_cause_code).toBe("UND_ERR_SOCKET");
    expect(details?.attempt_errors_sample?.[0]?.attempt).toBe(1);
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
