import {
  buildFailureDiagnostics,
  buildExporterJobAnalyticsSummary,
  buildMigrationSummary,
  classifyContainerFailure,
  extractBrandStyleFromWebsite,
  fetchBrandStyleLeadProfile,
  normalizeBrandStyleWebsiteUrl,
  normalizeContainerCallbackBody,
  pickBrandStylePayload,
  sanitizeLogText,
  sanitizeStoredLogText,
  type ExporterAnalyticsContext,
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
  SENTRY_DSN?: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  BRAND_STYLE_EXTRACTOR_API?: string;
  LANDING_TO_WEBAPP_HMAC_SECRET?: string;
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
  analytics_context?: unknown;
};

type StartStorageBody = {
  source_edge_function_url?: unknown;
  source_edge_function_access_key?: unknown;
  source_project_url?: unknown;
  target_project_url?: unknown;
  target_admin_key?: unknown;
  storage_copy_concurrency?: unknown;
  hard_timeout_seconds?: unknown;
  skip_existing_target_objects?: unknown;
  analytics_context?: unknown;
};

type StartDownloadBody = {
  source_edge_function_url?: unknown;
  source_edge_function_access_key?: unknown;
  source_project_url?: unknown;
  storage_copy_concurrency?: unknown;
  hard_timeout_seconds?: unknown;
  analytics_context?: unknown;
};

type StartTargetDbTestBody = {
  target_db_url?: unknown;
  hard_timeout_seconds?: unknown;
  analytics_context?: unknown;
};

type TestTargetAdminKeyBody = {
  target_project_url?: unknown;
  target_admin_key?: unknown;
};

type SendMagicLinkBody = {
  email?: unknown;
  redirect_url?: unknown;
  captcha_token?: unknown;
};

type BrandStyleExtractionBody = {
  website?: unknown;
  website_url?: unknown;
};

type StoredSession = {
  jobId: string;
  runId: string;
  callbackToken: string;
  analyticsContext?: ExporterAnalyticsContext | null;
};

