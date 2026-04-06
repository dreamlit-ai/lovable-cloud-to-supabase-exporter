import { describe, expect, it } from "vitest";
import {
  INTERCOM_EXPORTER_SOURCE,
  INTERCOM_EXPORTER_SOURCE_LABEL,
  getIntercomAttributes,
  normalizeIntercomEmail,
} from "../intercom-config";

describe("intercom-config", () => {
  it("normalizes signed-in emails before sending them to Intercom", () => {
    expect(normalizeIntercomEmail("  user@example.com  ")).toBe("user@example.com");
    expect(normalizeIntercomEmail("   ")).toBeNull();
    expect(normalizeIntercomEmail()).toBeNull();
  });

  it("marks anonymous visitors as exporter traffic", () => {
    expect(getIntercomAttributes()).toEqual({
      source_tool: INTERCOM_EXPORTER_SOURCE_LABEL,
      support_source: INTERCOM_EXPORTER_SOURCE,
    });
  });

  it("includes the signed-in email alongside the exporter source marker", () => {
    expect(getIntercomAttributes("user@example.com")).toEqual({
      email: "user@example.com",
      source_tool: INTERCOM_EXPORTER_SOURCE_LABEL,
      support_source: INTERCOM_EXPORTER_SOURCE,
    });
  });
});
