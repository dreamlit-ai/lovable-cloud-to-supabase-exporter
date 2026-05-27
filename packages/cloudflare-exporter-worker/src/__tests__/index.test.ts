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
  const start = vi.fn();
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
        start,
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

describe("LovableExporterJob startTargetDbTest", () => {
  it("starts a target database test container with only the Postgres URL", async () => {
    const ctx = createState(async () => {});
    const job = new LovableExporterJob(ctx.state as never, {} as never);

    const response = await job.fetch(
      buildDoRequest(
        "/jobs/job-test/start-target-db-test",
        {
          method: "POST",
          body: JSON.stringify({
            target_db_url:
              "postgresql://postgres:password@db.qicvuexedqhfkkyntpeh.supabase.co:5432/postgres?sslmode=require",
          }),
        },
        { serviceAuth: true },
      ),
    );

    expect(response.status).toBe(202);
    expect(ctx.state.container.start).toHaveBeenCalledTimes(1);
    expect(ctx.state.container.start).toHaveBeenCalledWith(
      expect.objectContaining({
        enableInternet: true,
        hardTimeout: 60_000,
        env: expect.objectContaining({
          JOB_MODE: "target-db-test",
          JOB_ID: "job-test",
          TARGET_DB_URL:
            "postgresql://postgres:password@db.qicvuexedqhfkkyntpeh.supabase.co:5432/postgres?sslmode=require",
          PGSSLMODE: "require",
        }),
      }),
    );

    const status = ctx.rawStore.get("status") as JobRecord;
    expect(status.status).toBe("running");
    expect(status.debug?.task).toBe("db");
    expect(status.events.some((event) => event.phase === "target_db_connection.started")).toBe(
      true,
    );
  });
});

