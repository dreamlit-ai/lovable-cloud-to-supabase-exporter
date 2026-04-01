import { describe, expect, it, vi } from "vitest";
import type { JobDebug, JobRecord } from "@dreamlit/lovable-cloud-to-supabase-exporter-core";
import worker, { LovableExporterJob } from "../index.js";

const buildDebug = (task: JobDebug["task"]): JobDebug => ({
  task,
  source: null,
  target: null,
  source_project_url: null,
  target_project_url: null,
  storage_copy_concurrency: 4,
  data_restore_mode: "replace",
  storage_copy_mode: task === "db" ? "off" : "full",
  hard_timeout_seconds: null,
  pgsslmode: "require",
  container_start_invoked: true,
  monitor_raw_error: null,
  monitor_exit_code: null,
  failure_class: null,
  failure_hint: null,
});

const buildJobRecord = (overrides: Partial<JobRecord> = {}): JobRecord => ({
  status: "idle",
  run_id: null,
  started_at: new Date().toISOString(),
  finished_at: null,
  error: null,
  events: [],
  debug: buildDebug("storage"),
  ...overrides,
});

const createState = (monitor: () => Promise<void>, artifactFetch?: () => Promise<Response>) => {
  const store = new Map<string, unknown>();
  const destroy = vi.fn(async () => {});
  const setAlarm = vi.fn(async () => {});
  const getTcpPort = vi.fn(() => ({
    fetch: vi.fn(async () => {
      if (!artifactFetch) {
        throw new Error("artifact fetch not configured");
      }
      return artifactFetch();
    }),
  }));

  return {
    rawStore: store,
    destroy,
    setAlarm,
    state: {
      storage: {
        get: vi.fn(async (key: string) => store.get(key)),
        put: vi.fn(async (key: string, value: unknown) => {
          store.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
          store.delete(key);
        }),
        deleteAll: vi.fn(async () => {
          store.clear();
        }),
        setAlarm,
      },
      container: {
        monitor: vi.fn(monitor),
        destroy,
        getTcpPort,
      },
      waitUntil: vi.fn(),
    },
  };
};

const buildDoRequest = (
  path: string,
  init: RequestInit = {},
  options: { serviceAuth?: boolean } = {},
) => {
  const headers = new Headers(init.headers);
  headers.set("x-job-id", "job-test");
  headers.set("x-worker-origin", "https://app.example");
  if (options.serviceAuth) {
    headers.set("x-auth-kind", "service");
  }

  return new Request(`https://job${path}`, {
    ...init,
    headers,
  });
};

describe("LovableExporterJob monitorRun", () => {
  it("marks unfinished storage jobs as storage_copy.succeeded when monitor completes cleanly", async () => {
    const ctx = createState(async () => {});
    const job = new LovableExporterJob(ctx.state as never, {} as never);

    ctx.rawStore.set(
      "status",
      buildJobRecord({
        status: "running",
        run_id: "run-1",
        debug: buildDebug("storage"),
      }),
    );
    ctx.rawStore.set("session", {
      jobId: "job-1",
      runId: "run-1",
      callbackToken: "token-1",
    });

    await (job as unknown as { monitorRun(runId: string): Promise<void> }).monitorRun("run-1");

    const status = ctx.rawStore.get("status") as JobRecord;
    expect(status.status).toBe("succeeded");
    expect(status.error).toBeNull();
    expect(status.events.at(-1)?.phase).toBe("storage_copy.succeeded");
    expect(status.events.some((event) => event.phase === "export.succeeded")).toBe(false);
    expect(ctx.rawStore.has("session")).toBe(false);
    expect(ctx.rawStore.has("cleanup_after")).toBe(true);
    expect(ctx.destroy).toHaveBeenCalledTimes(1);
    expect(ctx.setAlarm).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite already-failed storage jobs when monitor completes after the callback", async () => {
    const ctx = createState(async () => {});
    const job = new LovableExporterJob(ctx.state as never, {} as never);

    ctx.rawStore.set(
      "status",
      buildJobRecord({
        status: "failed",
        run_id: "run-2",
        finished_at: new Date().toISOString(),
        error: "Storage copy completed with 1 object failure.",
        debug: {
          ...buildDebug("storage"),
          failure_class: "storage_copy_partial_failure",
          failure_hint: "Retry storage only to continue copying the remaining objects.",
        },
        events: [
          {
            at: new Date().toISOString(),
            level: "error",
            phase: "storage_copy.failed",
            message: "Storage copy completed with 1 object failure.",
            data: {
              objects_total: 1,
              objects_copied: 0,
              objects_failed: 1,
            },
          },
        ],
      }),
    );
    ctx.rawStore.set("session", {
      jobId: "job-2",
      runId: "run-2",
      callbackToken: "token-2",
    });

    await (job as unknown as { monitorRun(runId: string): Promise<void> }).monitorRun("run-2");

    const status = ctx.rawStore.get("status") as JobRecord;
    expect(status.status).toBe("failed");
    expect(status.events).toHaveLength(1);
    expect(status.events[0]?.phase).toBe("storage_copy.failed");
    expect(status.events.some((event) => event.phase === "storage_copy.succeeded")).toBe(false);
  });
});

