import {
  buildMigrationSummary,
  classifyContainerFailure,
  sanitizeLogText,
  sanitizeLogValue,
  sanitizeStoredLogText,
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
  API_BEARER_TOKEN?: string;
  LOG_VERBOSITY?: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};

type StartExportBody = {
  source_edge_function_url?: unknown;
  source_edge_function_access_key?: unknown;
  target_db_url?: unknown;
  confirm_target_blank?: unknown;
  source_project_url?: unknown;
  target_project_url?: unknown;
  target_admin_key?: unknown;
  storage_copy_concurrency?: unknown;
  hard_timeout_seconds?: unknown;
};

type StartDownloadBody = {
  source_edge_function_url?: unknown;
  source_edge_function_access_key?: unknown;
  source_project_url?: unknown;
  storage_copy_concurrency?: unknown;
  hard_timeout_seconds?: unknown;
};

type SendMagicLinkBody = {
  email?: unknown;
  redirect_url?: unknown;
  captcha_token?: unknown;
};

type ContainerCallbackBody = {
  callback_token?: unknown;
  run_id?: unknown;
  level?: unknown;
  phase?: unknown;
  message?: unknown;
  data?: unknown;
  status?: unknown;
  error?: unknown;
  finished_at?: unknown;
  debug_patch?: unknown;
};

type StoredSession = {
  jobId: string;
  runId: string;
  callbackToken: string;
};

type StoredOwner =
  | {
      kind: "service";
    }
  | {
      kind: "user";
      userId: string;
      email: string | null;
    };

type AuthenticatedRequester =
  | {
      kind: "service";
    }
  | {
      kind: "user";
      userId: string;
      email: string | null;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const artifactFileName = (jobId: string) => `lovable-cloud-export-${jobId}.zip`;

const asErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Unexpected error";

const sanitizeDebugPatch = (
  debugPatch: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!debugPatch) return undefined;

  const sanitized = sanitizeLogValue(debugPatch) as Record<string, unknown>;
  if (typeof sanitized.monitor_raw_error === "string") {
    sanitized.monitor_raw_error = sanitizeStoredLogText(sanitized.monitor_raw_error);
  }
  return sanitized;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const isLikelyEmail = (value: string | null): value is string =>
  Boolean(value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));

const parseJsonBody = async (req: Request): Promise<Record<string, unknown> | null> => {
  const payload = await req.json().catch(() => null);
  return isRecord(payload) ? payload : null;
};

const getSupabaseAuthErrorMessage = (payload: Record<string, unknown> | null, status: number) =>
  cleanString(payload?.msg) ||
  cleanString(payload?.error_description) ||
  cleanString(payload?.message) ||
  cleanString(payload?.error) ||
  `Supabase auth request failed (${status}).`;

const isExistingUserError = (message: string) =>
  /already (?:been )?registered|already exists|user already/i.test(message);

const ensureExistingAuthUser = async ({
  supabaseUrl,
  serviceRoleKey,
  email,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  email: string;
}) => {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({
      email,
      email_confirm: true,
      password: `${crypto.randomUUID()}${crypto.randomUUID()}`,
    }),
  });

  if (response.ok) {
    return;
  }

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const message = getSupabaseAuthErrorMessage(payload, response.status);
  if (isExistingUserError(message)) {
    return;
  }

  throw new Error(message);
};

