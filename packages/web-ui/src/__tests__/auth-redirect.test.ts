import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAuthRedirectError,
  getCleanAuthRedirectUrl,
  hasAuthRedirectSession,
  readAuthRedirectFragmentFromHash,
  readAuthRedirectFragmentFromUrl,
  toHashlessUrl,
} from "../auth-redirect";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("auth redirect helpers", () => {
  it("removes stale fragments from redirect URLs without changing origin, path, or search", () => {
    expect(
      toHashlessUrl("https://exporter.example.com/tool?source=email#error_code=otp_expired"),
    ).toBe("https://exporter.example.com/tool?source=email");
    expect(
      getCleanAuthRedirectUrl("https://exporter.example.com/tool?source=email#access_token=old"),
    ).toBe("https://exporter.example.com/tool?source=email");
  });

  it("reads Supabase auth errors from URL fragments", () => {
    const fragment = readAuthRedirectFragmentFromUrl(
      "https://exporter.example.com/tool#error=access_denied&error_code=otp_expired",
    );

    expect(getAuthRedirectError(fragment)).toBe("otp_expired");
    expect(hasAuthRedirectSession(fragment)).toBe(false);
  });

  it("parses malformed nested fragments so a fresh session can still be consumed", () => {
    const fragment = readAuthRedirectFragmentFromHash(
      "#error=access_denied&error_code=otp_expired#access_token=fresh&refresh_token=refresh&type=magiclink",
    );

    expect(fragment?.accessToken).toBe("fresh");
    expect(fragment?.refreshToken).toBe("refresh");
    expect(fragment?.type).toBe("magiclink");
    expect(hasAuthRedirectSession(fragment)).toBe(true);
  });

  it("ignores non-auth page anchors", () => {
    expect(readAuthRedirectFragmentFromUrl("https://exporter.example.com/tool#faq")).toBeNull();
  });

  it("scrubs browser auth fragments from the address bar", async () => {
    vi.resetModules();
    const replaceState = vi.fn();
    const state = { navigation: "state" };

    vi.stubGlobal("window", {
      location: {
        href: "https://exporter.example.com/tool?source=email#error=access_denied&error_code=otp_expired",
        origin: "https://exporter.example.com",
      },
      history: {
        state,
        replaceState,
      },
    });

    const { consumeBrowserAuthRedirectFragment } = await import("../auth-redirect");

    expect(consumeBrowserAuthRedirectFragment()).toMatchObject({
      error: "access_denied",
      errorCode: "otp_expired",
    });
    expect(replaceState).toHaveBeenCalledWith(
      state,
      "",
      "https://exporter.example.com/tool?source=email",
    );
  });
});
