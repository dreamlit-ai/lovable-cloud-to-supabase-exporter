import {
  buildFailureDiagnostics,
  buildMigrationSummary,
  classifyContainerFailure,
  normalizeContainerCallbackBody,
  sanitizeLogText,
  sanitizeStoredLogText,
  type SourceType,
  type JobDebug,
  type JobEvent,
  type JobRecord,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core";
import {
  cleanBooleanFlag,
  DEFAULT_STORAGE_COPY_CONCURRENCY,
  cleanHardTimeout,
  cleanHttpUrl,
  cleanPostgresUrl,
  cleanProjectUrl,
  cleanStorageCopyConcurrency,
  cleanString,
  parseJobAction,
} from "./helpers.js";

type Env = {
  LOVABLE_EXPORTER_JOB: DurableObjectNamespace<LovableExporterJob>;
  LOVABLE_EXPORTER_JOB_LARGE?: DurableObjectNamespace<LovableExporterJob>;
  LOVABLE_EXPORTER_JOB_XL?: DurableObjectNamespace<LovableExporterJob>;
  API_BEARER_TOKEN?: string;
  LOG_VERBOSITY?: string;
  SENTRY_DSN?: string;
};

type StartExportBody = {
  source_type?: unknown;
  source_edge_function_url?: unknown;
  source_edge_function_access_key?: unknown;
  source_db_url?: unknown;
  target_db_url?: unknown;
  confirm_target_blank?: unknown;
  source_project_url?: unknown;
  target_project_url?: unknown;
  target_admin_key?: unknown;
  storage_copy_concurrency?: unknown;
  hard_timeout_seconds?: unknown;
  exclude_data_tables?: unknown;
  enable_rls_on_restored_tables?: unknown;
  auth_user_migration?: unknown;
  verification?: unknown;
};

type StartStorageBody = {
  source_type?: unknown;
  source_edge_function_url?: unknown;
  source_edge_function_access_key?: unknown;
  source_db_url?: unknown;
  source_project_url?: unknown;
  target_project_url?: unknown;
  target_admin_key?: unknown;
  storage_copy_concurrency?: unknown;
  hard_timeout_seconds?: unknown;
  skip_existing_target_objects?: unknown;
};

type StartDownloadBody = {
  source_type?: unknown;
  source_edge_function_url?: unknown;
  source_edge_function_access_key?: unknown;
  source_db_url?: unknown;
  source_project_url?: unknown;
  storage_copy_concurrency?: unknown;
  hard_timeout_seconds?: unknown;
  exclude_data_tables?: unknown;
};

type StartTargetDbTestBody = {
  target_db_url?: unknown;
  hard_timeout_seconds?: unknown;
};

type StartSourceInspectBody = {
  source_edge_function_url?: unknown;
  source_edge_function_access_key?: unknown;
  hard_timeout_seconds?: unknown;
};

type TestTargetAdminKeyBody = {
  target_project_url?: unknown;
  target_admin_key?: unknown;
};

type StoredSession = {
  jobId: string;
  runId: string;
  callbackToken: string;
};

type StoredArtifactAccess = {
  token: string;
  runId: string;
  expiresAt: number;
};

type StoredRunTimeout = {
  runId: string;
  hardTimeoutSeconds: number;
  expiresAt: number;
};

type AuthenticatedRequester = {
  kind: "service";
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Expose-Headers": "content-disposition, content-length, content-type",
};

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });

const nowIso = () => new Date().toISOString();
const MAX_EVENTS = 200;
const DOWNLOAD_ARTIFACT_PORT = 8787;
const DOWNLOAD_ARTIFACT_LIVE_TIMEOUT_SECONDS = 5 * 60;
const DEFAULT_DOWNLOAD_STORAGE_CONCURRENCY = DEFAULT_STORAGE_COPY_CONCURRENCY;
const DOWNLOAD_STORAGE_MAX_IN_FLIGHT_BYTES = 64 * 1024 * 1024;
const ARTIFACT_ACCESS_TOKEN_TTL_MS = DOWNLOAD_ARTIFACT_LIVE_TIMEOUT_SECONDS * 1000;
const ARTIFACT_UPSTREAM_RETRY_ATTEMPTS = 40;
const ARTIFACT_UPSTREAM_RETRY_DELAY_MS = 250;
const OPTIONAL_CONTAINER_ENV_KEYS = ["LOG_VERBOSITY", "SENTRY_DSN"] as const;
const CALLBACK_FAILURE_LOG_MAX_CHARS = 2_000;
const RUN_TIMEOUT_GRACE_MS = 60_000;
const CLEANUP_DELAY_MS = 24 * 60 * 60 * 1000;

