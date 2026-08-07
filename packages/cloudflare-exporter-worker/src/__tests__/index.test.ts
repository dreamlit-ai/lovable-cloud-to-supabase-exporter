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
  it("forwards authenticated service requests to the Durable Object", async () => {
    const durableObjectFetch = vi.fn(async () => Response.json({ ok: true }));
    const env = {
      API_BEARER_TOKEN: "worker-token",
      LOVABLE_EXPORTER_JOB: {
        idFromName: vi.fn(() => "job-id"),
        get: vi.fn(() => ({ fetch: durableObjectFetch })),
      },
    };

    const response = await worker.fetch(
      new Request("https://worker.example/jobs/job-1/status", {
        headers: {
          Authorization: "Bearer worker-token",
        },
      }),
      env as never,
    );

    expect(response.status).toBe(200);
    expect(env.LOVABLE_EXPORTER_JOB.idFromName).toHaveBeenCalledWith("job-1");
    expect(durableObjectFetch).toHaveBeenCalledTimes(1);
    const [forwardedUrl, forwardedInit] = durableObjectFetch.mock.calls[0] ?? [];
    expect(String(forwardedUrl)).toBe("https://job/jobs/job-1/status");
    const headers = new Headers((forwardedInit as RequestInit).headers);
    expect(headers.get("x-auth-kind")).toBe("service");
  });

  it("starts a target database test container with only the Postgres URL", async () => {
    const ctx = createState(async () => {});
    const job = new LovableExporterJob(ctx.state as never, {} as never);
    ctx.rawStore.set("cleanup_after", Date.now() + 1000);

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
    expect(ctx.rawStore.has("cleanup_after")).toBe(false);
    expect(ctx.rawStore.get("run_timeout")).toMatchObject({
      runId: status.run_id,
      hardTimeoutSeconds: 60,
    });
    expect(ctx.rawStore.get("session")).toMatchObject({
      jobId: "job-test",
      runId: status.run_id,
      callbackToken: expect.any(String),
    });
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
  it("clears artifact access when a terminal download callback lands", async () => {
    const ctx = createState(async () => {});
    const job = new LovableExporterJob(ctx.state as never, {} as never);
    ctx.rawStore.set(
      "status",
      buildJobRecord({
        status: "running",
        run_id: "run-terminal-download",
        debug: buildDebug("download"),
      }),
    );
    ctx.rawStore.set("session", {
      jobId: "job-test",
      runId: "run-terminal-download",
      callbackToken: "callback-terminal-download",
    });
    ctx.rawStore.set("artifact_access", {
      token: "artifact-token",
      runId: "run-terminal-download",
      expiresAt: Date.now() + 60_000,
      deliveryId: "delivery-terminal-download",
    });

    const response = await job.fetch(
      buildDoRequest("/jobs/job-test/container-callback", {
        method: "POST",
        body: JSON.stringify({
          callback_token: "callback-terminal-download",
          run_id: "run-terminal-download",
          level: "info",
          phase: "download.succeeded",
          message: "ZIP export completed.",
          status: "succeeded",
          error: null,
        }),
      }),
    );

    expect(response.status).toBe(202);
    expect(ctx.rawStore.has("artifact_access")).toBe(false);
  });

  it("extends the run timeout for download delivery liveness callbacks", async () => {
    const now = Date.now();
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const ctx = createState(async () => {});
      const job = new LovableExporterJob(ctx.state as never, {} as never);
      ctx.rawStore.set(
        "status",
        buildJobRecord({
          status: "running",
          run_id: "run-live-download",
          debug: { ...buildDebug("download"), hard_timeout_seconds: 120 },
        }),
      );
      ctx.rawStore.set("session", {
        jobId: "job-test",
        runId: "run-live-download",
        callbackToken: "callback-live-download",
      });
      ctx.rawStore.set("run_timeout", {
        runId: "run-live-download",
        hardTimeoutSeconds: 120,
        expiresAt: now + 1_000,
      });

      const response = await job.fetch(
        buildDoRequest("/jobs/job-test/container-callback", {
          method: "POST",
          body: JSON.stringify({
            callback_token: "callback-live-download",
            run_id: "run-live-download",
            level: "info",
            phase: "artifact_delivery.request_accepted",
            message: "ZIP artifact request reached the export runtime.",
            status: "running",
          }),
        }),
      );

      expect(response.status).toBe(202);
      expect(ctx.rawStore.get("run_timeout")).toEqual({
        runId: "run-live-download",
        hardTimeoutSeconds: 120,
        expiresAt: now + 120_000 + 60_000,
      });
      expect(ctx.setAlarm).toHaveBeenLastCalledWith(now + 120_000 + 60_000);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("does not extend run timeouts for non-download callbacks", async () => {
    const ctx = createState(async () => {});
    const job = new LovableExporterJob(ctx.state as never, {} as never);
    const expiresAt = Date.now() + 1_000;
    ctx.rawStore.set(
      "status",
      buildJobRecord({
        status: "running",
        run_id: "run-export-callback",
        debug: { ...buildDebug("export"), hard_timeout_seconds: 120 },
      }),
    );
    ctx.rawStore.set("session", {
      jobId: "job-test",
      runId: "run-export-callback",
      callbackToken: "callback-export",
    });
    ctx.rawStore.set("run_timeout", {
      runId: "run-export-callback",
      hardTimeoutSeconds: 120,
      expiresAt,
    });

    const response = await job.fetch(
      buildDoRequest("/jobs/job-test/container-callback", {
        method: "POST",
        body: JSON.stringify({
          callback_token: "callback-export",
          run_id: "run-export-callback",
          level: "info",
          phase: "artifact_delivery.request_accepted",
          message: "Unrelated export callback.",
          status: "running",
        }),
      }),
    );

    expect(response.status).toBe(202);
    expect(ctx.rawStore.get("run_timeout")).toEqual({
      runId: "run-export-callback",
      hardTimeoutSeconds: 120,
      expiresAt,
    });
    expect(ctx.setAlarm).not.toHaveBeenCalled();
  });

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

  it("logs target database psql diagnostics with redacted connection details", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const ctx = createState(async () => {});
      const job = new LovableExporterJob(ctx.state as never, {} as never);

      ctx.rawStore.set(
        "status",
        buildJobRecord({
          status: "running",
          run_id: "run-target-db",
          debug: buildDebug("db"),
        }),
      );
      ctx.rawStore.set("session", {
        jobId: "job-target-db",
        runId: "run-target-db",
        callbackToken: "token-target-db",
      });

      const diagnostic =
        'psql: error: connection to postgresql://postgres:super-secret@db.example.supabase.co/postgres failed: FATAL: password authentication failed for user "postgres"';
      const response = await job.fetch(
        buildDoRequest("/jobs/job-target-db/container-callback", {
          method: "POST",
          body: JSON.stringify({
            callback_token: "token-target-db",
            run_id: "run-target-db",
            level: "error",
            phase: "target_db_connection.failed",
            message: "Could not connect to the Supabase database.",
            status: "failed",
            error: "Could not connect to the Supabase database.",
            data: {
              psql_diagnostic: diagnostic,
            },
            debug_patch: {
              failure_class: "target_db_connection_failed",
              failure_hint: "Check the connection string and database password, then try again.",
              monitor_exit_code: 67,
              monitor_raw_error: diagnostic,
              psql_diagnostic: diagnostic,
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
        phase: "target_db_connection.failed",
        failure_class: "target_db_connection_failed",
        monitor_exit_code: 67,
      });
      expect(payload.psql_diagnostic).toContain("password authentication failed");
      expect(payload.psql_diagnostic).toContain("<redacted-postgres-url>");
      expect(JSON.stringify(payload)).not.toContain("super-secret");
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

  it("marks unfinished target DB tests as connected", async () => {
    const ctx = createState(async () => {});
    const job = new LovableExporterJob(ctx.state as never, {} as never);

    ctx.rawStore.set(
      "status",
      buildJobRecord({
        status: "running",
        run_id: "run-db-test",
        debug: buildDebug("db"),
      }),
    );
    ctx.rawStore.set("session", {
      jobId: "job-db-test",
      runId: "run-db-test",
      callbackToken: "token-db-test",
    });

    await (job as unknown as { monitorRun(runId: string): Promise<void> }).monitorRun(
      "run-db-test",
    );

    const status = ctx.rawStore.get("status") as JobRecord;
    expect(status.status).toBe("succeeded");
    expect(status.events.at(-1)?.phase).toBe("target_db_connection.succeeded");
    expect(status.events.some((event) => event.phase === "export.succeeded")).toBe(false);
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

  it("does not clear a newer run session when an older monitor finishes late", async () => {
    const ctx = createState(async () => {});
    const job = new LovableExporterJob(ctx.state as never, {} as never);

    ctx.rawStore.set(
      "status",
      buildJobRecord({
        status: "running",
        run_id: "run-new",
        debug: buildDebug("storage"),
      }),
    );
    ctx.rawStore.set("session", {
      jobId: "job-new",
      runId: "run-new",
      callbackToken: "token-new",
    });
    ctx.rawStore.set("run_timeout", {
      runId: "run-new",
      hardTimeoutSeconds: 60,
      expiresAt: Date.now() + 60_000,
    });

    await (job as unknown as { monitorRun(runId: string): Promise<void> }).monitorRun("run-old");

    expect(ctx.rawStore.get("session")).toMatchObject({
      jobId: "job-new",
      runId: "run-new",
    });
    expect(ctx.rawStore.get("run_timeout")).toMatchObject({
      runId: "run-new",
    });
    const status = ctx.rawStore.get("status") as JobRecord;
    expect(status.status).toBe("running");
    expect(status.run_id).toBe("run-new");
  });
});

describe("LovableExporterJob alarm", () => {
  it("marks expired running jobs as failed when monitor does not report a terminal status", async () => {
    const ctx = createState(async () => {});
    const job = new LovableExporterJob(ctx.state as never, {} as never);

    ctx.rawStore.set(
      "status",
      buildJobRecord({
        status: "running",
        run_id: "run-stale",
        debug: {
          ...buildDebug("export"),
          hard_timeout_seconds: 60,
        },
      }),
    );
    ctx.rawStore.set("session", {
      jobId: "job-stale",
      runId: "run-stale",
      callbackToken: "token-stale",
    });
    ctx.rawStore.set("run_timeout", {
      runId: "run-stale",
      hardTimeoutSeconds: 60,
      expiresAt: Date.now() - 1,
    });

    await job.alarm();
    await Promise.all(ctx.state.waitUntil.mock.calls.map(([promise]) => promise));

    const status = ctx.rawStore.get("status") as JobRecord;
    expect(status.status).toBe("failed");
    expect(status.error).toBe("Export runtime timed out before reporting a final result.");
    expect(status.debug?.failure_class).toBe("runtime_monitor_timeout");
    expect(status.debug?.failure_hint).toContain("Start a new export");
    expect(status.events.at(-1)).toMatchObject({
      level: "error",
      phase: "monitor.timeout",
      message: "Export runtime timed out before reporting a final result.",
      data: {
        failure_class: "runtime_monitor_timeout",
        hard_timeout_seconds: 60,
      },
    });
    expect(ctx.rawStore.has("session")).toBe(false);
    expect(ctx.rawStore.has("run_timeout")).toBe(false);
    expect(ctx.rawStore.has("cleanup_after")).toBe(true);
  });

  it("does not overwrite terminal jobs when a stale timeout alarm arrives late", async () => {
    const ctx = createState(async () => {});
    const job = new LovableExporterJob(ctx.state as never, {} as never);

    ctx.rawStore.set(
      "status",
      buildJobRecord({
        status: "succeeded",
        run_id: "run-terminal",
        finished_at: new Date().toISOString(),
        error: null,
        debug: buildDebug("storage"),
        events: [
          {
            at: new Date().toISOString(),
            level: "info",
            phase: "storage_copy.succeeded",
            message: "Storage copy completed.",
          },
        ],
      }),
    );
    ctx.rawStore.set("run_timeout", {
      runId: "run-terminal",
      hardTimeoutSeconds: 60,
      expiresAt: Date.now() - 1,
    });

    await job.alarm();

    const status = ctx.rawStore.get("status") as JobRecord;
    expect(status.status).toBe("succeeded");
    expect(status.events).toHaveLength(1);
    expect(status.events[0]?.phase).toBe("storage_copy.succeeded");
    expect(ctx.rawStore.has("run_timeout")).toBe(false);
  });
});

describe("LovableExporterJob startDownload artifact basename", () => {
  const startDownloadBody = (artifactBasename?: unknown) => ({
    source_type: "postgres_url",
    source_db_url: "postgresql://postgres:password@db.example.com:5432/postgres",
    ...(artifactBasename === undefined ? {} : { artifact_basename: artifactBasename }),
  });

  const markArtifactReady = (rawStore: Map<string, unknown>, session: { runId: string }): void => {
    rawStore.set(
      "status",
      buildJobRecord({
        status: "running",
        run_id: session.runId,
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
    rawStore.set("artifact_access", {
      token: "artifact-token",
      runId: session.runId,
      expiresAt: Date.now() + 60_000,
      deliveryId: "delivery-basename",
    });
  };

  it("uses a custom basename for the container path and later artifact response", async () => {
    const ctx = createState(
      () => new Promise<void>(() => {}),
      async () =>
        new Response("zip-stream", {
          status: 200,
          headers: { "Content-Type": "application/zip" },
        }),
    );
    const job = new LovableExporterJob(ctx.state as never, {} as never);

    const startResponse = await job.fetch(
      buildDoRequest(
        "/jobs/job-test/start-download",
        {
          method: "POST",
          body: JSON.stringify(startDownloadBody("replit-export")),
        },
        { serviceAuth: true },
      ),
    );

    expect(startResponse.status).toBe(202);
    expect(ctx.state.container.start).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          ARTIFACT_OUTPUT_PATH: "/tmp/artifacts/replit-export-job-test.zip",
          ARTIFACT_LIVE_TIMEOUT_SECONDS: String(30 * 60),
        }),
      }),
    );
    const session = ctx.rawStore.get("session") as {
      runId: string;
      artifactBasename: string;
    };
    expect(session.artifactBasename).toBe("replit-export");

    markArtifactReady(ctx.rawStore, session);
    const restartedJob = new LovableExporterJob(ctx.state as never, {} as never);
    const artifactResponse = await restartedJob.fetch(
      buildDoRequest("/jobs/job-test/artifact?token=artifact-token"),
    );

    expect(artifactResponse.status).toBe(200);
    expect(artifactResponse.headers.get("Content-Disposition")).toBe(
      'attachment; filename="replit-export-job-test.zip"',
    );
  });

  it("rejects an explicitly invalid basename", async () => {
    const ctx = createState(async () => {});
    const job = new LovableExporterJob(ctx.state as never, {} as never);

    const response = await job.fetch(
      buildDoRequest(
        "/jobs/job-test/start-download",
        {
          method: "POST",
          body: JSON.stringify(startDownloadBody("Replit Export")),
        },
        { serviceAuth: true },
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("artifact_basename");
    expect(ctx.state.container.start).not.toHaveBeenCalled();
    expect(ctx.rawStore.has("session")).toBe(false);
  });

  it("keeps the lovable-cloud-export basename when the field is absent", async () => {
    const ctx = createState(
      () => new Promise<void>(() => {}),
      async () =>
        new Response("zip-stream", {
          status: 200,
          headers: { "Content-Type": "application/zip" },
        }),
    );
    const job = new LovableExporterJob(ctx.state as never, {} as never);

    const startResponse = await job.fetch(
      buildDoRequest(
        "/jobs/job-test/start-download",
        {
          method: "POST",
          body: JSON.stringify(startDownloadBody()),
        },
        { serviceAuth: true },
      ),
    );

    expect(startResponse.status).toBe(202);
    expect(ctx.state.container.start).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          ARTIFACT_OUTPUT_PATH: "/tmp/artifacts/lovable-cloud-export-job-test.zip",
        }),
      }),
    );
    const session = ctx.rawStore.get("session") as {
      runId: string;
      artifactBasename: string;
    };
    expect(session.artifactBasename).toBe("lovable-cloud-export");

    markArtifactReady(ctx.rawStore, session);
    const artifactResponse = await job.fetch(
      buildDoRequest("/jobs/job-test/artifact?token=artifact-token"),
    );

    expect(artifactResponse.status).toBe(200);
    expect(artifactResponse.headers.get("Content-Disposition")).toBe(
      'attachment; filename="lovable-cloud-export-job-test.zip"',
    );
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
      delivery_id: string;
    };
    expect(payload.download_url).toContain("/jobs/job-test/artifact?token=");
    expect(payload.expires_at).toMatch(/T/);

    const storedAccess = ctx.rawStore.get("artifact_access") as {
      token: string;
      runId: string;
      expiresAt: number;
      deliveryId: string;
    };
    expect(payload.download_url).toContain(storedAccess.token);
    expect(storedAccess.runId).toBe("run-3");
    expect(payload.delivery_id).toBe(storedAccess.deliveryId);
    expect(storedAccess.expiresAt).toBeGreaterThanOrEqual(issuedAt + 30 * 60 * 1000);
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
      deliveryId: "delivery-reuse",
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
      deliveryId: "delivery-reuse",
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
      deliveryId: "delivery-expired",
    });

    const response = await job.fetch(
      buildDoRequest("/jobs/job-test/artifact?token=artifact-token"),
    );

    expect(response.status).toBe(410);
    expect(await response.text()).toContain("download window expired");
  });

  it("reuses the same artifact token after an aborted attempt", async () => {
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
      deliveryId: "delivery-3",
    });

    const response = await job.fetch(
      buildDoRequest("/jobs/job-test/artifact?token=artifact-token"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="lovable-cloud-export-job-test.zip"',
    );
    expect(await response.text()).toBe(upstreamBody);
    expect(ctx.rawStore.get("artifact_access")).toMatchObject({
      token: "artifact-token",
      runId: "run-3",
    });

    const abortedCallback = await job.fetch(
      buildDoRequest("/jobs/job-test/container-callback", {
        method: "POST",
        body: JSON.stringify({
          callback_token: "token-3",
          run_id: "run-3",
          level: "warn",
          phase: "artifact_delivery.stream_aborted",
          message: "ZIP artifact streaming was interrupted.",
          status: "running",
          data: { attempt: 1, bytes_written: 10 },
        }),
      }),
    );
    expect(abortedCallback.status).toBe(202);

    const retryResponse = await job.fetch(
      buildDoRequest("/jobs/job-test/artifact?token=artifact-token"),
    );
    expect(retryResponse.status).toBe(200);
    expect(await retryResponse.text()).toBe(upstreamBody);
    expect(ctx.rawStore.get("artifact_access")).toMatchObject({
      token: "artifact-token",
      runId: "run-3",
    });
    const status = ctx.rawStore.get("status") as JobRecord;
    expect(status.events.map((event) => event.phase)).toEqual(
      expect.arrayContaining([
        "artifact_delivery.request_received",
        "artifact_delivery.token_validated",
        "artifact_delivery.container_connected",
      ]),
    );
    expect(
      status.events.find((event) => event.phase === "artifact_delivery.container_connected")?.data
        ?.delivery_id,
    ).toBe("delivery-3");
  });

  it("waits through delayed upstream readiness without consuming the artifact token", async () => {
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
      deliveryId: "delivery-6",
    });

    const response = await job.fetch(
      buildDoRequest("/jobs/job-test/artifact?token=artifact-token"),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("zip-stream");
    expect(attempts).toBe(3);
    expect(ctx.rawStore.get("artifact_access")).toMatchObject({
      token: "artifact-token",
      runId: "run-6",
    });
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
      deliveryId: "delivery-5",
    });

    const response = await job.fetch(
      buildDoRequest("/jobs/job-test/artifact?token=artifact-token"),
    );

    expect(response.status).toBe(503);
    expect(ctx.rawStore.get("artifact_access")).toEqual({
      token: "artifact-token",
      runId: "run-5",
      expiresAt: expect.any(Number),
      deliveryId: "delivery-5",
    });
  }, 12_000);

  it("records why an artifact token was rejected", async () => {
    const ctx = createState(async () => {});
    const job = new LovableExporterJob(ctx.state as never, {} as never);
    ctx.rawStore.set(
      "status",
      buildJobRecord({
        status: "running",
        run_id: "run-invalid-token",
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
      runId: "run-invalid-token",
      callbackToken: "callback-token",
    });
    ctx.rawStore.set("artifact_access", {
      token: "expected-token",
      runId: "run-invalid-token",
      expiresAt: Date.now() + 60_000,
      deliveryId: "delivery-invalid-token",
    });

    const response = await job.fetch(buildDoRequest("/jobs/job-test/artifact?token=wrong-token"));

    expect(response.status).toBe(401);
    const status = ctx.rawStore.get("status") as JobRecord;
    expect(
      status.events.find((event) => event.phase === "artifact_delivery.request_rejected")?.data,
    ).toMatchObject({
      delivery_id: "delivery-invalid-token",
      reason: "token_mismatch",
      status_code: 401,
    });
  });

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
      new Request("https://worker.example/jobs/job-1/artifact?token=abc123", {
        headers: { "cf-ray": "ray-123" },
      }),
      env as never,
    );

    expect(response.status).toBe(200);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0]?.[0]).toBe("https://job/jobs/job-1/artifact?token=abc123");
    const forwardedHeaders = new Headers(
      (fetchStub.mock.calls[0]?.[1] as RequestInit | undefined)?.headers,
    );
    expect(forwardedHeaders.get("x-artifact-edge-received-at")).toMatch(/T/);
    expect(forwardedHeaders.get("x-artifact-edge-cf-ray")).toBe("ray-123");
  });

  it("logs and rejects artifact requests that have neither a token nor service auth", async () => {
    const fetchStub = vi.fn(async () => new Response("ok", { status: 200 }));
    const env = {
      LOVABLE_EXPORTER_JOB: {
        idFromName: vi.fn(() => "durable-id"),
        get: vi.fn(() => ({ fetch: fetchStub })),
      },
    };

    const response = await worker.fetch(
      new Request("https://worker.example/jobs/job-1/artifact"),
      env as never,
    );

    expect(response.status).toBe(401);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("runner size routing", () => {
  const buildNamespace = () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    return {
      namespace: {
        idFromName: vi.fn(() => "job-id"),
        get: vi.fn(() => ({ fetch })),
      },
      fetch,
    };
  };

  const authedRequest = (jobId: string) =>
    new Request(`https://worker.example/jobs/${jobId}/status`, {
      headers: { Authorization: "Bearer worker-token" },
    });

  it("routes runner-suffixed job ids to the matching larger namespace", async () => {
    const base = buildNamespace();
    const large = buildNamespace();
    const xl = buildNamespace();
    const env = {
      API_BEARER_TOKEN: "worker-token",
      LOVABLE_EXPORTER_JOB: base.namespace,
      LOVABLE_EXPORTER_JOB_LARGE: large.namespace,
      LOVABLE_EXPORTER_JOB_XL: xl.namespace,
    };

    await worker.fetch(authedRequest("job-1--rl"), env as never);
    expect(large.namespace.idFromName).toHaveBeenCalledWith("job-1--rl");
    expect(base.namespace.idFromName).not.toHaveBeenCalled();

    await worker.fetch(authedRequest("job-2--rx"), env as never);
    expect(xl.namespace.idFromName).toHaveBeenCalledWith("job-2--rx");

    await worker.fetch(authedRequest("job-3"), env as never);
    expect(base.namespace.idFromName).toHaveBeenCalledWith("job-3");
  });

  it("falls back to the default namespace when larger bindings are absent", async () => {
    const base = buildNamespace();
    const env = {
      API_BEARER_TOKEN: "worker-token",
      LOVABLE_EXPORTER_JOB: base.namespace,
    };

    const response = await worker.fetch(authedRequest("job-1--rx"), env as never);
    expect(response.status).toBe(200);
    expect(base.namespace.idFromName).toHaveBeenCalledWith("job-1--rx");
  });
});
