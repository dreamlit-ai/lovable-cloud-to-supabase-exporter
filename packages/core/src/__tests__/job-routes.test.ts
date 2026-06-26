import { describe, expect, it } from "vitest";
import { isValidJobId, parseJobActionPath, WORKER_JOB_ROUTE_ACTIONS } from "../job-routes.js";

describe("job route helpers", () => {
  it("validates shared job ids", () => {
    expect(isValidJobId("job-1")).toBe(true);
    expect(isValidJobId("job_1.2026")).toBe(true);
    expect(isValidJobId("")).toBe(false);
    expect(isValidJobId("../escape")).toBe(false);
    expect(isValidJobId("job with spaces")).toBe(false);
    expect(isValidJobId("a".repeat(81))).toBe(false);
  });

  it("parses valid job routes", () => {
    expect(parseJobActionPath("/jobs/job-123/status")).toEqual({
      jobId: "job-123",
      action: "status",
    });
  });

  it("rejects invalid ids and unsupported actions", () => {
    expect(parseJobActionPath("/jobs/job%201/status")).toBeNull();
    expect(parseJobActionPath("/jobs/%E0%A4%A/status")).toBeNull();
    expect(parseJobActionPath("/jobs/job-123/missing")).toBeNull();
    expect(parseJobActionPath("/jobs/job-123/start-db", WORKER_JOB_ROUTE_ACTIONS)).toBeNull();
  });
});
