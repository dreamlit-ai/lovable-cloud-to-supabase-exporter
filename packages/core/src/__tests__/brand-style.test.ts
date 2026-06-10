import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractBrandStyleFromWebsite,
  fetchBrandStyleLeadProfile,
  getBrandStyleNormalizedHost,
  normalizeBrandStyleWebsiteUrl,
  pickBrandStylePayload,
} from "../brand-style";

describe("Brand Style helpers", () => {
  it("normalizes website URLs and hosts", () => {
    const websiteUrl = normalizeBrandStyleWebsiteUrl("www.example.com/");

    expect(websiteUrl).toBe("https://www.example.com");
    expect(getBrandStyleNormalizedHost(websiteUrl ?? "")).toBe("example.com");
    expect(normalizeBrandStyleWebsiteUrl("ftp://example.com")).toBeNull();
  });

  it("picks the nested brand style payload from extractor responses", () => {
    const brandStyle = { brandName: "Acme" };

    expect(
      pickBrandStylePayload({
        ok: true,
        data: {
          brand_style: brandStyle,
        },
      }),
    ).toBe(brandStyle);
  });
});

describe("extractBrandStyleFromWebsite", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the webapp exporter endpoint with the shared landing secret", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, brand_style: { brandName: "Acme" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const payload = await extractBrandStyleFromWebsite({
      endpoint: "https://app.dreamlit.ai/api/exporter/brand-style",
      secret: "shared-secret",
      websiteUrl: "acme.com",
      exporterUserId: "user-123",
      email: "owner@acme.com",
    });

    expect(payload).toEqual({ ok: true, brand_style: { brandName: "Acme" } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://app.dreamlit.ai/api/exporter/brand-style");
    expect((init.headers as Record<string, string>)["x-landing-secret"]).toBe("shared-secret");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({
      website: "https://acme.com",
      website_url: "https://acme.com",
      exporter_user_id: "user-123",
      email: "owner@acme.com",
    });
  });
});

describe("fetchBrandStyleLeadProfile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("queries the webapp for the stored lead by user id and email", async () => {
    const profile = {
      website_url: "https://acme.com",
      normalized_host: "acme.com",
      status: "READY",
      brand_style: { brandName: "Acme" },
      extracted_at: "2026-06-09T12:00:00.000Z",
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, profile }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchBrandStyleLeadProfile({
      endpoint: "https://app.dreamlit.ai/api/exporter/brand-style",
      secret: "shared-secret",
      exporterUserId: "user-123",
      email: "owner@acme.com",
    });

    expect(result).toEqual(profile);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://app.dreamlit.ai/api/exporter/brand-style?exporter_user_id=user-123&email=owner%40acme.com",
    );
    expect((init.headers as Record<string, string>)["x-landing-secret"]).toBe("shared-secret");
  });

  it("returns null when no lead is stored yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, profile: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(
      fetchBrandStyleLeadProfile({
        endpoint: "https://app.dreamlit.ai/api/exporter/brand-style",
        secret: "shared-secret",
        exporterUserId: "user-123",
      }),
    ).resolves.toBeNull();
  });
});