const addOptionalContainerEnv = (target: Record<string, string>, source: Env): void => {
  for (const key of OPTIONAL_CONTAINER_ENV_KEYS) {
    const value = cleanString(source[key]);
    if (value) {
      target[key] = value;
    }
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const cleanSourceType = (value: unknown): SourceType | null => {
  const raw = cleanString(value);
  if (!raw) return "lovable_edge_function";
  if (raw === "lovable_edge_function" || raw === "postgres_url") return raw;
  return null;
};

const cleanStringArray = (value: unknown): string[] => {
  const rawItems =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value)
        ? value.flatMap((item) => (typeof item === "string" ? item.split(",") : []))
        : [];

  return [...new Set(rawItems.map((item) => item.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
};

const AUTH_USER_MIGRATION_FIELD_ENV = {
  users_table: "AUTH_USERS_TABLE",
  id_column: "AUTH_USER_ID_COLUMN",
  email_column: "AUTH_USER_EMAIL_COLUMN",
  first_name_column: "AUTH_USER_FIRST_NAME_COLUMN",
  last_name_column: "AUTH_USER_LAST_NAME_COLUMN",
  avatar_column: "AUTH_USER_AVATAR_COLUMN",
} as const;

const addAuthUserMigrationEnv = (env: Record<string, string>, value: unknown): void => {
  if (!isRecord(value) || !cleanBooleanFlag(value.enabled)) return;
  env.AUTH_USER_MIGRATION = "1";
  for (const [bodyKey, envKey] of Object.entries(AUTH_USER_MIGRATION_FIELD_ENV)) {
    const fieldValue = cleanString(value[bodyKey]);
    if (fieldValue) {
      env[envKey] = fieldValue;
    }
  }
};

const artifactFileName = (jobId: string) => `lovable-cloud-export-${jobId}.zip`;

const asErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Unexpected error";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const hasJobPhase = (record: JobRecord, phase: string): boolean =>
  record.events.some((event) => event.phase === phase);

const getLatestJobPhase = (record: JobRecord, phase: string): JobEvent | null =>
  [...record.events].reverse().find((event) => event.phase === phase) ?? null;

const isDownloadArtifactReady = (record: JobRecord): boolean =>
  record.status === "succeeded" || hasJobPhase(record, "artifact_delivery.ready");

const parseIsoTimestampMs = (value: unknown): number | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const getDownloadArtifactWindowExpiresAt = (record: JobRecord): number | null => {
  const readyEvent = getLatestJobPhase(record, "artifact_delivery.ready");
  if (!readyEvent) return null;

  const explicitExpiresAt = parseIsoTimestampMs(readyEvent.data?.artifact_expires_at);
  if (explicitExpiresAt !== null) return explicitExpiresAt;

  const readyAt = parseIsoTimestampMs(readyEvent.at);
  return readyAt === null ? null : readyAt + DOWNLOAD_ARTIFACT_LIVE_TIMEOUT_SECONDS * 1000;
};

const isArtifactDeliveryTimeout = (record: JobRecord): boolean =>
  record.debug?.failure_class === "artifact_delivery_timeout";

const artifactDownloadWindowExpiredResponse = () =>
  jsonResponse(
    {
      error: "ZIP download window expired. Start a new download export.",
    },
    410,
  );

const isArtifactTokenRequest = (route: { action: string }, url: URL): boolean =>
  route.action === "artifact" && Boolean(cleanString(url.searchParams.get("token")));

const pruneJobEvents = (events: JobEvent[]): JobEvent[] => {
  if (events.length <= MAX_EVENTS) return events;

  const maxProgressEvents = Math.floor(MAX_EVENTS / 2);
  const retainedProgressIndices = new Set(
    events
      .map((event, index) => (event.phase.endsWith(".progress") ? index : -1))
      .filter((index) => index >= 0)
      .slice(-maxProgressEvents),
  );

  const filtered = events.filter(
    (event, index) => !event.phase.endsWith(".progress") || retainedProgressIndices.has(index),
  );

  return filtered.length <= MAX_EVENTS ? filtered : filtered.slice(-MAX_EVENTS);
};

const pushEvent = (
  record: JobRecord,
  event: Omit<JobEvent, "at"> & { at?: string },
): JobRecord => ({
  ...record,
  events: pruneJobEvents([...record.events, { at: event.at ?? nowIso(), ...event }]),
});

const buildDefaultDebug = (overrides: Partial<JobDebug> = {}): JobDebug => ({
  task: null,
  source: null,
  target: null,
  source_project_url: null,
  target_project_url: null,
  storage_copy_concurrency: DEFAULT_STORAGE_COPY_CONCURRENCY,
  data_restore_mode: "replace",
  storage_copy_mode: "off",
  hard_timeout_seconds: null,
  pgsslmode: "require",
  container_start_invoked: false,
  monitor_raw_error: null,
  error_excerpt: null,
  monitor_exit_code: null,
  failure_class: null,
  failure_hint: null,
  ...overrides,
});

const defaultJobRecord = (): JobRecord => ({
  status: "idle",
  run_id: null,
  started_at: null,
  finished_at: null,
  error: null,
  events: [],
  debug: null,
});

const sanitizeCallbackLogText = (value: unknown): string | null =>
  typeof value === "string" && value.trim()
    ? sanitizeStoredLogText(value, CALLBACK_FAILURE_LOG_MAX_CHARS)
    : null;

const buildContainerCallbackFailureLog = (input: {
  jobId: string | null;
  runId: string;
  level: string;
  phase: string;
  message: string;
  status?: string;
  error?: string | null;
  data?: Record<string, unknown>;
  debugPatch?: Record<string, unknown>;
}): Record<string, unknown> | null => {
  if (input.level !== "error" && input.status !== "failed" && !input.error) {
    return null;
  }

  const debugPatch = input.debugPatch ?? {};
  const psqlDiagnostic =
    input.phase === "target_db_connection.failed"
      ? (debugPatch.psql_diagnostic ?? input.data?.psql_diagnostic ?? input.data?.error)
      : null;
  const payload: Record<string, unknown> = {
    job_id: input.jobId,
    run_id: input.runId,
    level: input.level,
    phase: input.phase,
    status: input.status ?? null,
    message: sanitizeCallbackLogText(input.message),
    error: sanitizeCallbackLogText(input.error),
    failure_class: sanitizeCallbackLogText(debugPatch.failure_class),
    failure_hint: sanitizeCallbackLogText(debugPatch.failure_hint),
    monitor_exit_code:
      typeof debugPatch.monitor_exit_code === "number" ? debugPatch.monitor_exit_code : null,
    error_excerpt: sanitizeCallbackLogText(debugPatch.error_excerpt),
    restore_error_excerpt: sanitizeCallbackLogText(debugPatch.restore_error_excerpt),
    psql_diagnostic: sanitizeCallbackLogText(psqlDiagnostic),
    monitor_raw_error: sanitizeCallbackLogText(debugPatch.monitor_raw_error),
  };

  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined || value === "") {
      delete payload[key];
    }
  }

  return payload;
};

const getBearerToken = (req: Request): string | null => {
  const raw = req.headers.get("Authorization");
  const match = raw?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
};

const isServiceToken = (token: string | null, expected: string | undefined): boolean =>
  Boolean(token && expected && token === expected);

const authenticateRequest = (req: Request, env: Env): AuthenticatedRequester | null => {
  const token = getBearerToken(req);
  if (!token) {
    return null;
  }

  if (isServiceToken(token, env.API_BEARER_TOKEN)) {
    return { kind: "service" };
  }

  return null;
};

// Jobs whose id ends with a runner marker run on a larger container instance
// type (see instance_type per class in wrangler.jsonc). Every request for a
// job carries the same id, so status polls and container callbacks route to
// the same class without extra plumbing. Falls back to the default class when
// the larger bindings are not deployed.
const resolveJobNamespace = (
  env: Env,
  jobId: string,
): DurableObjectNamespace<LovableExporterJob> => {
  if (jobId.endsWith("--rx")) {
    return env.LOVABLE_EXPORTER_JOB_XL ?? env.LOVABLE_EXPORTER_JOB;
  }
  if (jobId.endsWith("--rl")) {
    return env.LOVABLE_EXPORTER_JOB_LARGE ?? env.LOVABLE_EXPORTER_JOB;
  }
  return env.LOVABLE_EXPORTER_JOB;
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(req.url);
    const route = parseJobAction(url.pathname);
    if (!route) {
      return jsonResponse({ error: "Invalid exporter route." }, 404);
    }

    const allowsTokenBypass = isArtifactTokenRequest(route, url);
    const requester =
      route.action === "container-callback" || allowsTokenBypass
        ? null
        : await authenticateRequest(req, env);

    if (route.action !== "container-callback" && !requester && !allowsTokenBypass) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const namespace = resolveJobNamespace(env, route.jobId);
    const id = namespace.idFromName(route.jobId);
    const stub = namespace.get(id);
    const doUrl = `https://job${url.pathname}${url.search}`;
    const headers = new Headers({
      "Content-Type": req.headers.get("Content-Type") ?? "application/json",
      "x-job-id": route.jobId,
      "x-worker-origin": url.origin,
      "x-auth-kind": requester?.kind ?? "",
    });

    for (const [header, value] of [
      ["x-callback-token", req.headers.get("x-callback-token")],
      ["x-run-id", req.headers.get("x-run-id")],
    ] as const) {
      if (value) headers.set(header, value);
    }

    return stub.fetch(doUrl, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
    });
  },
};

export class LovableExporterJob {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  private getRequester(req: Request): AuthenticatedRequester | null {
    const kind = cleanString(req.headers.get("x-auth-kind"));
    if (kind === "service") {
      return { kind: "service" };
    }
    return null;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const action = parseJobAction(url.pathname)?.action;
    if (!action) {
      return jsonResponse({ error: "Not found." }, 404);
    }

    const allowsTokenBypass =
      action === "artifact" && Boolean(cleanString(url.searchParams.get("token")));
    const requester =
      action === "container-callback" || allowsTokenBypass ? null : this.getRequester(req);

    if (action !== "container-callback" && !requester && !allowsTokenBypass) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    if (action !== "container-callback") {
      await this.failExpiredRunIfNeeded();
    }

    if (action === "status") {
      const accessError = await this.ensureAccess(requester);
      if (accessError) return accessError;
      const status = await this.readStatus();
      return jsonResponse({
        ...status,
        summary: buildMigrationSummary(status),
      });
    }

    if (action === "summary") {
      const accessError = await this.ensureAccess(requester);
      if (accessError) return accessError;
      return jsonResponse(buildMigrationSummary(await this.readStatus()));
    }

    if (action === "artifact-access") {
      const accessError = await this.ensureAccess(requester);
      if (accessError) return accessError;
      return this.handleArtifactAccessRequest(req);
    }

    if (action === "artifact") {
      return this.handleArtifactDownload(req, requester);
    }

    if (action === "container-callback") {
      return this.handleContainerCallback(req);
    }

    if (action === "start-download") {
      return this.startDownload(req);
    }

