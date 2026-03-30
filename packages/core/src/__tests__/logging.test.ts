import { describe, expect, it } from "vitest";
import {
  parseLogVerbosity,
  sanitizeLogText,
  sanitizeLogValue,
  sanitizeStoredLogText,
} from "../index";

describe("sanitizeLogText", () => {
  it("redacts postgres urls and bearer tokens", () => {
    const sanitized = sanitizeLogText(
      "connecting to postgresql://user:secret@db.example.com:5432/app?sslmode=require Authorization: Bearer abc123",
    );

    expect(sanitized).toContain("<redacted-postgres-url>");
    expect(sanitized).toContain("Authorization: Bearer <redacted>");
    expect(sanitized).not.toContain("secret@db.example.com");
    expect(sanitized).not.toContain("abc123");
  });

  it("redacts secret key assignments", () => {
    const sanitized = sanitizeLogText(
      "SOURCE_EDGE_FUNCTION_ACCESS_KEY=shhh target_admin_key:\"super-secret\" callback_token='abc'",
    );

    expect(sanitized).toContain("SOURCE_EDGE_FUNCTION_ACCESS_KEY=<redacted>");
    expect(sanitized).toContain('target_admin_key:"<redacted>"');
    expect(sanitized).toContain("callback_token='<redacted>'");
  });
});

describe("sanitizeLogValue", () => {
  it("redacts nested secret fields and string values", () => {
    const sanitized = sanitizeLogValue({
      target_admin_key: "secret",
      nested: {
        callback_token: "token",
        message: "postgresql://user:pw@host:5432/db",
      },
    }) as Record<string, unknown>;

    expect(sanitized.target_admin_key).toBe("<redacted>");
    expect((sanitized.nested as Record<string, unknown>).callback_token).toBe("<redacted>");
    expect((sanitized.nested as Record<string, unknown>).message).toBe("<redacted-postgres-url>");
  });
});

describe("sanitizeStoredLogText", () => {
  it("truncates long values after redaction", () => {
    const sanitized = sanitizeStoredLogText(`target_admin_key=secret\n${"x".repeat(80)}`, 60);

    expect(sanitized).toContain("target_admin_key=<redacted>");
    expect(sanitized).toContain("[truncated");
    expect(sanitized.length).toBeLessThanOrEqual(90);
  });
});

describe("parseLogVerbosity", () => {
  it("defaults to normal and accepts debug", () => {
    expect(parseLogVerbosity(undefined)).toBe("normal");
    expect(parseLogVerbosity("DEBUG")).toBe("debug");
  });
});
