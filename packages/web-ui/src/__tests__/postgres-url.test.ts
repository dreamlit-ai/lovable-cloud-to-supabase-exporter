import { describe, expect, it } from "vitest";
import { extractSupabaseProjectRefFromPostgresUrl, normalizePostgresUrl } from "../postgres-url";

describe("normalizePostgresUrl", () => {
  it("accepts Supabase connection strings whose password includes raw reserved characters", () => {
    const input =
      "postgresql://postgres:pa@ss#wo%rd@db.qicvuexedqhfkkyntpeh.supabase.co:5432/postgres?sslmode=require";

    expect(normalizePostgresUrl(input)).toBe(
      "postgresql://postgres:pa%40ss%23wo%25rd@db.qicvuexedqhfkkyntpeh.supabase.co:5432/postgres?sslmode=require",
    );
    expect(extractSupabaseProjectRefFromPostgresUrl(input)).toBe("qicvuexedqhfkkyntpeh");
  });
});
