import { describe, expect, it } from "vitest";
import {
  APP_SCHEMA_DISCOVERY_SQL,
  EXCLUDED_DATA_TABLES,
  formatSchemaInventory,
  getDataDumpSchemas,
  normalizeAppSchemas,
  parseAppSchemaRows,
  toPgDumpSchemaArgs,
} from "../db-schemas.js";

describe("db schema selection", () => {
  it("includes public first and custom app schemas after managed schema filtering", () => {
    expect(
      normalizeAppSchemas([
        "storage",
        "private",
        "public",
        "auth",
        "extensions",
        "pg_catalog",
        "cron",
        "_realtime",
        "private",
        "billing",
      ]),
    ).toEqual(["public", "billing", "private"]);
  });

  it("adds auth only to the data dump schema list", () => {
    expect(getDataDumpSchemas(["public", "private"])).toEqual(["public", "private", "auth"]);
  });

  it("excludes transient auth runtime tables from data exports", () => {
    expect(EXCLUDED_DATA_TABLES).toContain("auth.mfa_amr_claims");
  });

  it("builds pg_dump schema args for ZIP schema and data exports", () => {
    const appSchemas = parseAppSchemaRows("public\nprivate\nstorage\n");
    expect(toPgDumpSchemaArgs(appSchemas)).toEqual(['--schema="public"', '--schema="private"']);
    expect(toPgDumpSchemaArgs(getDataDumpSchemas(appSchemas))).toEqual([
      '--schema="public"',
      '--schema="private"',
      '--schema="auth"',
    ]);
  });

  it("quotes pg_dump schema patterns as exact identifiers", () => {
    expect(toPgDumpSchemaArgs(["Private", 'weird"schema'])).toEqual([
      '--schema="Private"',
      '--schema="weird""schema"',
    ]);
  });

  it("does not use base type rows to discover app-owned schemas", () => {
    expect(APP_SCHEMA_DISCOVERY_SQL).toContain("t.typtype IN ('c', 'd', 'e', 'm', 'r')");
    expect(APP_SCHEMA_DISCOVERY_SQL).not.toContain("t.typtype IN ('b'");
  });

  it("formats schema inventory diagnostics", () => {
    expect(formatSchemaInventory(["public", "private"])).toBe(
      "source app schemas detected (2): public, private",
    );
  });
});
