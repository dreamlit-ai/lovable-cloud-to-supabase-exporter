import { describe, expect, it } from "vitest";
import {
  getDefaultPostgresSslMode,
  normalizePostgresUrl,
  withDefaultPostgresSslMode,
} from "../index";

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

describe("getDefaultPostgresSslMode", () => {
  it("uses SSL for Supabase Direct connections", () => {
    expect(
      getDefaultPostgresSslMode(
        "postgresql://postgres:password@db.isuaepxufjyyjngekzdj.supabase.co:5432/postgres",
      ),
    ).toBe("require");
  });

  it("disables SSL startup for Supabase pooler connections", () => {
    expect(
      getDefaultPostgresSslMode(
        "postgresql://postgres.isuaepxufjyyjngekzdj:password@aws-1-us-east-2.pooler.supabase.com:5432/postgres",
      ),
    ).toBe("disable");
  });
});

describe("withDefaultPostgresSslMode", () => {
  it("adds require to Direct connections without an explicit sslmode", () => {
    expect(
      withDefaultPostgresSslMode(
        "postgresql://postgres:password@db.isuaepxufjyyjngekzdj.supabase.co:5432/postgres",
      ),
    ).toBe(
      "postgresql://postgres:password@db.isuaepxufjyyjngekzdj.supabase.co:5432/postgres?sslmode=require",
    );
  });

  it("adds disable to pooler connections without an explicit sslmode", () => {
    expect(
      withDefaultPostgresSslMode(
        "postgresql://postgres.isuaepxufjyyjngekzdj:password@aws-1-us-east-2.pooler.supabase.com:5432/postgres",
      ),
    ).toBe(
      "postgresql://postgres.isuaepxufjyyjngekzdj:password@aws-1-us-east-2.pooler.supabase.com:5432/postgres?sslmode=disable",
    );
  });

  it("preserves a user-provided sslmode", () => {
    expect(
      withDefaultPostgresSslMode(
        "postgresql://postgres.isuaepxufjyyjngekzdj:password@aws-1-us-east-2.pooler.supabase.com:5432/postgres?sslmode=require",
      ),
    ).toBe(
      "postgresql://postgres.isuaepxufjyyjngekzdj:password@aws-1-us-east-2.pooler.supabase.com:5432/postgres?sslmode=require",
    );
  });
});
