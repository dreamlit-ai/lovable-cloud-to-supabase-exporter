import { describe, expect, it } from "vitest";
import { normalizeDbCloneInput, normalizeExportInput, normalizeStorageCopyInput } from "../inputs";

describe("normalizeDbCloneInput", () => {
  it("requires source, target, and confirmation", () => {
    const missingUrls = normalizeDbCloneInput({
      confirm_target_blank: true,
    });
    expect(missingUrls.ok).toBe(false);

    const missingConfirm = normalizeDbCloneInput({
      source_edge_function_url: "https://source-ref.supabase.co/functions/v1/export-db-url",
      source_edge_function_access_key: "access-key",
      target_db_url: "postgres://target",
    });
    expect(missingConfirm.ok).toBe(false);
  });

  it("normalizes hard timeout", () => {
    const normalized = normalizeDbCloneInput({
      source_edge_function_url: "https://source-ref.supabase.co/functions/v1/export-db-url",
      source_edge_function_access_key: "access-key",
      target_db_url: "postgres://target",
      confirm_target_blank: true,
      hard_timeout_seconds: "15",
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.hardTimeoutSeconds).toBe(60);
  });
});

describe("normalizeStorageCopyInput", () => {
  it("requires all storage fields", () => {
    const normalized = normalizeStorageCopyInput({});
    expect(normalized.ok).toBe(false);
  });

  it("allows source project url omission", () => {
    const normalized = normalizeStorageCopyInput({
      source_edge_function_url: "https://source-ref.supabase.co/functions/v1/export-db-url",
      source_edge_function_access_key: "access-key",
      target_project_url: "https://target-ref.supabase.co",
      target_admin_key: "target-key",
    });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.sourceProjectUrl).toBeNull();
  });

  it("defaults concurrency to 8", () => {
    const normalized = normalizeStorageCopyInput({
      source_edge_function_url: "https://source-ref.supabase.co/functions/v1/export-db-url",
      source_edge_function_access_key: "access-key",
      target_project_url: "https://target-ref.supabase.co",
      target_admin_key: "target-key",
    });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.concurrency).toBe(8);
  });

  it("normalizes urls and concurrency", () => {
    const normalized = normalizeStorageCopyInput({
      source_edge_function_url: "https://source-ref.supabase.co/functions/v1/export-db-url",
      source_edge_function_access_key: "access-key",
      source_project_url: "https://source-ref.supabase.co/path/ignored",
      target_project_url: "https://target-ref.supabase.co/anything",
      target_admin_key: "target-key",
      storage_copy_concurrency: "99",
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;

    expect(normalized.value.sourceEdgeFunctionUrl).toBe(
      "https://source-ref.supabase.co/functions/v1/export-db-url",
    );
    expect(normalized.value.sourceProjectUrl).toBe("https://source-ref.supabase.co");
    expect(normalized.value.targetProjectUrl).toBe("https://target-ref.supabase.co");
    expect(normalized.value.concurrency).toBe(8);
  });
});

describe("normalizeExportInput", () => {
  it("requires db, storage fields, and blank-target confirmation together", () => {
    const normalized = normalizeExportInput({
      source_edge_function_url: "https://source-ref.supabase.co/functions/v1/export-db-url",
      source_edge_function_access_key: "access-key",
      target_db_url: "postgres://target",
    });

    expect(normalized.ok).toBe(false);
  });

  it("normalizes combined export input", () => {
    const normalized = normalizeExportInput({
      source_edge_function_url: "https://source-ref.supabase.co/functions/v1/export-db-url",
      source_edge_function_access_key: "access-key",
      target_db_url: "postgres://target",
      confirm_target_blank: true,
      source_project_url: "https://source-ref.supabase.co/anything",
      target_project_url: "https://target-ref.supabase.co/anything",
      target_admin_key: "target-key",
      storage_copy_concurrency: "99",
      hard_timeout_seconds: "5",
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;

    expect(normalized.value.targetProjectUrl).toBe("https://target-ref.supabase.co");
    expect(normalized.value.sourceProjectUrl).toBe("https://source-ref.supabase.co");
    expect(normalized.value.concurrency).toBe(8);
    expect(normalized.value.hardTimeoutSeconds).toBe(60);
  });
});
