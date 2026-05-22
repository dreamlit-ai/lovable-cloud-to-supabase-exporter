import { describe, expect, it } from "vitest";
import { normalizeContainerCallbackBody } from "../container-callback";

describe("normalizeContainerCallbackBody", () => {
  it("preserves structured storage failure fields while sanitizing secrets", () => {
    const normalized = normalizeContainerCallbackBody({
      callback_token: "token-123",
      run_id: "run-123",
      level: "error",
      phase: "storage_copy.failed",
      message: "Upload failed for avatars/logo.png",
      data: {
        storage_action: "upload_object",
        bucket_id: "avatars",
        object_path: "logo.png",
        prefix: null,
        project_host: "target.example",
        project_role: "target",
        status_code: 503,
        attempts: 3,
        retryable: true,
        target_admin_key: "super-secret",
      },
      debug_patch: {
        monitor_raw_error:
          "target_admin_key=super-secret postgresql://user:pw@db.example.com:5432/postgres",
        error_excerpt:
          "target_admin_key=super-secret psql:/tmp/schema.sql:99: ERROR: postgresql://user:pw@db.example.com:5432/postgres failed",
        restore_error_excerpt:
          "target_admin_key=super-secret legacy psql:/tmp/schema.sql:99: ERROR: postgresql://user:pw@db.example.com:5432/postgres failed",
      },
    });

    expect(normalized).not.toBeNull();
    expect(normalized?.data?.storage_action).toBe("upload_object");
    expect(normalized?.data?.bucket_id).toBe("avatars");
    expect(normalized?.data?.object_path).toBe("logo.png");
    expect(normalized?.data?.status_code).toBe(503);
    expect(normalized?.data?.attempts).toBe(3);
    expect(normalized?.data?.retryable).toBe(true);
    expect(normalized?.data?.target_admin_key).toBe("<redacted>");
    expect(normalized?.debug_patch?.monitor_raw_error).toContain("<redacted>");
    expect(normalized?.debug_patch?.monitor_raw_error).not.toContain("super-secret");
    expect(normalized?.debug_patch?.monitor_raw_error).not.toContain("postgresql://user:pw");
    expect(normalized?.debug_patch?.error_excerpt).toContain("<redacted>");
    expect(normalized?.debug_patch?.error_excerpt).not.toContain("super-secret");
    expect(normalized?.debug_patch?.error_excerpt).not.toContain("postgresql://user:pw");
    expect(normalized?.debug_patch?.restore_error_excerpt).toContain("<redacted>");
    expect(normalized?.debug_patch?.restore_error_excerpt).not.toContain("super-secret");
    expect(normalized?.debug_patch?.restore_error_excerpt).not.toContain("postgresql://user:pw");
  });
});