describe("LovableExporterJob handleArtifactDownload", () => {
  it("issues short-lived artifact access URLs for ready download jobs", async () => {
    const ctx = createState(async () => {});
    const job = new LovableExporterJob(ctx.state as never, {} as never);

    ctx.rawStore.set(
      "status",
      buildJobRecord({
        status: "running",
        run_id: "run-3",
        debug: buildDebug("download"),
        events: [
          {
            at: new Date().toISOString(),
            level: "info",
            phase: "artifact_delivery.ready",
            message: "ZIP artifact is ready to stream.",
          },
        ],
      }),
    );
    ctx.rawStore.set("session", {
      jobId: "job-test",
      runId: "run-3",
      callbackToken: "token-3",
    });

    const response = await job.fetch(
      buildDoRequest("/jobs/job-test/artifact-access", { method: "POST" }, { serviceAuth: true }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { download_url: string; expires_at: string };
    expect(payload.download_url).toContain("/jobs/job-test/artifact?token=");
    expect(payload.expires_at).toMatch(/T/);

    const storedAccess = ctx.rawStore.get("artifact_access") as {
      token: string;
      runId: string;
      expiresAt: number;
    };
    expect(payload.download_url).toContain(storedAccess.token);
    expect(storedAccess.runId).toBe("run-3");
    expect(storedAccess.expiresAt).toBeGreaterThan(Date.now());
  });

  it("proxies live download streams once a valid artifact token is presented and consumes the token", async () => {
    const upstreamBody = "zip-stream";
    const ctx = createState(
      async () => {},
      async () =>
        new Response(upstreamBody, {
          status: 200,
          headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": 'attachment; filename="artifact.zip"',
          },
        }),
    );
    const job = new LovableExporterJob(ctx.state as never, {} as never);

    ctx.rawStore.set(
      "status",
      buildJobRecord({
        status: "running",
        run_id: "run-3",
        debug: buildDebug("download"),
        events: [
          {
            at: new Date().toISOString(),
            level: "info",
            phase: "artifact_delivery.ready",
            message: "ZIP artifact is ready to stream.",
          },
        ],
      }),
    );
    ctx.rawStore.set("session", {
      jobId: "job-test",
      runId: "run-3",
      callbackToken: "token-3",
    });
    ctx.rawStore.set("artifact_access", {
      token: "artifact-token",
      runId: "run-3",
      expiresAt: Date.now() + 60_000,
    });

    const response = await job.fetch(
      buildDoRequest("/jobs/job-test/artifact?token=artifact-token"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="artifact.zip"');
    expect(await response.text()).toBe(upstreamBody);
    expect(ctx.rawStore.has("artifact_access")).toBe(false);
  });

  it("waits through delayed upstream readiness before consuming the artifact token", async () => {
    let attempts = 0;
    const ctx = createState(
      async () => {},
      async () => {
        attempts += 1;
        if (attempts < 3) {
          return new Response("not ready", {
            status: 503,
          });
        }

        return new Response("zip-stream", {
          status: 200,
          headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": 'attachment; filename="artifact.zip"',
          },
        });
      },
    );
    const job = new LovableExporterJob(ctx.state as never, {} as never);

    ctx.rawStore.set(
      "status",
      buildJobRecord({
        status: "running",
        run_id: "run-6",
        debug: buildDebug("download"),
        events: [
          {
            at: new Date().toISOString(),
            level: "info",
            phase: "artifact_delivery.ready",
            message: "ZIP artifact is ready to stream.",
          },
        ],
      }),
    );
    ctx.rawStore.set("session", {
      jobId: "job-test",
      runId: "run-6",
      callbackToken: "token-6",
    });
    ctx.rawStore.set("artifact_access", {
      token: "artifact-token",
      runId: "run-6",
      expiresAt: Date.now() + 60_000,
    });

    const response = await job.fetch(
      buildDoRequest("/jobs/job-test/artifact?token=artifact-token"),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("zip-stream");
    expect(attempts).toBe(3);
    expect(ctx.rawStore.has("artifact_access")).toBe(false);
  });

  it("keeps the artifact token when the upstream stream is not yet reachable", async () => {
    const ctx = createState(
      async () => {},
      async () =>
        new Response("not ready", {
          status: 503,
        }),
    );
    const job = new LovableExporterJob(ctx.state as never, {} as never);

    ctx.rawStore.set(
      "status",
      buildJobRecord({
        status: "running",
        run_id: "run-5",
        debug: buildDebug("download"),
        events: [
          {
            at: new Date().toISOString(),
            level: "info",
            phase: "artifact_delivery.ready",
            message: "ZIP artifact is ready to stream.",
          },
        ],
      }),
    );
    ctx.rawStore.set("session", {
      jobId: "job-test",
      runId: "run-5",
      callbackToken: "token-5",
    });
    ctx.rawStore.set("artifact_access", {
      token: "artifact-token",
      runId: "run-5",
      expiresAt: Date.now() + 60_000,
    });

    const response = await job.fetch(
      buildDoRequest("/jobs/job-test/artifact?token=artifact-token"),
    );

    expect(response.status).toBe(503);
    expect(ctx.rawStore.get("artifact_access")).toEqual({
      token: "artifact-token",
      runId: "run-5",
      expiresAt: expect.any(Number),
    });
  }, 12_000);

  it("rejects artifact requests before the live stream is ready", async () => {
    const ctx = createState(async () => {});
    const job = new LovableExporterJob(ctx.state as never, {} as never);

    ctx.rawStore.set(
      "status",
      buildJobRecord({
        status: "running",
        run_id: "run-4",
        debug: buildDebug("download"),
      }),
    );
    ctx.rawStore.set("session", {
      jobId: "job-test",
      runId: "run-4",
      callbackToken: "token-4",
    });

    const response = await job.fetch(
      buildDoRequest("/jobs/job-test/artifact", {}, { serviceAuth: true }),
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("still preparing");
  });
});

describe("worker artifact token bypass", () => {
  it("forwards unauthenticated artifact token requests to the durable object", async () => {
    const fetchStub = vi.fn(async () => new Response("ok", { status: 200 }));
    const env = {
      LOVABLE_EXPORTER_JOB: {
        idFromName: vi.fn(() => "durable-id"),
        get: vi.fn(() => ({
          fetch: fetchStub,
        })),
      },
    };

    const response = await worker.fetch(
      new Request("https://worker.example/jobs/job-1/artifact?token=abc123"),
      env as never,
    );

    expect(response.status).toBe(200);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0]?.[0]).toBe("https://job/jobs/job-1/artifact?token=abc123");
  });
});
