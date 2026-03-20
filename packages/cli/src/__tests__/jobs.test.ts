import { describe, expect, it } from "vitest";
import { isValidJobId } from "../jobs";

describe("isValidJobId", () => {
  it("accepts safe job ids", () => {
    expect(isValidJobId("job-1")).toBe(true);
    expect(isValidJobId("job_1.2026")).toBe(true);
  });

  it("rejects unsafe job ids", () => {
    expect(isValidJobId("")).toBe(false);
    expect(isValidJobId("../escape")).toBe(false);
    expect(isValidJobId("nested/path")).toBe(false);
    expect(isValidJobId("job with spaces")).toBe(false);
    expect(isValidJobId("a".repeat(81))).toBe(false);
  });
});