    if (action === "start-storage") {
      return this.startStorage(req);
    }

    if (action === "test-target-admin-key") {
      return this.testTargetAdminKey(req);
    }

    if (action === "start-target-db-test") {
      return this.startTargetDbTest(req);
    }

    if (action === "start-source-inspect") {
      return this.startSourceInspect(req);
    }

    return this.startExport(req);
  }

  private async readStatus(): Promise<JobRecord> {
    return (await this.state.storage.get<JobRecord>("status")) ?? defaultJobRecord();
  }

  private async writeStatus(record: JobRecord): Promise<void> {
    await this.state.storage.put("status", record);
  }

  private async readSession(): Promise<StoredSession | null> {
    return (await this.state.storage.get<StoredSession>("session")) ?? null;
  }

  private async writeSession(session: StoredSession): Promise<void> {
    await this.state.storage.delete("cleanup_after");
    await this.state.storage.put("session", session);
  }

  private async readArtifactAccess(): Promise<StoredArtifactAccess | null> {
    return (await this.state.storage.get<StoredArtifactAccess>("artifact_access")) ?? null;
  }

  private async writeArtifactAccess(access: StoredArtifactAccess): Promise<void> {
    await this.state.storage.put("artifact_access", access);
  }

  private async clearArtifactAccess(): Promise<void> {
    await this.state.storage.delete("artifact_access");
  }

  private async readRunTimeout(): Promise<StoredRunTimeout | null> {
    return (await this.state.storage.get<StoredRunTimeout>("run_timeout")) ?? null;
  }

  private async clearRunTimeout(): Promise<void> {
    await this.state.storage.delete("run_timeout");
  }

  private async clearRunTimeoutForRun(runId: string): Promise<void> {
    const runTimeout = await this.readRunTimeout();
    if (runTimeout?.runId === runId) {
      await this.clearRunTimeout();
    }
  }

  private async clearSession(): Promise<void> {
    await this.state.storage.delete("session");
    await this.clearArtifactAccess();
  }

  private async clearSessionForRun(runId: string): Promise<void> {
    const session = await this.readSession();
    if (session?.runId === runId) {
      await this.clearSession();
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    const [cleanupAfter, runTimeout] = await Promise.all([
      this.state.storage.get<number>("cleanup_after"),
      this.readRunTimeout(),
    ]);
    const alarmTimes = [
      typeof cleanupAfter === "number" ? cleanupAfter : null,
      runTimeout?.expiresAt ?? null,
    ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));

    if (alarmTimes.length === 0) return;
    await this.state.storage.setAlarm(Math.max(Date.now(), Math.min(...alarmTimes)));
  }

  private async scheduleRunTimeout(runId: string, hardTimeoutSeconds: number): Promise<void> {
    await this.state.storage.put("run_timeout", {
      runId,
      hardTimeoutSeconds,
      expiresAt: Date.now() + hardTimeoutSeconds * 1000 + RUN_TIMEOUT_GRACE_MS,
    } satisfies StoredRunTimeout);
    await this.scheduleNextAlarm();
  }

  private async failExpiredRunIfNeeded(now = Date.now()): Promise<boolean> {
    const runTimeout = await this.readRunTimeout();
    if (!runTimeout) return false;
    if (runTimeout.expiresAt > now) return false;

    const current = await this.readStatus();
    if (current.run_id !== runTimeout.runId || current.status !== "running") {
      await this.clearRunTimeout();
      await this.scheduleNextAlarm();
      return false;
    }

    const hardTimeoutSeconds = current.debug?.hard_timeout_seconds ?? runTimeout.hardTimeoutSeconds;
    const message = "Export runtime timed out before reporting a final result.";
    const hint = "Start a new export. If it keeps happening, inspect exporter logs.";
    const diagnostic = `No terminal runtime callback before hard timeout (${hardTimeoutSeconds}s).`;
    const failed = pushEvent(
      {
        ...current,
        status: "failed",
        finished_at: nowIso(),
        error: message,
        debug: current.debug
          ? {
              ...current.debug,
              failure_class: "runtime_monitor_timeout",
              failure_hint: hint,
              monitor_raw_error: diagnostic,
              error_excerpt: diagnostic,
            }
          : current.debug,
      },
      {
        level: "error",
        phase: "monitor.timeout",
        message,
        data: {
          failure_class: "runtime_monitor_timeout",
          hard_timeout_seconds: hardTimeoutSeconds,
          timeout_grace_ms: RUN_TIMEOUT_GRACE_MS,
        },
      },
    );

    await this.writeStatus(failed);
    await this.clearRunTimeoutForRun(runTimeout.runId);
    await this.clearSessionForRun(runTimeout.runId);
    await this.scheduleCleanup();
    return true;
  }

  private async ensureAccess(requester: AuthenticatedRequester | null): Promise<Response | null> {
    if (!requester) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    return null;
  }

  private async scheduleCleanup(): Promise<void> {
    await this.state.storage.put("cleanup_after", Date.now() + CLEANUP_DELAY_MS);
    await this.scheduleNextAlarm();
  }

