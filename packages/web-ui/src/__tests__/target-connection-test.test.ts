import { afterEach, describe, expect, it, vi } from "vitest";
import { testTargetConnection } from "../target-connection-test";

const originalFetch = globalThis.fetch;
const targetDbUrl =
  "postgresql://postgres:password@db.qicvuexedqhfkkyntpeh.supabase.co:5432/postgres?sslmode=require";
const targetProjectUrl = "https://qicvuexedqhfkkyntpeh.supabase.co";
const targetAdminKey = "sb_secret_key";

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("testTargetConnection", () => {
  it("sends the expected Supabase REST request", async () => {
    let calledInput: Parameters<typeof fetch>[0] | null = null;
    let calledInit: Parameters<typeof fetch>[1] | undefined;
    const fetchMock = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        calledInput = input;
        calledInit = init;
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      testTargetConnection({
        targetDbUrl,
        targetDbUrlInput: targetDbUrl,
        targetProjectUrl,
        targetAdminKey,
      }),
    ).resolves.toEqual({ ok: true, message: "Connected" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calledInput).toBe("https://qicvuexedqhfkkyntpeh.supabase.co/rest/v1/");
    expect(calledInit).toMatchObject({
      method: "GET",
      headers: {
        apikey: targetAdminKey,
        Authorization: `Bearer ${targetAdminKey}`,
      },
    });
  });

  it("fails before fetch when the connection string is invalid", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      testTargetConnection({
        targetDbUrl: "",
        targetDbUrlInput: "not-a-postgres-url",
        targetProjectUrl: "",
        targetAdminKey,
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: "Paste a valid Postgres connection string.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails clearly for an unauthorized key", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "invalid api key" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    await expect(
      testTargetConnection({
        targetDbUrl,
        targetDbUrlInput: targetDbUrl,
        targetProjectUrl,
        targetAdminKey: "bad-key",
      }),
    ).resolves.toMatchObject({
      ok: false,
      message:
        "Secret API key rejected. Create a new secret key for this Supabase project and try again.",
    });
  });

  it("fails clearly for a network error", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    await expect(
      testTargetConnection({
        targetDbUrl,
        targetDbUrlInput: targetDbUrl,
        targetProjectUrl,
        targetAdminKey,
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: "Could not reach Supabase. Check the connection string project ref and try again.",
    });
  });

  it("fails clearly for timeout", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(
      () => new Promise<Response>(() => undefined),
    ) as unknown as typeof fetch;

    const resultPromise = testTargetConnection({
      targetDbUrl,
      targetDbUrlInput: targetDbUrl,
      targetProjectUrl,
      targetAdminKey,
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);
    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      message: "Supabase connection test timed out. Check the project and try again.",
    });
  });
});
