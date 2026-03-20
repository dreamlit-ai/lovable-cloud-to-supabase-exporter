import { describe, expect, it } from "vitest";
import {
  cleanBooleanFlag,
  DEFAULT_HARD_TIMEOUT_SECONDS,
  DEFAULT_STORAGE_COPY_CONCURRENCY,
  cleanHardTimeout,
  cleanPostgresUrl,
  cleanProjectUrl,
  cleanStorageCopyConcurrency,
  parseJobAction,
} from "../helpers.js";

describe("parseJobAction", () => {
  it("parses valid worker job routes", () => {
    expect(parseJobAction("/jobs/job-123/status")).toEqual({
      jobId: "job-123",
      action: "status",
    });
    expect(parseJobAction("/jobs/job%201/artifact")).toEqual({
      jobId: "job 1",
      action: "artifact",
    });
  });

  it("rejects invalid worker job routes", () => {
    expect(parseJobAction("/jobs/job-123/start-db")).toBeNull();
    expect(parseJobAction("/health")).toBeNull();
  });
});

describe("input cleaners", () => {
  it("normalizes project and postgres URLs", () => {
    expect(cleanProjectUrl(" https://demo.supabase.co/path?q=1 ")).toBe("https://demo.supabase.co");
    expect(cleanProjectUrl("ftp://demo.supabase.co")).toBeNull();

    expect(cleanPostgresUrl("postgresql://user:pass@db.example.com/postgres")).toBe(
      "postgresql://user:pass@db.example.com/postgres",
    );
    expect(cleanPostgresUrl("https://demo.supabase.co")).toBeNull();
  });

  it("clamps concurrency and timeout values", () => {
    expect(cleanStorageCopyConcurrency(99)).toBe(8);
    expect(cleanStorageCopyConcurrency("0")).toBe(1);
    expect(cleanStorageCopyConcurrency("bad")).toBe(DEFAULT_STORAGE_COPY_CONCURRENCY);

    expect(cleanHardTimeout(30)).toBe(60);
    expect(cleanHardTimeout(99999)).toBe(60 * 60);
    expect(cleanHardTimeout("bad")).toBe(DEFAULT_HARD_TIMEOUT_SECONDS);
  });

  it("parses boolean confirmation flags", () => {
    expect(cleanBooleanFlag(true)).toBe(true);
    expect(cleanBooleanFlag("yes")).toBe(true);
    expect(cleanBooleanFlag("0")).toBe(false);
  });
});