type StoredArtifactAccess = {
  token: string;
  runId: string;
  expiresAt: number;
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
const DEFAULT_DOWNLOAD_STORAGE_CONCURRENCY = DEFAULT_STORAGE_COPY_CONCURRENCY;
const DOWNLOAD_STORAGE_MAX_IN_FLIGHT_BYTES = 64 * 1024 * 1024;
const ARTIFACT_ACCESS_TOKEN_TTL_MS = DOWNLOAD_ARTIFACT_LIVE_TIMEOUT_SECONDS * 1000;
const ARTIFACT_UPSTREAM_RETRY_ATTEMPTS = 40;
const ARTIFACT_UPSTREAM_RETRY_DELAY_MS = 250;
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
const ANALYTICS_ID_MAX_LENGTH = 200;
const POSTHOG_PROJECT_KEY_MAX_LENGTH = 160;
const ALLOWED_POSTHOG_HOSTS = new Set(["us.i.posthog.com", "eu.i.posthog.com"]);
const OPTIONAL_CONTAINER_ENV_KEYS = ["LOG_VERBOSITY", "SENTRY_DSN"] as const;
const CALLBACK_FAILURE_LOG_MAX_CHARS = 2_000;

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

const isTerminalStatus = (record: JobRecord) =>
  record.status === "succeeded" || record.status === "failed";

const cleanAnalyticsId = (value: unknown): string | null => {
  const cleaned = cleanString(value);
  return cleaned ? cleaned.slice(0, ANALYTICS_ID_MAX_LENGTH) : null;
};

const cleanPosthogProjectKey = (value: unknown): string | null => {
  const cleaned = cleanString(value);
  if (!cleaned || cleaned.length > POSTHOG_PROJECT_KEY_MAX_LENGTH) return null;
  return /^phc_[A-Za-z0-9_-]+$/.test(cleaned) ? cleaned : null;
};

const cleanPosthogHost = (value: unknown): string | null => {
  const cleaned = cleanString(value);
  if (!cleaned) return DEFAULT_POSTHOG_HOST;

  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol !== "https:" || !ALLOWED_POSTHOG_HOSTS.has(parsed.hostname)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
};

const cleanAnalyticsContext = (value: unknown): ExporterAnalyticsContext | null => {
  if (!isRecord(value)) return null;

  const context = {
    posthog_distinct_id: cleanAnalyticsId(value.posthog_distinct_id),
    posthog_session_id: cleanAnalyticsId(value.posthog_session_id),
    posthog_project_key: cleanPosthogProjectKey(value.posthog_project_key),
    posthog_host: cleanPosthogHost(value.posthog_host),
  };

  return context.posthog_distinct_id || context.posthog_session_id || context.posthog_project_key
    ? context
    : null;
};

const hashAnalyticsId = async (value: string | null | undefined) => {
  const normalized = value?.trim();
  if (!normalized) return null;

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const capturePosthogEvent = async (
  context: ExporterAnalyticsContext | null | undefined,
  eventName: string,
  distinctId: string | null,
  properties: Record<string, unknown>,
) => {
  const apiKey = context?.posthog_project_key;
  if (!apiKey || !distinctId) return;

  const host = context.posthog_host ?? DEFAULT_POSTHOG_HOST;
  const response = await fetch(`${host.replace(/\/$/, "")}/capture/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      api_key: apiKey,
      event: eventName,
      distinct_id: distinctId,
      properties: {
        exporter_surface: "lovable_cloud_to_supabase_exporter",
        ...properties,
      },
    }),
  });

  if (!response.ok) {
    console.error("Failed to capture PostHog exporter event.", response.status);
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

const getBrandStyleExtractorConfig = (env: Env): { endpoint: string; secret: string } | null => {
  const endpoint = cleanHttpUrl(env.BRAND_STYLE_EXTRACTOR_API);
  const secret = cleanString(env.LANDING_TO_WEBAPP_HMAC_SECRET);
  return endpoint && secret ? { endpoint, secret } : null;
};

const requireBrandStyleUser = (requester: AuthenticatedRequester | null) =>
  requester?.kind === "user" ? requester : null;

const handleGetBrandStyleProfile = async (
  req: Request,
  env: Env,
  requester: AuthenticatedRequester | null,
): Promise<Response> => {
  if (req.method !== "GET") {
    return jsonResponse({ error: "Use GET for this route." }, 405);
  }

  const user = requireBrandStyleUser(requester);
  if (!user) {
    return jsonResponse({ error: "Sign in to access your Brand Style profile." }, 401);
  }

  const extractor = getBrandStyleExtractorConfig(env);
  if (!extractor) {
    return jsonResponse(
      {
        error:
          "Brand Style extraction is not configured. Set BRAND_STYLE_EXTRACTOR_API and LANDING_TO_WEBAPP_HMAC_SECRET on the exporter API.",
      },
      503,
    );
  }

  try {
    const profile = await fetchBrandStyleLeadProfile({
      ...extractor,
      exporterUserId: user.userId,
      email: user.email,
    });
    return jsonResponse({ ok: true, profile });
  } catch (error) {
    return jsonResponse({ error: asErrorMessage(error) }, 502);
  }
};

const handleExtractBrandStyleProfile = async (
  req: Request,
  env: Env,
  requester: AuthenticatedRequester | null,
): Promise<Response> => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Use POST for this route." }, 405);
  }

  const user = requireBrandStyleUser(requester);
  if (!user) {
    return jsonResponse({ error: "Sign in to create your Brand Style profile." }, 401);
  }

  const extractor = getBrandStyleExtractorConfig(env);
  if (!extractor) {
    return jsonResponse(
      {
        error:
          "Brand Style extraction is not configured. Set BRAND_STYLE_EXTRACTOR_API and LANDING_TO_WEBAPP_HMAC_SECRET on the exporter API.",
      },
      503,
    );
  }

  const body = (await parseJsonBody(req)) as BrandStyleExtractionBody | null;
  const websiteUrl = normalizeBrandStyleWebsiteUrl(body?.website_url ?? body?.website);
  if (!websiteUrl) {
    return jsonResponse({ error: "A valid website URL is required." }, 400);
  }

  try {
    const rawResponse = await extractBrandStyleFromWebsite({
      ...extractor,
      websiteUrl,
      exporterUserId: user.userId,
      email: user.email,
    });
    return jsonResponse({
      ok: true,
      website_url: websiteUrl,
      brand_style: pickBrandStylePayload(rawResponse),
    });
  } catch (error) {
    return jsonResponse({ error: asErrorMessage(error) }, 502);
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
  posthogDistinctIdHash?: string | null;
  posthogSessionIdHash?: string | null;
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
    posthog_distinct_id_hash: input.posthogDistinctIdHash ?? null,
    posthog_session_id_hash: input.posthogSessionIdHash ?? null,
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
    if (url.pathname === "/brand-style" || url.pathname === "/brand-style/extract") {
      const requester = await authenticateRequest(req, env);
      return url.pathname === "/brand-style"
        ? handleGetBrandStyleProfile(req, env, requester)
        : handleExtractBrandStyleProfile(req, env, requester);
    }
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

    const id = env.LOVABLE_EXPORTER_JOB.idFromName(route.jobId);
    const stub = env.LOVABLE_EXPORTER_JOB.get(id);
    const doUrl = `https://job${url.pathname}${url.search}`;
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

    const allowsTokenBypass =
      action === "artifact" && Boolean(cleanString(url.searchParams.get("token")));
    const requester =
      action === "container-callback" || allowsTokenBypass ? null : this.getRequester(req);

    if (action !== "container-callback" && !requester && !allowsTokenBypass) {
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

    if (action === "artifact-access") {
      const ownershipError = await this.ensureAccess(requester);
      if (ownershipError) return ownershipError;
      return this.handleArtifactAccessRequest(req);
    }

    if (action === "artifact") {
      return this.handleArtifactDownload(req, requester);
    }

    if (action === "container-callback") {
      return this.handleContainerCallback(req);
    }

    if (action === "start-download") {
      return this.startDownload(req, requester);
    }

    if (action === "start-storage") {
      return this.startStorage(req, requester);
    }

    if (action === "test-target-admin-key") {
      return this.testTargetAdminKey(req);
    }

    if (action === "start-target-db-test") {
      return this.startTargetDbTest(req, requester);
    }

    return this.startExport(req, requester);
  }

  private async readStatus(): Promise<JobRecord> {
    return (await this.state.storage.get<JobRecord>("status")) ?? defaultJobRecord();
  }

  private async writeStatus(record: JobRecord): Promise<void> {
    const previous = await this.state.storage.get<JobRecord>("status");
    await this.state.storage.put("status", record);
    if (
      previous &&
      isTerminalStatus(record) &&
      previous.run_id === record.run_id &&
      !isTerminalStatus(previous)
    ) {
      const session = await this.readSession();
      const owner = await this.readOwner();
      this.state.waitUntil(
        this.captureWorkerJobEvent("exporter_job_finished", record, session, owner),
      );
    }
  }

  private async readSession(): Promise<StoredSession | null> {
    return (await this.state.storage.get<StoredSession>("session")) ?? null;
  }

  private async writeSession(session: StoredSession): Promise<void> {
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

  private async readOwner(): Promise<StoredOwner | null> {
    return (await this.state.storage.get<StoredOwner>("owner")) ?? null;
  }

  private async writeOwner(owner: StoredOwner): Promise<void> {
    await this.state.storage.put("owner", owner);
  }

  private async captureWorkerJobEvent(
    eventName: "exporter_job_started" | "exporter_job_finished",
    record: JobRecord,
    session: StoredSession | null,
    owner: StoredOwner | null,
  ): Promise<void> {
    if (!session) return;
    if (record.debug?.task === "db") return;

    const action = record.debug?.task === "download" ? "download" : "transfer";
    const variant = record.debug?.task === "storage" ? "storage-only" : "full";
    const [jobIdHash, runIdHash] = await Promise.all([
      hashAnalyticsId(session.jobId),
      hashAnalyticsId(record.run_id ?? session.runId),
    ]);
    const distinctId =
      session.analyticsContext?.posthog_distinct_id ??
      (owner?.kind === "user" ? owner.userId : null);

    await capturePosthogEvent(session.analyticsContext, eventName, distinctId, {
      ...buildExporterJobAnalyticsSummary(record, {
        action,
        variant,
        jobIdHash,
        runIdHash,
      }),
      emitter: "worker",
      posthog_session_id: session.analyticsContext?.posthog_session_id ?? null,
      $session_id: session.analyticsContext?.posthog_session_id ?? undefined,
      $insert_id: `${eventName}:${jobIdHash ?? session.jobId}:${runIdHash ?? session.runId}`,
      ...(owner?.kind === "user" && owner.email
        ? {
            $set: {
              email: owner.email,
            },
          }
        : {}),
    });
  }

  private async emitCurrentJobStarted(record: JobRecord): Promise<void> {
    const session = await this.readSession();
    const owner = await this.readOwner();
    this.state.waitUntil(
      this.captureWorkerJobEvent("exporter_job_started", record, session, owner),
    );
  }

  private async clearSession(): Promise<void> {
    await this.state.storage.delete("session");
    await this.clearArtifactAccess();
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
    const storageCopyConcurrency = cleanStorageCopyConcurrency(
      body.storage_copy_concurrency ?? DEFAULT_DOWNLOAD_STORAGE_CONCURRENCY,
    );
    const hardTimeoutSeconds = cleanHardTimeout(body.hard_timeout_seconds);
    const analyticsContext = cleanAnalyticsContext(body.analytics_context);

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
        storage_export_max_in_flight_bytes: DOWNLOAD_STORAGE_MAX_IN_FLIGHT_BYTES,
        hard_timeout_seconds: hardTimeoutSeconds,
      },
    });

    await this.writeStatus(next);
    await this.writeSession({
      jobId,
      runId,
      callbackToken,
      analyticsContext,
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
        STORAGE_EXPORT_MAX_IN_FLIGHT_BYTES: String(DOWNLOAD_STORAGE_MAX_IN_FLIGHT_BYTES),
        PGSSLMODE: "require",
      };

      if (sourceProjectUrl) {
        env.SOURCE_PROJECT_URL = sourceProjectUrl;
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
      await this.emitCurrentJobStarted(started);
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
      const diagnostics = buildFailureDiagnostics(raw, { exitCode: classified.exitCode });
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

  private async startStorage(
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
    const body = (await req.json().catch(() => ({}))) as StartStorageBody;

    const sourceEdgeFunctionUrl = cleanHttpUrl(body.source_edge_function_url);
    const sourceEdgeFunctionAccessKey = cleanString(body.source_edge_function_access_key);
    const sourceProjectUrl = cleanProjectUrl(body.source_project_url);
    const targetProjectUrl = cleanProjectUrl(body.target_project_url);
    const targetAdminKey = cleanString(body.target_admin_key);

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
    const analyticsContext = cleanAnalyticsContext(body.analytics_context);

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
      analyticsContext,
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
      await this.emitCurrentJobStarted(started);
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
      const diagnostics = buildFailureDiagnostics(raw, { exitCode: classified.exitCode });
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

  private async startTargetDbTest(
    req: Request,
    requester: AuthenticatedRequester | null,
  ): Promise<Response> {
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
    const analyticsContext = cleanAnalyticsContext(body.analytics_context);

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
      analyticsContext,
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
      const diagnostics = buildFailureDiagnostics(raw, { exitCode: classified.exitCode });
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
    const analyticsContext = cleanAnalyticsContext(body.analytics_context);

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
      analyticsContext,
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
      await this.emitCurrentJobStarted(started);
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
      const diagnostics = buildFailureDiagnostics(raw, { exitCode: classified.exitCode });
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

    const shouldLogFailure = level === "error" || status === "failed" || Boolean(error);
    const [posthogDistinctIdHash, posthogSessionIdHash] = shouldLogFailure
      ? await Promise.all([
          hashAnalyticsId(session.analyticsContext?.posthog_distinct_id),
          hashAnalyticsId(session.analyticsContext?.posthog_session_id),
        ])
      : [null, null];

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
      posthogDistinctIdHash,
      posthogSessionIdHash,
    });
    if (failureLog) {
      console.error(
        JSON.stringify({ event: "exporter.container_callback.failure", ...failureLog }),
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
        { error: "Artifact access token expired. Request a new download link." },
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
      const ownershipError = await this.ensureAccess(requester);
      if (ownershipError) return ownershipError;
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
      const diagnostics = buildFailureDiagnostics(raw, { exitCode: classified.exitCode });
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
      await this.clearSession();
      await this.scheduleCleanup();
    }
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}
