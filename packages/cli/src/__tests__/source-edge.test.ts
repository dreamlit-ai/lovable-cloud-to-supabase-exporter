import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSourceFromEdgeFunction } from "../edge";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("resolveSourceFromEdgeFunction", () => {
  it("parses supabase_db_url and service_role_key", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            supabase_db_url: "postgresql://user:pass@db.host:5432/postgres",
            service_role_key: "service-role-key",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const resolved = await resolveSourceFromEdgeFunction({
      sourceEdgeFunctionUrl: "https://source-ref.supabase.co/functions/v1/export-db-url",
      sourceEdgeFunctionAccessKey: "access-key",
    });

    expect(resolved.sourceDbUrl).toBe("postgresql://user:pass@db.host:5432/postgres");
    expect(resolved.sourceAdminKey).toBe("service-role-key");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        "x-access-key": "access-key",
      },
    });
  });

  it("fails when supabase_db_url is missing", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ service_role_key: "service-role-key" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    await expect(
      resolveSourceFromEdgeFunction({
        sourceEdgeFunctionUrl: "https://source-ref.supabase.co/functions/v1/export-db-url",
        sourceEdgeFunctionAccessKey: "access-key",
      }),
    ).rejects.toThrow("supabase_db_url");
  });

  it("surfaces edge function error payload", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    await expect(
      resolveSourceFromEdgeFunction({
        sourceEdgeFunctionUrl: "https://source-ref.supabase.co/functions/v1/export-db-url",
        sourceEdgeFunctionAccessKey: "bad-access-key",
      }),
    ).rejects.toThrow("Unauthorized");
  });
});
