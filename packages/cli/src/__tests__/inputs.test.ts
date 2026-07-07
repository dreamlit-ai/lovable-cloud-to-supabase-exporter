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

  it("accepts postgres_url source fields and defaults verification on", () => {
    const normalized = normalizeDbCloneInput({
      source_type: "postgres_url",
      source_db_url: "postgres://source",
      target_db_url: "postgres://target",
      confirm_target_blank: true,
      exclude_data_tables: ["public.sessions"],
      enable_rls_on_restored_tables: true,
      auth_user_migration: {
        enabled: true,
      },
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.sourceType).toBe("postgres_url");
    expect(normalized.value.sourceDbUrl).toBe("postgres://source");
    expect(normalized.value.sourceEdgeFunctionUrl).toBeNull();
    expect(normalized.value.excludeDataTables).toEqual(["public.sessions"]);
    expect(normalized.value.enableRlsOnRestoredTables).toBe(true);
    expect(normalized.value.authUserMigration?.usersTable).toBe("users");
    expect(normalized.value.verification).toBe(true);
  });

  it("rejects mixed postgres_url and edge-function source fields", () => {
    const normalized = normalizeDbCloneInput({
      source_type: "postgres_url",
      source_db_url: "postgres://source",
      source_edge_function_url: "https://source-ref.supabase.co/functions/v1/export-db-url",
      target_db_url: "postgres://target",
      confirm_target_blank: true,
    });

    expect(normalized.ok).toBe(false);
    if (normalized.ok) return;
    expect(normalized.error).toContain("must not include source_edge_function_url");
  });

  it("accepts target db urls with raw reserved password characters", () => {
    const normalized = normalizeDbCloneInput({
      source_edge_function_url: "https://source-ref.supabase.co/functions/v1/export-db-url",
      source_edge_function_access_key: "access-key",
      target_db_url:
        "postgresql://postgres:pa@ss#wo%rd@db.qicvuexedqhfkkyntpeh.supabase.co:5432/postgres?sslmode=require",
      confirm_target_blank: true,
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.targetDbUrl).toBe(
      "postgresql://postgres:pa%40ss%23wo%25rd@db.qicvuexedqhfkkyntpeh.supabase.co:5432/postgres?sslmode=require",
    );
  });
});

describe("normalizeStorageCopyInput", () => {
  it("requires all storage fields", () => {
    const normalized = normalizeStorageCopyInput({});
    expect(normalized.ok).toBe(false);
  });

  it("rejects postgres_url sources because storage is not available", () => {
    const normalized = normalizeStorageCopyInput({
      source_type: "postgres_url",
      source_db_url: "postgres://source",
      target_project_url: "https://target-ref.supabase.co",
      target_admin_key: "target-key",
    });

    expect(normalized.ok).toBe(false);
    if (normalized.ok) return;
    expect(normalized.error).toContain("do not have Supabase storage");
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

  it("defaults concurrency to 32", () => {
    const normalized = normalizeStorageCopyInput({
      source_edge_function_url: "https://source-ref.supabase.co/functions/v1/export-db-url",
      source_edge_function_access_key: "access-key",
      target_project_url: "https://target-ref.supabase.co",
      target_admin_key: "target-key",
    });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.concurrency).toBe(32);
    expect(normalized.value.skipExistingTargetObjects).toBe(false);
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
    expect(normalized.value.concurrency).toBe(64);
  });

  it("supports explicit skip-existing retry mode", () => {
    const normalized = normalizeStorageCopyInput({
      source_edge_function_url: "https://source-ref.supabase.co/functions/v1/export-db-url",
      source_edge_function_access_key: "access-key",
      target_project_url: "https://target-ref.supabase.co",
      target_admin_key: "target-key",
      skip_existing_target_objects: true,
    });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.skipExistingTargetObjects).toBe(true);
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
    expect(normalized.value.concurrency).toBe(64);
    expect(normalized.value.hardTimeoutSeconds).toBe(60);
  });

  it("normalizes postgres_url export without storage credentials", () => {
    const normalized = normalizeExportInput({
      source_type: "postgres_url",
      source_db_url: "postgres://source",
      target_db_url: "postgres://target",
      confirm_target_blank: true,
      verification: false,
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.sourceType).toBe("postgres_url");
    expect(normalized.value.targetProjectUrl).toBeNull();
    expect(normalized.value.targetAdminKey).toBeNull();
    expect(normalized.value.verification).toBe(false);
  });
});