const sendMagicLinkEmail = async ({
  supabaseUrl,
  anonKey,
  serviceRoleKey,
  email,
  redirectUrl,
  captchaToken,
}: {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  email: string;
  redirectUrl: string;
  captchaToken: string | null;
}) => {
  const query = new URLSearchParams({ redirect_to: redirectUrl }).toString();
  const useCaptchaFlow = Boolean(captchaToken);
  const response = await fetch(`${supabaseUrl}/auth/v1/otp?${query}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      apikey: useCaptchaFlow ? anonKey : serviceRoleKey,
      ...(useCaptchaFlow
        ? {}
        : {
            Authorization: `Bearer ${serviceRoleKey}`,
          }),
    },
    body: JSON.stringify(
      useCaptchaFlow
        ? {
            email,
            data: {},
            create_user: false,
            gotrue_meta_security: {
              captcha_token: captchaToken,
            },
          }
        : {
            email,
            data: {},
            create_user: false,
          },
    ),
  });

  if (response.ok) {
    return;
  }

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  throw new Error(getSupabaseAuthErrorMessage(payload, response.status));
};

const handleSendMagicLink = async (req: Request, env: Env): Promise<Response> => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Use POST for this route." }, 405);
  }

  const body = (await parseJsonBody(req)) as SendMagicLinkBody | null;
  const email = cleanString(body?.email)?.toLowerCase() ?? null;
  const redirectUrl = cleanHttpUrl(body?.redirect_url);
  const captchaToken = cleanString(body?.captcha_token);

  if (!isLikelyEmail(email)) {
    return jsonResponse({ error: "Enter a valid email address." }, 400);
  }

  if (!redirectUrl) {
    return jsonResponse({ error: "A valid redirect URL is required." }, 400);
  }

  const supabaseUrl = cleanHttpUrl(env.SUPABASE_URL);
  const anonKey = cleanString(env.SUPABASE_ANON_KEY);
  const serviceRoleKey = cleanString(env.SUPABASE_SERVICE_ROLE_KEY);

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse(
      {
        error:
          "Auth is not fully configured. Set SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY on the exporter API.",
      },
      503,
    );
  }

  try {
    await ensureExistingAuthUser({
      supabaseUrl,
      serviceRoleKey,
      email,
    });
    await sendMagicLinkEmail({
      supabaseUrl,
      anonKey,
      serviceRoleKey,
      email,
      redirectUrl,
      captchaToken,
    });
    return jsonResponse({ ok: true });
  } catch (error) {
    return jsonResponse({ error: asErrorMessage(error) }, 400);
  }
};

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

const getBearerToken = (req: Request): string | null => {
  const raw = req.headers.get("Authorization");
  const match = raw?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
};

const isServiceToken = (token: string | null, expected: string | undefined): boolean =>
  Boolean(token && expected && token === expected);

const verifySupabaseAccessToken = async (
  token: string,
  env: Env,
): Promise<AuthenticatedRequester | null> => {
  const supabaseUrl = cleanHttpUrl(env.SUPABASE_URL);
  const anonKey = cleanString(env.SUPABASE_ANON_KEY);
  if (!supabaseUrl || !anonKey) {
    return null;
  }

  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: anonKey,
    },
  }).catch(() => null);

  if (!response?.ok) {
    return null;
  }

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const userId = cleanString(payload?.id);
  if (!userId) {
    return null;
  }

  return {
    kind: "user",
    userId,
    email: cleanString(payload?.email),
  };
};

const authenticateRequest = async (
  req: Request,
  env: Env,
): Promise<AuthenticatedRequester | null> => {
  const token = getBearerToken(req);
  if (!token) {
    return null;
  }

  if (isServiceToken(token, env.API_BEARER_TOKEN)) {
    return { kind: "service" };
  }

  return verifySupabaseAccessToken(token, env);
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(req.url);
    if (url.pathname === "/auth/send-magic-link") {
      return handleSendMagicLink(req, env);
    }
    const route = parseJobAction(url.pathname);
    if (!route) {
      return jsonResponse({ error: "Invalid exporter route." }, 404);
    }

    const requester =
      route.action === "container-callback" ? null : await authenticateRequest(req, env);

    if (route.action !== "container-callback" && !requester) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const id = env.LOVABLE_EXPORTER_JOB.idFromName(route.jobId);
    const stub = env.LOVABLE_EXPORTER_JOB.get(id);
    const doUrl = `https://job${url.pathname}`;
    const headers = new Headers({
      "Content-Type": req.headers.get("Content-Type") ?? "application/json",
      "x-job-id": route.jobId,
      "x-worker-origin": url.origin,
      "x-auth-kind": requester?.kind ?? "",
      "x-auth-user-id": requester?.kind === "user" ? requester.userId : "",
      "x-auth-user-email": requester?.kind === "user" ? (requester.email ?? "") : "",
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
    if (kind === "user") {
      const userId = cleanString(req.headers.get("x-auth-user-id"));
      if (!userId) return null;
      return {
        kind: "user",
        userId,
        email: cleanString(req.headers.get("x-auth-user-email")),
      };
    }
    return null;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const action = parseJobAction(url.pathname)?.action;
    if (!action) {
      return jsonResponse({ error: "Not found." }, 404);
    }

    const requester = action === "container-callback" ? null : this.getRequester(req);

    if (action !== "container-callback" && !requester) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    if (action === "status") {
      const ownershipError = await this.ensureAccess(requester);
      if (ownershipError) return ownershipError;
      const status = await this.readStatus();
      return jsonResponse({ ...status, summary: buildMigrationSummary(status) });
    }

    if (action === "summary") {
      const ownershipError = await this.ensureAccess(requester);
      if (ownershipError) return ownershipError;
      return jsonResponse(buildMigrationSummary(await this.readStatus()));
    }

    if (action === "artifact") {
      const ownershipError = await this.ensureAccess(requester);
      if (ownershipError) return ownershipError;
      return this.handleArtifactDownload();
    }

    if (action === "container-callback") {
      return this.handleContainerCallback(req);
    }

    if (action === "start-download") {
      return this.startDownload(req, requester);
    }

    return this.startExport(req, requester);
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
    await this.state.storage.put("session", session);
  }

  private async readOwner(): Promise<StoredOwner | null> {
    return (await this.state.storage.get<StoredOwner>("owner")) ?? null;
  }

  private async writeOwner(owner: StoredOwner): Promise<void> {
    await this.state.storage.put("owner", owner);
  }

  private async clearSession(): Promise<void> {
    await this.state.storage.delete("session");
  }

  private async ensureAccess(requester: AuthenticatedRequester | null): Promise<Response | null> {
    if (!requester) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    if (requester.kind === "service") {
      return null;
    }

    const owner = await this.readOwner();
    if (!owner || owner.kind !== "user" || owner.userId !== requester.userId) {
      return jsonResponse({ error: "Not found." }, 404);
    }

    return null;
  }

  private async scheduleCleanup(): Promise<void> {
    await this.state.storage.put("cleanup_after", Date.now() + 24 * 60 * 60 * 1000);
    await this.state.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
  }

  private async startDownload(
    req: Request,
    requester: AuthenticatedRequester | null,
  ): Promise<Response> {
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

    const sourceEdgeFunctionUrl = cleanHttpUrl(body.source_edge_function_url);
    const sourceEdgeFunctionAccessKey = cleanString(body.source_edge_function_access_key);
    const sourceProjectUrl = cleanProjectUrl(body.source_project_url);

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
        task: "download",
        source_project_url: sourceProjectUrl,
        target_project_url: null,
        storage_copy_mode: "full",
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
        hard_timeout_seconds: hardTimeoutSeconds,
      },
    });

    await this.writeStatus(next);
    await this.writeSession({
      jobId,
      runId,
      callbackToken,
    });
    if (requester) {
      await this.writeOwner(
        requester.kind === "service"
          ? { kind: "service" }
          : {
              kind: "user",
              userId: requester.userId,
              email: requester.email,
            },
      );
    }

    try {
      const env: Record<string, string> = {
        JOB_MODE: "download",
        JOB_ID: jobId,
        RUN_ID: runId,
        SOURCE_EDGE_FUNCTION_URL: sourceEdgeFunctionUrl,
        SOURCE_EDGE_FUNCTION_ACCESS_KEY: sourceEdgeFunctionAccessKey,
        STORAGE_COPY_CONCURRENCY: String(storageCopyConcurrency),
        PROGRESS_CALLBACK_URL: `${origin}/jobs/${encodeURIComponent(jobId)}/container-callback`,
        PROGRESS_CALLBACK_TOKEN: callbackToken,
        ARTIFACT_OUTPUT_PATH: `/tmp/artifacts/${artifactFileName(jobId)}`,
        ARTIFACT_LIVE_PORT: String(DOWNLOAD_ARTIFACT_PORT),
        ARTIFACT_LIVE_TIMEOUT_SECONDS: String(DOWNLOAD_ARTIFACT_LIVE_TIMEOUT_SECONDS),
        PGSSLMODE: "require",
      };

      if (sourceProjectUrl) {
        env.SOURCE_PROJECT_URL = sourceProjectUrl;
      }
      const logVerbosity = cleanString(this.env.LOG_VERBOSITY);
      if (logVerbosity) {
        env.LOG_VERBOSITY = logVerbosity;
      }

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
      const sanitizedRaw = sanitizeStoredLogText(raw);
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
                monitor_raw_error: sanitizedRaw,
                monitor_exit_code: classified.exitCode,
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

  private async startExport(
    req: Request,
    requester: AuthenticatedRequester | null,
  ): Promise<Response> {
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

    const sourceEdgeFunctionUrl = cleanHttpUrl(body.source_edge_function_url);
    const sourceEdgeFunctionAccessKey = cleanString(body.source_edge_function_access_key);
    const targetDbUrl = cleanPostgresUrl(body.target_db_url);
    const confirmTargetBlank = cleanBooleanFlag(body.confirm_target_blank);
    const sourceProjectUrl = cleanProjectUrl(body.source_project_url);
    const targetProjectUrl = cleanProjectUrl(body.target_project_url);
    const targetAdminKey = cleanString(body.target_admin_key);

    if (!sourceEdgeFunctionUrl || !sourceEdgeFunctionAccessKey || !targetDbUrl) {
      return jsonResponse(
        {
          error:
            "source_edge_function_url, source_edge_function_access_key, and target_db_url are required.",
        },
        400,
      );
    }

    if (!targetProjectUrl || !targetAdminKey) {
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
        storage_copy_mode: "full",
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
      },
    });

    await this.writeStatus(next);
    await this.writeSession({
      jobId,
      runId,
      callbackToken,
    });
    if (requester) {
      await this.writeOwner(
        requester.kind === "service"
          ? { kind: "service" }
          : {
              kind: "user",
              userId: requester.userId,
              email: requester.email,
            },
      );
    }

    try {
      const env: Record<string, string> = {
        JOB_MODE: "export",
        JOB_ID: jobId,
        RUN_ID: runId,
        SOURCE_EDGE_FUNCTION_URL: sourceEdgeFunctionUrl,
        SOURCE_EDGE_FUNCTION_ACCESS_KEY: sourceEdgeFunctionAccessKey,
        TARGET_DB_URL: targetDbUrl,
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
      const logVerbosity = cleanString(this.env.LOG_VERBOSITY);
      if (logVerbosity) {
        env.LOG_VERBOSITY = logVerbosity;
      }

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
      const sanitizedRaw = sanitizeStoredLogText(raw);
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
                monitor_raw_error: sanitizedRaw,
                monitor_exit_code: classified.exitCode,
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

    const body = (await req.json().catch(() => ({}))) as ContainerCallbackBody;
    const callbackToken = cleanString(body.callback_token);
    const runId = cleanString(body.run_id);
    const level = cleanString(body.level);
    const phase = cleanString(body.phase);
    const message = cleanString(body.message);
    const data = isRecord(body.data)
      ? (sanitizeLogValue(body.data) as Record<string, unknown>)
      : undefined;
    const debugPatch = isRecord(body.debug_patch)
      ? sanitizeDebugPatch(body.debug_patch)
      : undefined;
    const status =
      body.status === "running" || body.status === "succeeded" || body.status === "failed"
        ? body.status
        : undefined;
    const error =
      body.error === null
        ? null
        : typeof body.error === "string"
          ? sanitizeLogText(body.error)
          : undefined;
    const finishedAt = body.finished_at === null ? null : cleanString(body.finished_at);

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

  private async handleArtifactDownload(): Promise<Response> {
    const current = await this.readStatus();
    if (current.debug?.task !== "download") {
      return jsonResponse({ error: "ZIP artifact not found for this job." }, 404);
    }

    if (current.status === "failed") {
      return jsonResponse({ error: current.error ?? "ZIP export failed." }, 409);
    }

    if (current.status !== "succeeded") {
      return jsonResponse({ error: "ZIP export is still running." }, 409);
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
    for (let attempt = 1; attempt <= 8; attempt += 1) {
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
        if (attempt === 8 || (upstream.status !== 404 && upstream.status !== 503)) {
          return jsonResponse(
            { error: message ?? "ZIP artifact is unavailable." },
            upstream.status,
          );
        }
        lastError = new Error(message ?? `Container artifact fetch failed with ${upstream.status}`);
      } catch (error) {
        lastError = error;
      }

      await sleep(250);
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
          current.debug?.task === "download" ? "download.succeeded" : "export.succeeded";
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
      const sanitizedRaw = sanitizeStoredLogText(raw);
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
                    monitor_raw_error: sanitizedRaw,
                    monitor_exit_code: classified.exitCode,
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
      await this.clearSession();
      await this.scheduleCleanup();
    }
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}
