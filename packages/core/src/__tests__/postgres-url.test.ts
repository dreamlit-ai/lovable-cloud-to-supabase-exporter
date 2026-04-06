import { describe, expect, it } from "vitest";
import { normalizePostgresUrl } from "../index";

describe("normalizePostgresUrl", () => {
  it("accepts raw reserved password characters by percent-encoding the credentials", () => {
    expect(
      normalizePostgresUrl(
        "postgresql://postgres:pa@ss#wo%rd@db.qicvuexedqhfkkyntpeh.supabase.co:5432/postgres?sslmode=require",
      ),
    ).toBe(
      "postgresql://postgres:pa%40ss%23wo%25rd@db.qicvuexedqhfkkyntpeh.supabase.co:5432/postgres?sslmode=require",
    );
  });
});