  private async startDownload(req: Request): Promise<Response> {
    if (!this.state.container) {
      return jsonResponse(
        {
          error: "Container binding unavailable. Check wrangler containers/durable_objects config.",
        },
        500,
      );
    }

    const current = await this.readStatus();
    if (current.status === "running") {
      return jsonResponse({ error: "Job already running.", status: current }, 409);
    }

    const jobId = cleanString(req.headers.get("x-job-id")) ?? "job";
    const origin = cleanString(req.headers.get("x-worker-origin")) ?? new URL(req.url).origin;
    const body = (await req.json().catch(() => ({}))) as StartDownloadBody;

    const sourceType = cleanSourceType(body.source_type);
    const sourceEdgeFunctionUrl = cleanHttpUrl(body.source_edge_function_url);
    const sourceEdgeFunctionAccessKey = cleanString(body.source_edge_function_access_key);
    const sourceDbUrl = cleanPostgresUrl(body.source_db_url);
    const sourceProjectUrl = cleanProjectUrl(body.source_project_url);

    if (!sourceType) {
      return jsonResponse(
        {
          error: "source_type must be either lovable_edge_function or postgres_url.",
        },
        400,
      );
    }

    if (
      sourceType === "postgres_url" &&
      (!sourceDbUrl || sourceEdgeFunctionUrl || sourceEdgeFunctionAccessKey)
    ) {
      return jsonResponse(
        {
          error:
            "Postgres URL source requires source_db_url and must not include source_edge_function_url or source_edge_function_access_key.",
        },
        400,
      );
    }

    if (
      sourceType === "lovable_edge_function" &&
      (!sourceEdgeFunctionUrl || !sourceEdgeFunctionAccessKey)
    ) {
      return jsonResponse(
        {
          error: "source_edge_function_url and source_edge_function_access_key are required.",
        },
        400,
      );
    }

    const runId = `run-${crypto.randomUUID()}`;
    const callbackToken = crypto.randomUUID().replaceAll("-", "");
    const storageCopyConcurrency = cleanStorageCopyConcurrency(
      body.storage_copy_concurrency ?? DEFAULT_DOWNLOAD_STORAGE_CONCURRENCY,
    );
    const hardTimeoutSeconds = cleanHardTimeout(body.hard_timeout_seconds);

    let next: JobRecord = {
      status: "running",
      run_id: runId,
      started_at: nowIso(),
      finished_at: null,
      error: null,
      events: [],
      debug: buildDefaultDebug({
        task: "download",
        source_project_url: sourceProjectUrl,
        target_project_url: null,
        storage_copy_mode: sourceType === "postgres_url" ? "off" : "full",
        storage_copy_concurrency: storageCopyConcurrency,
        hard_timeout_seconds: hardTimeoutSeconds,
      }),
    };

    next = pushEvent(next, {
      level: "info",
      phase: "download.started",
      message: "ZIP export started.",
      data: {
        storage_copy_concurrency: storageCopyConcurrency,
        storage_export_max_in_flight_bytes: DOWNLOAD_STORAGE_MAX_IN_FLIGHT_BYTES,
        hard_timeout_seconds: hardTimeoutSeconds,
        source_type: sourceType,
      },
    });

    await this.writeStatus(next);
    await this.writeSession({
      jobId,
      runId,
      callbackToken,
    });

    try {
      const env: Record<string, string> = {
        JOB_MODE: "download",
        JOB_ID: jobId,
        RUN_ID: runId,
        SOURCE_TYPE: sourceType,
        STORAGE_COPY_CONCURRENCY: String(storageCopyConcurrency),
        PROGRESS_CALLBACK_URL: `${origin}/jobs/${encodeURIComponent(jobId)}/container-callback`,
        PROGRESS_CALLBACK_TOKEN: callbackToken,
        ARTIFACT_OUTPUT_PATH: `/tmp/artifacts/${artifactFileName(jobId)}`,
        ARTIFACT_LIVE_PORT: String(DOWNLOAD_ARTIFACT_PORT),
        ARTIFACT_LIVE_TIMEOUT_SECONDS: String(DOWNLOAD_ARTIFACT_LIVE_TIMEOUT_SECONDS),
        STORAGE_EXPORT_MAX_IN_FLIGHT_BYTES: String(DOWNLOAD_STORAGE_MAX_IN_FLIGHT_BYTES),
        PGSSLMODE: "require",
      };

      if (sourceType === "postgres_url") {
        env.SOURCE_DB_URL = sourceDbUrl ?? "";
      } else {
        env.SOURCE_EDGE_FUNCTION_URL = sourceEdgeFunctionUrl ?? "";
        env.SOURCE_EDGE_FUNCTION_ACCESS_KEY = sourceEdgeFunctionAccessKey ?? "";
      }

      if (sourceProjectUrl) {
        env.SOURCE_PROJECT_URL = sourceProjectUrl;
      }
      const excludeDataTables = cleanStringArray(body.exclude_data_tables);
      if (excludeDataTables.length > 0) {
        env.EXCLUDE_DATA_TABLES = excludeDataTables.join(",");
      }
      addOptionalContainerEnv(env, this.env);

      this.state.container.start({
        enableInternet: true,
        env,
        hardTimeout: hardTimeoutSeconds * 1000,
      });

      const started = pushEvent(
        {
          ...next,
          debug: next.debug
            ? {
                ...next.debug,
                container_start_invoked: true,
              }
            : next.debug,
        },
        {
          level: "info",
          phase: "container.start_invoked",
          message: "Container start invoked.",
          data: {
            enable_internet: true,
            hard_timeout_ms: hardTimeoutSeconds * 1000,
          },
        },
      );
      await this.writeStatus(started);
      await this.scheduleRunTimeout(runId, hardTimeoutSeconds);
      this.state.waitUntil(this.monitorRun(runId));

      return jsonResponse(
        {
          ok: true,
          job_id: jobId,
          status: "running",
        },
        202,
      );
    } catch (error) {
      const raw = asErrorMessage(error);
      const classified = classifyContainerFailure(raw);
      const diagnostics = buildFailureDiagnostics(raw, {
        exitCode: classified.exitCode,
      });
      const failed = pushEvent(
        {
          ...next,
          status: "failed",
          finished_at: nowIso(),
          error: classified.message,
          debug: next.debug
            ? {
                ...next.debug,
                failure_class: classified.failureClass,
                failure_hint: classified.hint,
                ...diagnostics,
              }
            : next.debug,
        },
        {
          level: "error",
          phase: "container.start_failed",
          message: classified.message,
          data: {
            failure_class: classified.failureClass,
            monitor_exit_code: classified.exitCode,
          },
        },
      );
      await this.writeStatus(failed);
      await this.scheduleCleanup();
      return jsonResponse({ error: classified.message, status: failed }, 500);
    }
  }

  private async startStorage(req: Request): Promise<Response> {
    if (!this.state.container) {
      return jsonResponse(
        {
          error: "Container binding unavailable. Check wrangler containers/durable_objects config.",
        },
        500,
      );
    }

    const current = await this.readStatus();
    if (current.status === "running") {
      return jsonResponse({ error: "Job already running.", status: current }, 409);
    }

    const jobId = cleanString(req.headers.get("x-job-id")) ?? "job";
    const origin = cleanString(req.headers.get("x-worker-origin")) ?? new URL(req.url).origin;
    const body = (await req.json().catch(() => ({}))) as StartStorageBody;

    const sourceType = cleanSourceType(body.source_type);
    const sourceEdgeFunctionUrl = cleanHttpUrl(body.source_edge_function_url);
    const sourceEdgeFunctionAccessKey = cleanString(body.source_edge_function_access_key);
    const sourceDbUrl = cleanPostgresUrl(body.source_db_url);
    const sourceProjectUrl = cleanProjectUrl(body.source_project_url);
    const targetProjectUrl = cleanProjectUrl(body.target_project_url);
    const targetAdminKey = cleanString(body.target_admin_key);

    if (!sourceType) {
      return jsonResponse(
        {
          error: "source_type must be either lovable_edge_function or postgres_url.",
        },
        400,
      );
    }

    if (sourceType === "postgres_url" || sourceDbUrl) {
      return jsonResponse(
        {
          error:
            "Postgres URL sources do not have Supabase storage; start-storage is not supported.",
        },
        400,
      );
    }

    if (
      !sourceEdgeFunctionUrl ||
      !sourceEdgeFunctionAccessKey ||
      !targetProjectUrl ||
      !targetAdminKey
    ) {
      return jsonResponse(
        {
          error:
            "source_edge_function_url, source_edge_function_access_key, target_project_url, and target_admin_key are required.",
        },
        400,
      );
    }

    const runId = `run-${crypto.randomUUID()}`;
    const callbackToken = crypto.randomUUID().replaceAll("-", "");
    const storageCopyConcurrency = cleanStorageCopyConcurrency(body.storage_copy_concurrency);
    const hardTimeoutSeconds = cleanHardTimeout(body.hard_timeout_seconds);
    const skipExistingTargetObjects = cleanBooleanFlag(body.skip_existing_target_objects);
    const storageCopyMode = skipExistingTargetObjects ? "retry_skip_existing" : "full";

    let next: JobRecord = {
      status: "running",
      run_id: runId,
      started_at: nowIso(),
      finished_at: null,
      error: null,
      events: [],
      debug: buildDefaultDebug({
        task: "storage",
        source_project_url: sourceProjectUrl,
        target_project_url: targetProjectUrl,
        storage_copy_mode: storageCopyMode,
        storage_copy_concurrency: storageCopyConcurrency,
        hard_timeout_seconds: hardTimeoutSeconds,
      }),
    };

    next = pushEvent(next, {
      level: "info",
      phase: "storage_copy.started",
      message: "Storage copy started.",
      data: {
        storage_copy_concurrency: storageCopyConcurrency,
        hard_timeout_seconds: hardTimeoutSeconds,
        skip_existing_target_objects: skipExistingTargetObjects,
        storage_copy_mode: storageCopyMode,
      },
    });

    await this.writeStatus(next);
    await this.writeSession({
      jobId,
      runId,
      callbackToken,
    });

    try {
      const env: Record<string, string> = {
        JOB_MODE: "storage",
        JOB_ID: jobId,
        RUN_ID: runId,
        SOURCE_EDGE_FUNCTION_URL: sourceEdgeFunctionUrl,
        SOURCE_EDGE_FUNCTION_ACCESS_KEY: sourceEdgeFunctionAccessKey,
        TARGET_PROJECT_URL: targetProjectUrl,
        TARGET_ADMIN_KEY: targetAdminKey,
        STORAGE_COPY_CONCURRENCY: String(storageCopyConcurrency),
        PROGRESS_CALLBACK_URL: `${origin}/jobs/${encodeURIComponent(jobId)}/container-callback`,
        PROGRESS_CALLBACK_TOKEN: callbackToken,
        PGSSLMODE: "require",
      };

      if (sourceProjectUrl) {
        env.SOURCE_PROJECT_URL = sourceProjectUrl;
      }
      if (skipExistingTargetObjects) {
        env.SKIP_EXISTING_TARGET_OBJECTS = "1";
      }
      addOptionalContainerEnv(env, this.env);

      this.state.container.start({
        enableInternet: true,
        env,
        hardTimeout: hardTimeoutSeconds * 1000,
      });

      const started = pushEvent(
        {
          ...next,
          debug: next.debug
            ? {
                ...next.debug,
                container_start_invoked: true,
              }
            : next.debug,
        },
        {
          level: "info",
          phase: "container.start_invoked",
          message: "Container start invoked.",
          data: {
            enable_internet: true,
            hard_timeout_ms: hardTimeoutSeconds * 1000,
          },
        },
      );
      await this.writeStatus(started);
      await this.scheduleRunTimeout(runId, hardTimeoutSeconds);
      this.state.waitUntil(this.monitorRun(runId));

      return jsonResponse(
        {
          ok: true,
          job_id: jobId,
          status: "running",
        },
        202,
      );
    } catch (error) {
      const raw = asErrorMessage(error);
      const classified = classifyContainerFailure(raw);
      const diagnostics = buildFailureDiagnostics(raw, {
        exitCode: classified.exitCode,
      });
      const failed = pushEvent(
        {
          ...next,
          status: "failed",
          finished_at: nowIso(),
          error: classified.message,
          debug: next.debug
            ? {
                ...next.debug,
                failure_class: classified.failureClass,
                failure_hint: classified.hint,
                ...diagnostics,
              }
            : next.debug,
        },
        {
          level: "error",
          phase: "container.start_failed",
          message: classified.message,
          data: {
            failure_class: classified.failureClass,
            monitor_exit_code: classified.exitCode,
          },
        },
      );
      await this.writeStatus(failed);
      await this.scheduleCleanup();
      return jsonResponse({ error: classified.message, status: failed }, 500);
    }
  }