describe("LovableExporterJob testTargetAdminKey", () => {
  it("checks the target secret key with Supabase from the worker", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const ctx = createState(async () => {});
      const job = new LovableExporterJob(ctx.state as never, {} as never);

      const response = await job.fetch(
        buildDoRequest(
          "/jobs/job-test/test-target-admin-key",
          {
            method: "POST",
            body: JSON.stringify({
              target_project_url: "https://demo.supabase.co/path",
              target_admin_key: "sb_secret_demo",
            }),
          },
          { serviceAuth: true },
        ),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://demo.supabase.co/auth/v1/admin/users?page=1&per_page=1",
        {
          headers: {
            apikey: "sb_secret_demo",
            Authorization: "Bearer sb_secret_demo",
          },
        },
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("LovableExporterJob handleContainerCallback", () => {
  it("logs accepted failure callbacks with sanitized diagnostic details", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const ctx = createState(async () => {});
      const job = new LovableExporterJob(ctx.state as never, {} as never);

      ctx.rawStore.set(
        "status",
        buildJobRecord({
          status: "running",
          run_id: "run-callback",
          debug: buildDebug("export"),
        }),
      );
      ctx.rawStore.set("session", {
        jobId: "job-callback",
        runId: "run-callback",
        callbackToken: "token-callback",
      });

      const response = await job.fetch(
        buildDoRequest("/jobs/job-callback/container-callback", {
          method: "POST",
          body: JSON.stringify({
            callback_token: "token-callback",
            run_id: "run-callback",
            level: "error",
            phase: "db_clone.failed",
            message: "Database clone failed.",
            status: "failed",
            error: "Data dump failed on Lovable Cloud database.",
            debug_patch: {
              failure_class: "data_dump_failed",
              failure_hint: "Verify Lovable Cloud DB access and table permissions.",
              monitor_exit_code: 42,
              monitor_raw_error:
                "pg_dump: error: connection to postgresql://postgres:super-secret@db.example.supabase.co/postgres failed",
              target_db_url: "postgresql://postgres:super-secret@target.example/postgres",
            },
          }),
        }),
      );

      expect(response.status).toBe(202);
      expect(consoleError).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String(consoleError.mock.calls[0]?.[0])) as Record<
        string,
        unknown
      >;
      expect(payload).toMatchObject({
        event: "exporter.container_callback.failure",
        job_id: "job-test",
        run_id: "run-callback",
        level: "error",
        phase: "db_clone.failed",
        status: "failed",
        failure_class: "data_dump_failed",
        monitor_exit_code: 42,
      });
      expect(payload.monitor_raw_error).toContain("<redacted-postgres-url>");
      expect(JSON.stringify(payload)).not.toContain("super-secret");
      expect(JSON.stringify(payload)).not.toContain("target.example");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not log successful callbacks", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const ctx = createState(async () => {});
      const job = new LovableExporterJob(ctx.state as never, {} as never);

      ctx.rawStore.set(
        "status",
        buildJobRecord({
          status: "running",
          run_id: "run-progress",
          debug: buildDebug("export"),
        }),
      );
      ctx.rawStore.set("session", {
        jobId: "job-progress",
        runId: "run-progress",
        callbackToken: "token-progress",
      });

      const response = await job.fetch(
        buildDoRequest("/jobs/job-progress/container-callback", {
          method: "POST",
          body: JSON.stringify({
            callback_token: "token-progress",
            run_id: "run-progress",
            level: "info",
            phase: "db_clone.progress",
            message: "Dumping source data.",
            status: "running",
          }),
        }),
      );

      expect(response.status).toBe(202);
      expect(consoleError).not.toHaveBeenCalled();

      const successResponse = await job.fetch(
        buildDoRequest("/jobs/job-progress/container-callback", {
          method: "POST",
          body: JSON.stringify({
            callback_token: "token-progress",
            run_id: "run-progress",
            level: "info",
            phase: "export.succeeded",
            message: "Export completed.",
            status: "succeeded",
            error: null,
          }),
        }),
      );

      expect(successResponse.status).toBe(202);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

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

  it("captures a sanitized PostHog event when a job reaches terminal status", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const ctx = createState(async () => {});
      const job = new LovableExporterJob(ctx.state as never, {} as never);

      ctx.rawStore.set(
        "status",
        buildJobRecord({
          status: "running",
          run_id: "run-analytics",
          started_at: "2026-05-07T12:00:00.000Z",
          debug: buildDebug("export"),
          events: [
            {
              at: "2026-05-07T12:00:05.000Z",
              level: "info",
              phase: "db_clone.started",
              message: "DB clone started.",
              data: { table_count: 3 },
            },
          ],
        }),
      );
      ctx.rawStore.set("session", {
        jobId: "job-analytics",
        runId: "run-analytics",
        callbackToken: "token-analytics",
        analyticsContext: {
          posthog_distinct_id: "user-distinct-id",
          posthog_session_id: "session-id",
          posthog_project_key: "phc_test",
          posthog_host: "https://eu.i.posthog.com",
        },
      });
      ctx.rawStore.set("owner", {
        kind: "user",
        userId: "user-1",
        email: "user@example.com",
      });

      await (job as unknown as { monitorRun(runId: string): Promise<void> }).monitorRun(
        "run-analytics",
      );
      await Promise.all(ctx.state.waitUntil.mock.calls.map(([promise]) => promise));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe("https://eu.i.posthog.com/capture/");
      const body = JSON.parse(String((init as RequestInit).body)) as {
        api_key: string;
        event: string;
        distinct_id: string;
        properties: Record<string, unknown>;
      };
      expect(body.api_key).toBe("phc_test");
      expect(body.event).toBe("exporter_job_finished");
      expect(body.distinct_id).toBe("user-distinct-id");
      expect(body.properties).toMatchObject({
        outcome: "succeeded",
        task: "export",
        action: "transfer",
        variant: "full",
        db_table_count: 3,
        emitter: "worker",
        posthog_session_id: "session-id",
        $session_id: "session-id",
        $set: {
          email: "user@example.com",
        },
      });
      expect(body.properties.duration_ms).toEqual(expect.any(Number));
      expect(body.properties.job_id_hash).toEqual(expect.any(String));
      expect(body.properties.run_id_hash).toEqual(expect.any(String));
    } finally {
      vi.unstubAllGlobals();
    }
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
  it("issues live-timeout-aligned artifact access URLs for ready download jobs", async () => {
    const ctx = createState(async () => {});
    const job = new LovableExporterJob(ctx.state as never, {} as never);
    const issuedAt = Date.now();

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
    const payload = (await response.json()) as {
      download_url: string;
      expires_at: string;
    };
    expect(payload.download_url).toContain("/jobs/job-test/artifact?token=");
    expect(payload.expires_at).toMatch(/T/);

    const storedAccess = ctx.rawStore.get("artifact_access") as {
      token: string;
      runId: string;
      expiresAt: number;
    };
    expect(payload.download_url).toContain(storedAccess.token);
    expect(storedAccess.runId).toBe("run-3");
    expect(storedAccess.expiresAt).toBeGreaterThanOrEqual(issuedAt + 5 * 60 * 1000);
  });

  it("caps artifact access URLs to the live stream expiry", async () => {
    const ctx = createState(async () => {});
    const job = new LovableExporterJob(ctx.state as never, {} as never);
    const artifactExpiresAt = Date.now() + 60_000;

    ctx.rawStore.set(
      "status",
      buildJobRecord({
        status: "running",
        run_id: "run-expiring",
        debug: buildDebug("download"),
        events: [
          {
            at: new Date().toISOString(),
            level: "info",
            phase: "artifact_delivery.ready",
            message: "ZIP artifact is ready to stream.",
            data: {
              artifact_expires_at: new Date(artifactExpiresAt).toISOString(),
            },
          },
        ],
      }),
    );
    ctx.rawStore.set("session", {
      jobId: "job-test",
      runId: "run-expiring",
      callbackToken: "token-expiring",
    });

    const response = await job.fetch(
      buildDoRequest("/jobs/job-test/artifact-access", { method: "POST" }, { serviceAuth: true }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { expires_at: string };
    const storedAccess = ctx.rawStore.get("artifact_access") as {
      expiresAt: number;
    };
    expect(storedAccess.expiresAt).toBeLessThanOrEqual(artifactExpiresAt);
    expect(Date.parse(payload.expires_at)).toBe(storedAccess.expiresAt);
  });

  it("reuses an outstanding artifact access URL for the same run", async () => {
    const ctx = createState(async () => {});
    const job = new LovableExporterJob(ctx.state as never, {} as never);
    const expiresAt = Date.now() + 60_000;

    ctx.rawStore.set(
      "status",
      buildJobRecord({
        status: "running",
        run_id: "run-reuse",
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
      runId: "run-reuse",
      callbackToken: "token-reuse",
    });
    ctx.rawStore.set("artifact_access", {
      token: "existing-token",
      runId: "run-reuse",
      expiresAt,
    });

    const response = await job.fetch(
      buildDoRequest("/jobs/job-test/artifact-access", { method: "POST" }, { serviceAuth: true }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      download_url: string;
      expires_at: string;
    };
    expect(payload.download_url).toContain("token=existing-token");
    expect(Date.parse(payload.expires_at)).toBe(expiresAt);
    expect(ctx.rawStore.get("artifact_access")).toEqual({
      token: "existing-token",
      runId: "run-reuse",
      expiresAt,
    });
  });

  it("rejects new artifact access URLs after the live stream window expires", async () => {
    const ctx = createState(async () => {});
    const job = new LovableExporterJob(ctx.state as never, {} as never);

    ctx.rawStore.set(
      "status",
      buildJobRecord({
        status: "running",
        run_id: "run-expired",
        debug: buildDebug("download"),
        events: [
          {
            at: new Date(Date.now() - 10 * 60_000).toISOString(),
            level: "info",
            phase: "artifact_delivery.ready",
            message: "ZIP artifact is ready to stream.",
            data: {
              artifact_expires_at: new Date(Date.now() - 1000).toISOString(),
            },
          },
        ],
      }),
    );
    ctx.rawStore.set("session", {
      jobId: "job-test",
      runId: "run-expired",
      callbackToken: "token-expired",
    });

    const response = await job.fetch(
      buildDoRequest("/jobs/job-test/artifact-access", { method: "POST" }, { serviceAuth: true }),
    );

    expect(response.status).toBe(410);
    expect(await response.text()).toContain("download window expired");
    expect(ctx.rawStore.has("artifact_access")).toBe(false);
  });

  it("returns a friendly expiry error after the live stream has timed out", async () => {
    const ctx = createState(async () => {});
    const job = new LovableExporterJob(ctx.state as never, {} as never);

    ctx.rawStore.set(
      "status",
      buildJobRecord({
        status: "failed",
        run_id: "run-timed-out",
        error: "ZIP artifact stream was never requested before the live timeout expired.",
        debug: {
          ...buildDebug("download"),
          failure_class: "artifact_delivery_timeout",
        },
        events: [
          {
            at: new Date(Date.now() - 10 * 60_000).toISOString(),
            level: "info",
            phase: "artifact_delivery.ready",
            message: "ZIP artifact is ready to stream.",
          },
        ],
      }),
    );
    ctx.rawStore.set("session", {
      jobId: "job-test",
      runId: "run-timed-out",
      callbackToken: "token-timed-out",
    });

    const response = await job.fetch(
      buildDoRequest("/jobs/job-test/artifact-access", { method: "POST" }, { serviceAuth: true }),
    );

    expect(response.status).toBe(410);
    expect(await response.text()).toContain("download window expired");
  });

  it("rejects artifact downloads after the live stream window expires", async () => {
    const ctx = createState(
      async () => {},
      async () =>
        new Response("zip-stream", {
          status: 200,
          headers: {
            "Content-Type": "application/zip",
          },
        }),
    );
    const job = new LovableExporterJob(ctx.state as never, {} as never);

    ctx.rawStore.set(
      "status",
      buildJobRecord({
        status: "running",
        run_id: "run-expired-download",
        debug: buildDebug("download"),
        events: [
          {
            at: new Date(Date.now() - 10 * 60_000).toISOString(),
            level: "info",
            phase: "artifact_delivery.ready",
            message: "ZIP artifact is ready to stream.",
            data: {
              artifact_expires_at: new Date(Date.now() - 1000).toISOString(),
            },
          },
        ],
      }),
    );
    ctx.rawStore.set("session", {
      jobId: "job-test",
      runId: "run-expired-download",
      callbackToken: "token-expired-download",
    });
    ctx.rawStore.set("artifact_access", {
      token: "artifact-token",
      runId: "run-expired-download",
      expiresAt: Date.now() + 60_000,
    });

    const response = await job.fetch(
      buildDoRequest("/jobs/job-test/artifact?token=artifact-token"),
    );

    expect(response.status).toBe(410);
    expect(await response.text()).toContain("download window expired");
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
