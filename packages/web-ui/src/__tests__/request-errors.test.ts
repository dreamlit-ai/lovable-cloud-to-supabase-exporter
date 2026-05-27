import { describe, expect, it } from "vitest";
import { toRequestErrorMessage } from "../request-errors";

describe("request error messages", () => {
  it("uses actionable copy for browser fetch failures", () => {
    expect(
      toRequestErrorMessage(new TypeError("Failed to fetch"), "Request failed.", {
        networkFallback: "Could not reach the exporter. Check your connection, then retry.",
      }),
    ).toBe("Could not reach the exporter. Check your connection, then retry.");
  });

  it("preserves explicit API errors", () => {
    expect(
      toRequestErrorMessage(new Error("Unauthorized"), "Request failed.", {
        networkFallback: "Could not reach the exporter.",
      }),
    ).toBe("Unauthorized");
  });

  it("falls back for unknown thrown values", () => {
    expect(toRequestErrorMessage("oops", "Request failed.")).toBe("Request failed.");
  });
});