  private async testTargetAdminKey(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return jsonResponse({ error: "Use POST for this action." }, 405);
    }

    const body = (await req.json().catch(() => ({}))) as TestTargetAdminKeyBody;
    const targetProjectUrl = cleanProjectUrl(body.target_project_url);
    const targetAdminKey = cleanString(body.target_admin_key);

    if (!targetProjectUrl || !targetAdminKey) {
      return jsonResponse(
        {
          error: "Supabase project URL and secret API key are required.",
        },
        400,
      );
    }

    let response: Response;
    try {
      response = await fetch(`${targetProjectUrl}/auth/v1/admin/users?page=1&per_page=1`, {
        headers: {
          apikey: targetAdminKey,
          Authorization: `Bearer ${targetAdminKey}`,
        },
      });
    } catch {
      return jsonResponse(
        {
          error: "Could not reach Supabase. Check the project URL and try again.",
        },
        502,
      );
    }

    if (response.ok) {
      return jsonResponse({ ok: true });
    }

    if (response.status === 401 || response.status === 403) {
      return jsonResponse(
        {
          error:
            "Secret API key was rejected. Create a new secret key for this Supabase project and try again.",
        },
        400,
      );
    }

    if (response.status === 404) {
      return jsonResponse(
        {
          error:
            "Could not verify the secret API key for this Supabase project. Check the project URL and try again.",
        },
        400,
      );
    }

