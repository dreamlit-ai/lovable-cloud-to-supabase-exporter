import { describe, expect, it } from "vitest";
import {
  cleanBooleanFlag,
  DEFAULT_HARD_TIMEOUT_SECONDS,
  DEFAULT_STORAGE_COPY_CONCURRENCY,
  cleanHardTimeout,
  cleanPostgresUrl,
  cleanProjectUrl,
  cleanStorageCopyConcurrency,
  MAX_JOB_EVENTS,
  parseJobAction,
  pruneJobEvents,
} from "../helpers.js";

describe("parseJobAction", () => {
  it("parses valid worker job routes", () => {
    expect(parseJobAction("/jobs/job-123/status")).toEqual({
      jobId: "job-123",
      action: "status",
    });
    expect(parseJobAction("/jobs/job-123/start-storage")).toEqual({
      jobId: "job-123",
      action: "start-storage",
    });
    expect(parseJobAction("/jobs/job-123/start-target-db-test")).toEqual({
      jobId: "job-123",
      action: "start-target-db-test",
    });
    expect(parseJobAction("/jobs/job-123/test-target-admin-key")).toEqual({
      jobId: "job-123",
      action: "test-target-admin-key",
    });
    expect(parseJobAction("/jobs/job-123/artifact-access")).toEqual({
      jobId: "job-123",
      action: "artifact-access",
    });
    expect(parseJobAction("/jobs/job_1.2026/artifact")).toEqual({
      jobId: "job_1.2026",
      action: "artifact",
    });
  });

  it("rejects invalid worker job routes", () => {
    expect(parseJobAction("/jobs/job-123/start-db")).toBeNull();
    expect(parseJobAction("/jobs/job%201/artifact")).toBeNull();
    expect(parseJobAction("/jobs/%E0%A4%A/artifact")).toBeNull();
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
    expect(cleanStorageCopyConcurrency(99)).toBe(64);
    expect(cleanStorageCopyConcurrency("0")).toBe(1);
    expect(cleanStorageCopyConcurrency("bad")).toBe(DEFAULT_STORAGE_COPY_CONCURRENCY);

    expect(cleanHardTimeout(30)).toBe(60);
    expect(cleanHardTimeout(99999)).toBe(2 * 60 * 60);
    expect(cleanHardTimeout("bad")).toBe(DEFAULT_HARD_TIMEOUT_SECONDS);
  });

  it("parses boolean confirmation flags", () => {
    expect(cleanBooleanFlag(true)).toBe(true);
    expect(cleanBooleanFlag("yes")).toBe(true);
    expect(cleanBooleanFlag("0")).toBe(false);
  });
});

describe("pruneJobEvents", () => {
  const event = (phase: string, index: number) => ({
    at: new Date(index * 1000).toISOString(),
    level: "info" as const,
    phase,
    message: `${phase} ${index}`,
  });

  it("keeps milestones when a long file listing floods the record with status events", () => {
    // One .debug event per listed folder used to push db_clone.succeeded out,
    // so the web app offered a full rerun instead of a storage-only retry.
    const events = [
      event("target_validation.succeeded", 0),
      event("db_clone.started", 1),
      event("db_clone.succeeded", 2),
      event("storage_copy.started", 3),
      ...Array.from({ length: 5000 }, (_, index) => event("storage_copy.debug", 4 + index)),
      ...Array.from({ length: 500 }, (_, index) => event("storage_copy.progress", 5004 + index)),
      event("monitor.timeout", 5504),
    ];

    const pruned = events.reduce<ReturnType<typeof event>[]>(
      (record, next) => pruneJobEvents([...record, next]),
      [],
    );

    expect(pruned.length).toBeLessThanOrEqual(MAX_JOB_EVENTS);
    expect(pruned.map((entry) => entry.phase)).toEqual(
      expect.arrayContaining([
        "target_validation.succeeded",
        "db_clone.started",
        "db_clone.succeeded",
        "storage_copy.started",
        "monitor.timeout",
      ]),
    );
    const debug = pruned.filter((entry) => entry.phase === "storage_copy.debug");
    const progress = pruned.filter((entry) => entry.phase === "storage_copy.progress");
    // The newest status events of each kind stay, for the live progress view.
    expect(debug.length).toBeLessThanOrEqual(50);
    expect(debug.at(-1)?.message).toBe("storage_copy.debug 5003");
    expect(progress.length).toBeGreaterThanOrEqual(100);
    expect(progress.at(-1)?.message).toBe("storage_copy.progress 5503");
  });

  it("leaves a short record untouched", () => {
    const events = Array.from({ length: MAX_JOB_EVENTS }, (_, index) =>
      event("storage_copy.debug", index),
    );
    expect(pruneJobEvents(events)).toBe(events);
  });
});
