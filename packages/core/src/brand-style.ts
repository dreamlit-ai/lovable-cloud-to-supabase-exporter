const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const getWebappErrorMessage = (payload: unknown, status: number): string => {
  const record = asRecord(payload);
  return (
    asNonEmptyString(record?.message) ??
    asNonEmptyString(record?.error_description) ??
    asNonEmptyString(record?.error) ??
    `Brand Style request failed (${status}).`
  );
};

export const normalizeBrandStyleWebsiteUrl = (value: unknown): string | null => {
  const raw = asNonEmptyString(value);
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) && !/^https?:\/\//iu.test(raw)) return null;

  try {
    const url = new URL(/^https?:\/\//iu.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.href.replace(/\/$/u, "");
  } catch {
    return null;
  }
};

export const getBrandStyleNormalizedHost = (websiteUrl: string): string | null => {
  try {
    return new URL(websiteUrl).hostname.replace(/^www\./iu, "").toLowerCase();
  } catch {
    return null;
  }
};

export const pickBrandStylePayload = (payload: unknown): unknown => {
  const root = asRecord(payload);
  if (!root) return payload;

  const data = asRecord(root.data);
  const result = asRecord(root.result);
  const direct =
    root.brand_style ??
    root.brandStyle ??
    root.style ??
    root.details ??
    data?.brand_style ??
    data?.brandStyle ??
    data?.style ??
    data?.details ??
    result?.brand_style ??
    result?.brandStyle ??
    result?.style ??
    result?.details;

  return direct ?? data ?? result ?? payload;
};

// Brand style extraction and lead storage both live in the Dreamlit webapp
// (POST/GET /api/exporter/brand-style); the exporter only forwards the signed
// in user's identity and website. Both calls authenticate with the same
// shared secret the Dreamlit landing page uses for webapp callbacks.
type WebappBrandStyleConfig = {
  endpoint: string;
  secret: string;
  /**
   * Override for environments where the webapp endpoint needs a custom
   * transport (e.g. the local CLI API trusting a mkcert dev certificate).
   */
  fetchImpl?: typeof fetch;
};

type ExtractBrandStyleInput = WebappBrandStyleConfig & {
  websiteUrl: string;
  exporterUserId: string;
  email?: string | null;
};

export const extractBrandStyleFromWebsite = async ({
  endpoint,
  secret,
  websiteUrl,
  exporterUserId,
  email = null,
  fetchImpl = fetch,
}: ExtractBrandStyleInput): Promise<unknown> => {
  const normalizedWebsiteUrl = normalizeBrandStyleWebsiteUrl(websiteUrl);
  if (!normalizedWebsiteUrl) {
    throw new Error("A valid website URL is required.");
  }

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      "x-landing-secret": secret,
    },
    body: JSON.stringify({
      website: normalizedWebsiteUrl,
      website_url: normalizedWebsiteUrl,
      exporter_user_id: exporterUserId,
      email: email ?? undefined,
    }),
  });

  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(getWebappErrorMessage(payload, response.status));
  }

  return payload;
};

type FetchBrandStyleLeadInput = WebappBrandStyleConfig & {
  exporterUserId: string;
  email?: string | null;
  websiteUrl?: string | null;
};

/**
 * Looks up the latest stored brand style lead for the signed-in exporter
 * user. Returns the serialized lead profile ({ website_url, brand_style, ... })
 * or null when nothing has been extracted yet.
 */
export const fetchBrandStyleLeadProfile = async ({
  endpoint,
  secret,
  exporterUserId,
  email = null,
  websiteUrl = null,
  fetchImpl = fetch,
}: FetchBrandStyleLeadInput): Promise<Record<string, unknown> | null> => {
  const url = new URL(endpoint);
  url.searchParams.set("exporter_user_id", exporterUserId);
  if (email) url.searchParams.set("email", email);
  if (websiteUrl) url.searchParams.set("website_url", websiteUrl);

  const response = await fetchImpl(url, {
    headers: {
      "x-landing-secret": secret,
    },
  });

  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(getWebappErrorMessage(payload, response.status));
  }

  return asRecord(asRecord(payload)?.profile);
};