    return jsonResponse(
      {
        error: "Supabase could not verify the secret API key right now. Try again in a moment.",
      },
      502,
    );
  }

  private async startTargetDbTest(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return jsonResponse({ error: "Use POST for this action." }, 405);
    }

    if (!this.state.container) {
      return jsonResponse(
        {
          error: "Container binding unavailable. Check wrangler containers/durable_objects config.",
        },
        500,
      );
    }

    const current = await this.readStatus();
    if (current.status === "running") {
      return jsonResponse({ error: "Job already running.", status: current }, 409);
    }

    const jobId = cleanString(req.headers.get("x-job-id")) ?? "job";
    const origin = cleanString(req.headers.get("x-worker-origin")) ?? new URL(req.url).origin;
    const body = (await req.json().catch(() => ({}))) as StartTargetDbTestBody;
    const targetDbUrl = cleanPostgresUrl(body.target_db_url);

    if (!targetDbUrl) {
      return jsonResponse(
        {
          error: "target_db_url is required.",
        },
        400,
      );
    }

    const runId = `run-${crypto.randomUUID()}`;
    const callbackToken = crypto.randomUUID().replaceAll("-", "");
    const hardTimeoutSeconds = cleanHardTimeout(body.hard_timeout_seconds ?? 60);

    let next: JobRecord = {
      status: "running",
      run_id: runId,
      started_at: nowIso(),
      finished_at: null,
      error: null,
      events: [],
      debug: buildDefaultDebug({
        task: "db",
        storage_copy_mode: "off",
        hard_timeout_seconds: hardTimeoutSeconds,
      }),
    };

    next = pushEvent(next, {
      level: "info",
      phase: "target_db_connection.started",
      message: "Testing Supabase database connection.",
      data: {
        statement: "SELECT 1",
        hard_timeout_seconds: hardTimeoutSeconds,
      },
    });

    await this.writeStatus(next);
    await this.writeSession({
      jobId,
      runId,
      callbackToken,
    });

    try {
      const env: Record<string, string> = {
        JOB_MODE: "target-db-test",
        JOB_ID: jobId,
        RUN_ID: runId,
        TARGET_DB_URL: targetDbUrl,
        PROGRESS_CALLBACK_URL: `${origin}/jobs/${encodeURIComponent(jobId)}/container-callback`,
        PROGRESS_CALLBACK_TOKEN: callbackToken,
        PGSSLMODE: "require",
      };

      addOptionalContainerEnv(env, this.env);

      this.state.container.start({
        enableInternet: true,
        env,
        hardTimeout: hardTimeoutSeconds * 1000,
      });

      const started = pushEvent(
        {
          ...next,
          debug: next.debug
            ? {
                ...next.debug,
                container_start_invoked: true,
              }
            : next.debug,
        },
        {
          level: "info",
          phase: "container.start_invoked",
          message: "Container start invoked.",
          data: {
            enable_internet: true,
            hard_timeout_ms: hardTimeoutSeconds * 1000,
          },
        },
      );
      await this.writeStatus(started);
      await this.scheduleRunTimeout(runId, hardTimeoutSeconds);
      this.state.waitUntil(this.monitorRun(runId));

      return jsonResponse(
        {
          ok: true,
          job_id: jobId,
          status: "running",
        },
        202,
      );
    } catch (error) {
      const raw = asErrorMessage(error);
      const classified = classifyContainerFailure(raw);
      const diagnostics = buildFailureDiagnostics(raw, {
        exitCode: classified.exitCode,
      });
      const failed = pushEvent(
        {
          ...next,
          status: "failed",
          finished_at: nowIso(),
          error: classified.message,
          debug: next.debug
            ? {
                ...next.debug,
                failure_class: classified.failureClass,
                failure_hint: classified.hint,
                ...diagnostics,
              }
            : next.debug,
        },
        {
          level: "error",
          phase: "container.start_failed",
          message: classified.message,
          data: {
            failure_class: classified.failureClass,
            monitor_exit_code: classified.exitCode,
          },
        },
      );
      await this.writeStatus(failed);
      await this.scheduleCleanup();
      return jsonResponse({ error: classified.message, status: failed }, 500);
    }
  }

  private async startSourceInspect(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return jsonResponse({ error: "Use POST for this action." }, 405);
    }

    if (!this.state.container) {
      return jsonResponse(
        {
          error: "Container binding unavailable. Check wrangler containers/durable_objects config.",
        },
        500,
      );
    }

    const current = await this.readStatus();
    if (current.status === "running") {
      return jsonResponse({ error: "Job already running.", status: current }, 409);
    }

    const jobId = cleanString(req.headers.get("x-job-id")) ?? "job";
    const origin = cleanString(req.headers.get("x-worker-origin")) ?? new URL(req.url).origin;
    const body = (await req.json().catch(() => ({}))) as StartSourceInspectBody;

    const sourceEdgeFunctionUrl = cleanHttpUrl(body.source_edge_function_url);
    const sourceEdgeFunctionAccessKey = cleanString(body.source_edge_function_access_key);

    if (!sourceEdgeFunctionUrl || !sourceEdgeFunctionAccessKey) {
      return jsonResponse(
        {
          error: "source_edge_function_url and source_edge_function_access_key are required.",
        },
        400,
      );
    }

    const runId = `run-${crypto.randomUUID()}`;
    const callbackToken = crypto.randomUUID().replaceAll("-", "");
    const hardTimeoutSeconds = cleanHardTimeout(body.hard_timeout_seconds ?? 300);

    let next: JobRecord = {
      status: "running",
      run_id: runId,
      started_at: nowIso(),
      finished_at: null,
      error: null,
      events: [],
      debug: buildDefaultDebug({
        task: "db",
        storage_copy_mode: "off",
        hard_timeout_seconds: hardTimeoutSeconds,
      }),
    };

    next = pushEvent(next, {
      level: "info",
      phase: "source_inspect.started",
      message: "Measuring the Lovable Cloud project.",
      data: {
        hard_timeout_seconds: hardTimeoutSeconds,
      },
    });

    await this.writeStatus(next);
    await this.writeSession({
      jobId,
      runId,
      callbackToken,
    });

    try {
      const env: Record<string, string> = {
        JOB_MODE: "source-inspect",
        JOB_ID: jobId,
        RUN_ID: runId,
        SOURCE_EDGE_FUNCTION_URL: sourceEdgeFunctionUrl,
        SOURCE_EDGE_FUNCTION_ACCESS_KEY: sourceEdgeFunctionAccessKey,
        PROGRESS_CALLBACK_URL: `${origin}/jobs/${encodeURIComponent(jobId)}/container-callback`,
        PROGRESS_CALLBACK_TOKEN: callbackToken,
        PGSSLMODE: "require",
      };

      addOptionalContainerEnv(env, this.env);

      this.state.container.start({
        enableInternet: true,
        env,
        hardTimeout: hardTimeoutSeconds * 1000,
      });

      const started = pushEvent(
        {
          ...next,
          debug: next.debug
            ? {
                ...next.debug,
                container_start_invoked: true,
              }
            : next.debug,
        },
        {
          level: "info",
          phase: "container.start_invoked",
          message: "Container start invoked.",
          data: {
            enable_internet: true,
            hard_timeout_ms: hardTimeoutSeconds * 1000,
          },
        },
      );
      await this.writeStatus(started);
      await this.scheduleRunTimeout(runId, hardTimeoutSeconds);
      this.state.waitUntil(this.monitorRun(runId));

      return jsonResponse(
        {
          ok: true,
          job_id: jobId,
          status: "running",
        },
        202,
      );
    } catch (error) {
      const raw = asErrorMessage(error);
      const classified = classifyContainerFailure(raw);
      const diagnostics = buildFailureDiagnostics(raw, {
        exitCode: classified.exitCode,
      });
      const failed = pushEvent(
        {
          ...next,
          status: "failed",
          finished_at: nowIso(),
          error: classified.message,
          debug: next.debug
            ? {
                ...next.debug,
                failure_class: classified.failureClass,
                failure_hint: classified.hint,
                ...diagnostics,
              }
            : next.debug,
        },
        {
          level: "error",
          phase: "container.start_failed",
          message: classified.message,
          data: {
            failure_class: classified.failureClass,
            monitor_exit_code: classified.exitCode,
          },
        },
      );
      await this.writeStatus(failed);
      await this.scheduleCleanup();
      return jsonResponse({ error: classified.message, status: failed }, 500);
    }
  }

  private async startExport(req: Request): Promise<Response> {
    if (!this.state.container) {
      return jsonResponse(
        {
          error: "Container binding unavailable. Check wrangler containers/durable_objects config.",
        },
        500,
      );
    }

    const current = await this.readStatus();
    if (current.status === "running") {
      return jsonResponse({ error: "Job already running.", status: current }, 409);
    }

    const jobId = cleanString(req.headers.get("x-job-id")) ?? "job";
    const origin = cleanString(req.headers.get("x-worker-origin")) ?? new URL(req.url).origin;
    const body = (await req.json().catch(() => ({}))) as StartExportBody;

    const sourceType = cleanSourceType(body.source_type);
    const sourceEdgeFunctionUrl = cleanHttpUrl(body.source_edge_function_url);
    const sourceEdgeFunctionAccessKey = cleanString(body.source_edge_function_access_key);
    const sourceDbUrl = cleanPostgresUrl(body.source_db_url);
    const targetDbUrl = cleanPostgresUrl(body.target_db_url);
    const confirmTargetBlank = cleanBooleanFlag(body.confirm_target_blank);
    const sourceProjectUrl = cleanProjectUrl(body.source_project_url);
    const targetProjectUrl = cleanProjectUrl(body.target_project_url);
    const targetAdminKey = cleanString(body.target_admin_key);

    if (!sourceType) {
      return jsonResponse(
        {
          error: "source_type must be either lovable_edge_function or postgres_url.",
        },
        400,
      );
    }

    if (
      sourceType === "postgres_url" &&
      (!sourceDbUrl || sourceEdgeFunctionUrl || sourceEdgeFunctionAccessKey)
    ) {
      return jsonResponse(
        {
          error:
            "Postgres URL source requires source_db_url and must not include source_edge_function_url or source_edge_function_access_key.",
        },
        400,
      );
    }

    if (
      sourceType === "lovable_edge_function" &&
      (!sourceEdgeFunctionUrl || !sourceEdgeFunctionAccessKey || !targetDbUrl)
    ) {
      return jsonResponse(
        {
          error:
            "source_edge_function_url, source_edge_function_access_key, and target_db_url are required.",
        },
        400,
      );
    }

    if (sourceType === "postgres_url" && !targetDbUrl) {
      return jsonResponse(
        {
          error: "source_db_url and target_db_url are required.",
        },
        400,
      );
    }

    if (sourceType === "lovable_edge_function" && (!targetProjectUrl || !targetAdminKey)) {
      return jsonResponse(
        {
          error: "target_project_url and target_admin_key are required.",
        },
        400,
      );
    }

    if (!confirmTargetBlank) {
      return jsonResponse(
        {
          error: "confirm_target_blank=true is required before starting a combined export.",
        },
        400,
      );
    }

    const runId = `run-${crypto.randomUUID()}`;
    const callbackToken = crypto.randomUUID().replaceAll("-", "");
    const storageCopyConcurrency = cleanStorageCopyConcurrency(body.storage_copy_concurrency);
    const hardTimeoutSeconds = cleanHardTimeout(body.hard_timeout_seconds);

    let next: JobRecord = {
      status: "running",
      run_id: runId,
      started_at: nowIso(),
      finished_at: null,
      error: null,
      events: [],
      debug: buildDefaultDebug({
        task: "export",
        source_project_url: sourceProjectUrl,
        target_project_url: targetProjectUrl,
        storage_copy_mode: sourceType === "postgres_url" ? "off" : "full",
        storage_copy_concurrency: storageCopyConcurrency,
        hard_timeout_seconds: hardTimeoutSeconds,
      }),
    };

    next = pushEvent(next, {
      level: "info",
      phase: "export.started",
      message: "Combined DB + storage export started.",
      data: {
        storage_copy_concurrency: storageCopyConcurrency,
        hard_timeout_seconds: hardTimeoutSeconds,
        target_blank_required: true,
        source_type: sourceType,
      },
    });

    await this.writeStatus(next);
    await this.writeSession({
      jobId,
      runId,
      callbackToken,
    });

    try {
      const env: Record<string, string> = {
        JOB_MODE: "export",
        JOB_ID: jobId,
        RUN_ID: runId,
        SOURCE_TYPE: sourceType,
        TARGET_DB_URL: targetDbUrl ?? "",
        STORAGE_COPY_CONCURRENCY: String(storageCopyConcurrency),
        PROGRESS_CALLBACK_URL: `${origin}/jobs/${encodeURIComponent(jobId)}/container-callback`,
        PROGRESS_CALLBACK_TOKEN: callbackToken,
        PGSSLMODE: "require",
      };

      if (sourceType === "postgres_url") {
        env.SOURCE_DB_URL = sourceDbUrl ?? "";
      } else {
        env.SOURCE_EDGE_FUNCTION_URL = sourceEdgeFunctionUrl ?? "";
        env.SOURCE_EDGE_FUNCTION_ACCESS_KEY = sourceEdgeFunctionAccessKey ?? "";
        env.TARGET_PROJECT_URL = targetProjectUrl ?? "";
        env.TARGET_ADMIN_KEY = targetAdminKey ?? "";
      }

      if (sourceProjectUrl) {
        env.SOURCE_PROJECT_URL = sourceProjectUrl;
      }
      const excludeDataTables = cleanStringArray(body.exclude_data_tables);
      if (excludeDataTables.length > 0) {
        env.EXCLUDE_DATA_TABLES = excludeDataTables.join(",");
      }
      if (cleanBooleanFlag(body.enable_rls_on_restored_tables)) {
        env.ENABLE_RLS_ON_RESTORED_TABLES = "1";
      }
      addAuthUserMigrationEnv(env, body.auth_user_migration);
      if (body.verification !== undefined) {
        env.VERIFICATION = cleanBooleanFlag(body.verification) ? "1" : "0";
      }
      addOptionalContainerEnv(env, this.env);

      this.state.container.start({
        enableInternet: true,
        env,
        hardTimeout: hardTimeoutSeconds * 1000,
      });

      const started = pushEvent(
        {
          ...next,
          debug: next.debug
            ? {
                ...next.debug,
                container_start_invoked: true,
              }
            : next.debug,
        },
        {
          level: "info",
          phase: "container.start_invoked",
          message: "Container start invoked.",
          data: {
            enable_internet: true,
            hard_timeout_ms: hardTimeoutSeconds * 1000,
          },
        },
      );
      await this.writeStatus(started);
      await this.scheduleRunTimeout(runId, hardTimeoutSeconds);
      this.state.waitUntil(this.monitorRun(runId));

      return jsonResponse(
        {
          ok: true,
          job_id: jobId,
          status: "running",
        },
        202,
      );
    } catch (error) {
      const raw = asErrorMessage(error);
      const classified = classifyContainerFailure(raw);
      const diagnostics = buildFailureDiagnostics(raw, {
        exitCode: classified.exitCode,
      });
      const failed = pushEvent(
        {
          ...next,
          status: "failed",
          finished_at: nowIso(),
          error: classified.message,
          debug: next.debug
            ? {
                ...next.debug,
                failure_class: classified.failureClass,
                failure_hint: classified.hint,
                ...diagnostics,
              }
            : next.debug,
        },
        {
          level: "error",
          phase: "container.start_failed",
          message: classified.message,
          data: {
            failure_class: classified.failureClass,
            monitor_exit_code: classified.exitCode,
          },
        },
      );
      await this.writeStatus(failed);
      await this.scheduleCleanup();
      return jsonResponse({ error: classified.message, status: failed }, 500);
    }
  }

  private async handleContainerCallback(req: Request): Promise<Response> {
    const session = await this.readSession();
    if (!session) {
      return jsonResponse({ error: "Callback session not found." }, 409);
    }

    const rawBody = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const body = normalizeContainerCallbackBody(rawBody);
    const callbackToken = cleanString(body?.callback_token);
    const runId = cleanString(body?.run_id);
    const level = cleanString(body?.level);
    const phase = cleanString(body?.phase);
    const message = cleanString(body?.message);
    const data = isRecord(body?.data) ? body?.data : undefined;
    const debugPatch = isRecord(body?.debug_patch) ? body?.debug_patch : undefined;
    const status = body?.status;
    const error = body?.error;
    const finishedAt = body?.finished_at === null ? null : cleanString(body?.finished_at);

    if (
      callbackToken !== session.callbackToken ||
      runId !== session.runId ||
      !level ||
      !phase ||
      !message
    ) {
      return jsonResponse({ error: "Invalid callback payload." }, 400);
    }

    const current = await this.readStatus();
    if (current.run_id !== session.runId) {
      return jsonResponse({ error: "Callback run does not match active job." }, 409);
    }

    const failureLog = buildContainerCallbackFailureLog({
      jobId: cleanString(req.headers.get("x-job-id")) ?? session.jobId,
      runId,
      level,
      phase,
      message,
      status,
      error,
      data,
      debugPatch,
    });
    if (failureLog) {
      console.error(
        JSON.stringify({
          event: "exporter.container_callback.failure",
          ...failureLog,
        }),
      );
    }

    const next = pushEvent(
      {
        ...current,
        status: status ?? current.status,
        finished_at:
          status === "succeeded" || status === "failed"
            ? (finishedAt ?? nowIso())
            : current.finished_at,
        error: error !== undefined ? error : current.error,
        debug:
          current.debug && debugPatch
            ? {
                ...current.debug,
                ...debugPatch,
              }
            : current.debug,
      },
      {
        level: level as "info" | "warn" | "error",
        phase,
        message: sanitizeLogText(message),
        data,
      },
    );

    await this.writeStatus(next);
    return jsonResponse({ ok: true }, 202);
  }

  private async handleArtifactAccessRequest(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return jsonResponse({ error: "Use POST for this route." }, 405);
    }

    const current = await this.readStatus();
    if (current.debug?.task !== "download") {
      return jsonResponse({ error: "ZIP artifact not found for this job." }, 404);
    }

    if (isArtifactDeliveryTimeout(current)) {
      return artifactDownloadWindowExpiredResponse();
    }

    if (!isDownloadArtifactReady(current)) {
      return jsonResponse({ error: "ZIP export is still preparing." }, 409);
    }

    const artifactWindowExpiresAt = getDownloadArtifactWindowExpiresAt(current);
    if (artifactWindowExpiresAt !== null && artifactWindowExpiresAt <= Date.now()) {
      return artifactDownloadWindowExpiredResponse();
    }

    if (current.status === "failed") {
      return jsonResponse({ error: current.error ?? "ZIP export failed." }, 409);
    }

    const session = await this.readSession();
    if (!session || session.runId !== current.run_id) {
      return jsonResponse(
        {
          error: "ZIP artifact is no longer available. Start a new download export.",
        },
        410,
      );
    }

    const origin = cleanString(req.headers.get("x-worker-origin")) ?? new URL(req.url).origin;
    const jobId = cleanString(req.headers.get("x-job-id")) ?? session.jobId;
    const buildDownloadUrl = (token: string) =>
      `${origin}/jobs/${encodeURIComponent(jobId)}/artifact?token=${encodeURIComponent(token)}`;

    const existingAccess = await this.readArtifactAccess();
    if (existingAccess) {
      const existingExpiresAt =
        artifactWindowExpiresAt === null
          ? existingAccess.expiresAt
          : Math.min(existingAccess.expiresAt, artifactWindowExpiresAt);
      if (existingAccess.runId === session.runId && existingExpiresAt > Date.now()) {
        return jsonResponse(
          {
            download_url: buildDownloadUrl(existingAccess.token),
            expires_at: new Date(existingExpiresAt).toISOString(),
          },
          200,
        );
      }
      await this.clearArtifactAccess();
    }

    const token = crypto.randomUUID().replaceAll("-", "");
    const tokenExpiresAt = Date.now() + ARTIFACT_ACCESS_TOKEN_TTL_MS;
    const expiresAt =
      artifactWindowExpiresAt === null
        ? tokenExpiresAt
        : Math.min(tokenExpiresAt, artifactWindowExpiresAt);
    await this.writeArtifactAccess({
      token,
      runId: session.runId,
      expiresAt,
    });

    return jsonResponse(
      {
        download_url: buildDownloadUrl(token),
        expires_at: new Date(expiresAt).toISOString(),
      },
      200,
    );
  }

  private async validateArtifactToken(
    req: Request,
    current: JobRecord,
    session: StoredSession,
  ): Promise<{ token: string } | Response> {
    const token = cleanString(new URL(req.url).searchParams.get("token"));
    if (!token) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const access = await this.readArtifactAccess();
    if (!access) {
      return jsonResponse({ error: "Artifact access token is invalid or expired." }, 410);
    }

    if (access.runId !== session.runId || current.run_id !== session.runId) {
      await this.clearArtifactAccess();
      return jsonResponse({ error: "Artifact access token is no longer valid for this run." }, 410);
    }

    if (access.token !== token) {
      return jsonResponse({ error: "Artifact access token is invalid." }, 401);
    }

    if (access.expiresAt <= Date.now()) {
      await this.clearArtifactAccess();
      return jsonResponse(
        {
          error: "Artifact access token expired. Request a new download link.",
        },
        410,
      );
    }

    return { token };
  }

  private async handleArtifactDownload(
    req: Request,
    requester: AuthenticatedRequester | null,
  ): Promise<Response> {
    const current = await this.readStatus();
    if (current.debug?.task !== "download") {
      return jsonResponse({ error: "ZIP artifact not found for this job." }, 404);
    }

    if (isArtifactDeliveryTimeout(current)) {
      return artifactDownloadWindowExpiredResponse();
    }

    if (current.status === "failed") {
      return jsonResponse({ error: current.error ?? "ZIP export failed." }, 409);
    }

    if (requester) {
      const accessError = await this.ensureAccess(requester);
      if (accessError) return accessError;
    }

    if (!isDownloadArtifactReady(current)) {
      return jsonResponse({ error: "ZIP export is still preparing." }, 409);
    }

    const artifactWindowExpiresAt = getDownloadArtifactWindowExpiresAt(current);
    if (artifactWindowExpiresAt !== null && artifactWindowExpiresAt <= Date.now()) {
      return artifactDownloadWindowExpiredResponse();
    }

    const session = await this.readSession();
    if (!session || session.runId !== current.run_id) {
      return jsonResponse(
        {
          error: "ZIP artifact is no longer available. Start a new download export.",
        },
        410,
      );
    }

    let artifactToken: string | null = null;
    if (!requester) {
      const tokenValidation = await this.validateArtifactToken(req, current, session);
      if (tokenValidation instanceof Response) return tokenValidation;
      artifactToken = tokenValidation.token;
    }

    const container = this.state.container;
    if (!container) {
      return jsonResponse(
        {
          error: "ZIP artifact runtime is unavailable. Start a new download export.",
        },
        410,
      );
    }

    let upstream: Response | null = null;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= ARTIFACT_UPSTREAM_RETRY_ATTEMPTS; attempt += 1) {
      try {
        upstream = await container
          .getTcpPort(DOWNLOAD_ARTIFACT_PORT)
          .fetch("http://container/artifact", {
            method: "GET",
          });
        if (upstream.ok) {
          break;
        }

        const message = cleanString(await upstream.text().catch(() => ""));
        if (
          attempt === ARTIFACT_UPSTREAM_RETRY_ATTEMPTS ||
          (upstream.status !== 404 && upstream.status !== 503)
        ) {
          return jsonResponse(
            { error: message ?? "ZIP artifact is unavailable." },
            upstream.status,
          );
        }
        lastError = new Error(message ?? `Container artifact fetch failed with ${upstream.status}`);
      } catch (error) {
        lastError = error;
      }

      await sleep(ARTIFACT_UPSTREAM_RETRY_DELAY_MS);
    }

    if (!upstream?.ok || !upstream.body) {
      return jsonResponse(
        {
          error:
            cleanString(lastError instanceof Error ? lastError.message : null) ??
            "Could not connect to the live ZIP artifact stream.",
        },
        502,
      );
    }

    if (artifactToken) {
      const access = await this.readArtifactAccess();
      if (!access || access.token !== artifactToken || access.runId !== session.runId) {
        return jsonResponse(
          {
            error: "Artifact access token is no longer valid.",
          },
          410,
        );
      }
      await this.clearArtifactAccess();
    }

    const headers = new Headers(corsHeaders);
    headers.set("Cache-Control", "no-store");
    headers.set(
      "Content-Disposition",
      upstream.headers.get("Content-Disposition") ??
        `attachment; filename="${artifactFileName(session.jobId)}"`,
    );
    headers.set("Content-Type", upstream.headers.get("Content-Type") ?? "application/zip");
    const contentLength = cleanString(upstream.headers.get("Content-Length"));
    if (contentLength) {
      headers.set("Content-Length", contentLength);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  }

  private async monitorRun(runId: string): Promise<void> {
    if (!this.state.container) return;

    try {
      await this.state.container.monitor();
      const current = await this.readStatus();
      if (current.run_id !== runId) return;

      if (current.status === "running") {
        const successPhase =
          current.debug?.task === "download"
            ? "download.succeeded"
            : current.debug?.task === "storage"
              ? "storage_copy.succeeded"
              : current.debug?.task === "db"
                ? "target_db_connection.succeeded"
                : "export.succeeded";
        await this.writeStatus(
          pushEvent(
            {
              ...current,
              status: "succeeded",
              finished_at: nowIso(),
              error: null,
            },
            {
              level: "info",
              phase: successPhase,
              message: "Container finished successfully.",
            },
          ),
        );
      }
    } catch (error) {
      const raw = asErrorMessage(error);
      const classified = classifyContainerFailure(raw);
      const diagnostics = buildFailureDiagnostics(raw, {
        exitCode: classified.exitCode,
      });
      const current = await this.readStatus();
      if (current.run_id !== runId) return;

      if (current.status === "running") {
        await this.writeStatus(
          pushEvent(
            {
              ...current,
              status: "failed",
              finished_at: nowIso(),
              error: classified.message,
              debug: current.debug
                ? {
                    ...current.debug,
                    failure_class: classified.failureClass,
                    failure_hint: classified.hint,
                    ...diagnostics,
                  }
                : current.debug,
            },
            {
              level: "error",
              phase: "monitor.failed",
              message: classified.message,
              data: {
                failure_class: classified.failureClass,
                monitor_exit_code: classified.exitCode,
              },
            },
          ),
        );
      }
    } finally {
      try {
        await this.state.container?.destroy?.();
      } catch {
        // Best effort.
      }
      await this.clearRunTimeoutForRun(runId);
      await this.clearSessionForRun(runId);
      await this.scheduleCleanup();
    }
  }

  async alarm(): Promise<void> {
    const cleanupAfter = await this.state.storage.get<number>("cleanup_after");
    if (typeof cleanupAfter === "number" && cleanupAfter <= Date.now()) {
      await this.state.storage.deleteAll();
      return;
    }

    await this.failExpiredRunIfNeeded();
    await this.scheduleNextAlarm();
  }
}

// Same behavior as LovableExporterJob; separate classes exist only so each
// can bind a different container instance_type in wrangler.jsonc.
export class LovableExporterJobLarge extends LovableExporterJob {}
export class LovableExporterJobXl extends LovableExporterJob {}
