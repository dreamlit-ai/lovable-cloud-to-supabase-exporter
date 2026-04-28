import { afterEach, describe, expect, it, vi } from "vitest";
import { testSourceEdgeFunction } from "../source-edge-function-test";

const originalFetch = globalThis.fetch;

const successPayload = {
  ok: true,
  build_id: "2026-03-04",
  checks: {
    supabase_db_url: true,
    service_role_key: true,
  },
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("testSourceEdgeFunction", () => {
  it("sends the expected ping request", async () => {
    let calledInput: Parameters<typeof fetch>[0] | null = null;
    let calledInit: Parameters<typeof fetch>[1] | undefined;
    const fetchMock = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        calledInput = input;
        calledInit = init;
        return new Response(JSON.stringify(successPayload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      testSourceEdgeFunction({
        sourceEdgeFunctionUrl: "https://source-ref.supabase.co/functions/v1/migrate-helper",
        sourceEdgeFunctionAccessKey: "access-key",
      }),
    ).resolves.toMatchObject({ ok: true, message: "Connected", buildId: "2026-03-04" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calledInput).toBe("https://source-ref.supabase.co/functions/v1/migrate-helper");
    expect(calledInit).toMatchObject({
      method: "POST",
      headers: {
        "x-access-key": "access-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "ping" }),
    });
  });

  it("succeeds on a valid ping payload", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(successPayload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    await expect(
      testSourceEdgeFunction({
        sourceEdgeFunctionUrl: "https://source-ref.supabase.co/functions/v1/migrate-helper",
        sourceEdgeFunctionAccessKey: "access-key",
      }),
    ).resolves.toEqual({ ok: true, message: "Connected", buildId: "2026-03-04" });
  });

  it("fails before fetch for an invalid URL", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      testSourceEdgeFunction({
        sourceEdgeFunctionUrl: "not-a-url",
        sourceEdgeFunctionAccessKey: "access-key",
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: "Enter a valid http or https edge function URL.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails clearly for a network error", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    await expect(
      testSourceEdgeFunction({
        sourceEdgeFunctionUrl: "https://source-ref.supabase.co/functions/v1/migrate-helper",
        sourceEdgeFunctionAccessKey: "access-key",
      }),
    ).resolves.toMatchObject({
      ok: false,
      message:
        "Could not reach the edge function. Confirm the URL is copied correctly and Lovable has deployed it.",
    });
  });

  it("fails clearly for timeout", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(
      () => new Promise<Response>(() => undefined),
    ) as unknown as typeof fetch;

    const resultPromise = testSourceEdgeFunction({
      sourceEdgeFunctionUrl: "https://source-ref.supabase.co/functions/v1/migrate-helper",
      sourceEdgeFunctionAccessKey: "access-key",
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);
    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      message: "Edge function test timed out. Confirm it is deployed and try again.",
    });
  });

  it("fails clearly for an unauthorized response", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    await expect(
      testSourceEdgeFunction({
        sourceEdgeFunctionUrl: "https://source-ref.supabase.co/functions/v1/migrate-helper",
        sourceEdgeFunctionAccessKey: "bad-key",
      }),
    ).resolves.toMatchObject({
      ok: false,
      message:
        "Access key rejected. Check the access key and redeploy the helper if you changed it.",
    });
  });

  it("fails clearly for invalid JSON", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    await expect(
      testSourceEdgeFunction({
        sourceEdgeFunctionUrl: "https://source-ref.supabase.co/functions/v1/migrate-helper",
        sourceEdgeFunctionAccessKey: "access-key",
      }),
    ).resolves.toMatchObject({
      ok: false,
      message:
        "Edge function returned invalid JSON. Confirm the migrate-helper code was pasted and deployed.",
    });
  });

  it("fails clearly for non-OK without payload detail", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("", {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    await expect(
      testSourceEdgeFunction({
        sourceEdgeFunctionUrl: "https://source-ref.supabase.co/functions/v1/migrate-helper",
        sourceEdgeFunctionAccessKey: "access-key",
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: "Edge function test failed with status 500.",
    });
  });

  it("fails clearly for a malformed success payload", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    await expect(
      testSourceEdgeFunction({
        sourceEdgeFunctionUrl: "https://source-ref.supabase.co/functions/v1/migrate-helper",
        sourceEdgeFunctionAccessKey: "access-key",
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: "Edge function ping response was invalid. Redeploy the latest migrate-helper code.",
    });
  });
});
