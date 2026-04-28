const DEFAULT_SOURCE_EDGE_FUNCTION_TEST_TIMEOUT_MS = 10000;

export type SourceEdgeFunctionTestResult =
  | {
      ok: true;
      message: string;
      buildId: string | null;
    }
  | {
      ok: false;
      message: string;
    };

type SourceEdgeFunctionTestOptions = {
  sourceEdgeFunctionUrl: string;
  sourceEdgeFunctionAccessKey: string;
  timeoutMs?: number;
};

type SourceEdgeFunctionPingPayload = {
  ok?: unknown;
  build_id?: unknown;
  checks?: unknown;
  error?: unknown;
  message?: unknown;
};

const asJsonObject = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const validateHttpUrl = (value: string): string | null => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
};

const parsePayload = (raw: string): SourceEdgeFunctionPingPayload | null => {
  try {
    return asJsonObject(JSON.parse(raw)) as SourceEdgeFunctionPingPayload | null;
  } catch {
    return null;
  }
};

const payloadErrorMessage = (payload: SourceEdgeFunctionPingPayload | null): string | null => {
  if (!payload) return null;
  return asNonEmptyString(payload.error) ?? asNonEmptyString(payload.message);
};

const hasValidPingPayload = (payload: SourceEdgeFunctionPingPayload | null) => {
  const checks = asJsonObject(payload?.checks);
  return (
    payload?.ok === true && checks?.supabase_db_url === true && checks?.service_role_key === true
  );
};

export async function testSourceEdgeFunction({
  sourceEdgeFunctionUrl,
  sourceEdgeFunctionAccessKey,
  timeoutMs = DEFAULT_SOURCE_EDGE_FUNCTION_TEST_TIMEOUT_MS,
}: SourceEdgeFunctionTestOptions): Promise<SourceEdgeFunctionTestResult> {
  const trimmedUrl = sourceEdgeFunctionUrl.trim();
  const trimmedAccessKey = sourceEdgeFunctionAccessKey.trim();

  if (!trimmedUrl) {
    return { ok: false, message: "Edge function URL is required." };
  }

  if (!trimmedAccessKey) {
    return { ok: false, message: "Access key is required." };
  }

  const requestUrl = validateHttpUrl(trimmedUrl);
  if (!requestUrl) {
    return { ok: false, message: "Enter a valid http or https edge function URL." };
  }

  const controller = new AbortController();
  let didTimeout = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  try {
    const responsePromise = fetch(requestUrl, {
      method: "POST",
      headers: {
        "x-access-key": trimmedAccessKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "ping" }),
      signal: controller.signal,
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => {
          didTimeout = true;
          controller.abort();
          reject(new Error("source-edge-function-test-timeout"));
        },
        Math.max(1, timeoutMs),
      );
    });

    const response = await Promise.race([responsePromise, timeoutPromise]);
    const raw = await response.text();
    const payload = raw.trim() ? parsePayload(raw) : {};

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          message:
            "Access key rejected. Check the access key and redeploy the helper if you changed it.",
        };
      }

      const detail = payload === null ? null : payloadErrorMessage(payload);
      return {
        ok: false,
        message: detail
          ? `Edge function test failed with status ${response.status}: ${detail}`
          : `Edge function test failed with status ${response.status}.`,
      };
    }

    if (!payload) {
      return {
        ok: false,
        message:
          "Edge function returned invalid JSON. Confirm the migrate-helper code was pasted and deployed.",
      };
    }

    if (!hasValidPingPayload(payload)) {
      return {
        ok: false,
        message:
          "Edge function ping response was invalid. Redeploy the latest migrate-helper code.",
      };
    }

    return {
      ok: true,
      message: "Connected",
      buildId: asNonEmptyString(payload.build_id),
    };
  } catch {
    if (didTimeout) {
      return {
        ok: false,
        message: "Edge function test timed out. Confirm it is deployed and try again.",
      };
    }

    return {
      ok: false,
      message:
        "Could not reach the edge function. Confirm the URL is copied correctly and Lovable has deployed it.",
    };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
