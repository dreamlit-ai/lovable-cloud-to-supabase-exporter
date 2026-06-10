import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildMigrationSummary,
  extractBrandStyleFromWebsite,
  fetchBrandStyleLeadProfile,
  normalizeBrandStyleWebsiteUrl,
  normalizeContainerCallbackBody,
  pickBrandStylePayload,
  sanitizeLogText,
  sanitizeStoredLogText,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core";
import {
  getMigrationStatus,
  getMigrationSummary,
  prepareDbMigrationInput,
  prepareDownloadMigrationInput,
  prepareExportMigrationInput,
  prepareStorageMigrationInput,
  prepareTargetDbTestInput,
  runPreparedDbMigration,
  runPreparedDownloadMigration,
  runPreparedExportMigration,
  runPreparedStorageMigration,
  runPreparedTargetDbTest,
} from "./actions.js";
import type { DbCloneRunOptions } from "./db-clone.js";
import type { DownloadRunOptions } from "./download.js";
import type { ExportRunOptions } from "./export.js";
import type { TargetDbTestRunOptions } from "./target-db-test.js";
import { asErrorMessage, nowIso, isRecord, normalizeProjectUrl, trimOrNull } from "./inputs.js";
import { artifactExists, artifactFileName, artifactFilePath } from "./artifacts.js";
import {
  buildDefaultDebug,
  isValidJobId,
  pushEvent,
  readJob,
  updateJob,
  writeJob,
} from "./jobs.js";
import { MAX_REQUEST_BYTES } from "./utils.js";

const LOCAL_ENV_FILE_URLS = [
  new URL("../.env.local", import.meta.url),
  new URL("../.env", import.meta.url),
  new URL("../../web-ui/.env.local", import.meta.url),
  new URL("../../web-ui/.env", import.meta.url),
  new URL("../../../.env.local", import.meta.url),
  new URL("../../../.env", import.meta.url),
];

let hasLoadedLocalEnvFiles = false;

const writeJson = (res: ServerResponse, status: number, payload: unknown): void => {
  res.statusCode = status;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload, null, 2));
};

const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
  let body = "";
  let bodyBytes = 0;
  for await (const chunk of req) {
    const text = chunk.toString("utf8");
    body += text;
    bodyBytes += Buffer.byteLength(text, "utf8");
    if (bodyBytes > MAX_REQUEST_BYTES) {
      throw new Error("request_too_large");
    }
  }

  if (!body.trim()) return {};

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("invalid_json");
  }
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;

const asNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const parseSimpleEnvFile = (source: string): Record<string, string> => {
  const entries: Record<string, string> = {};

  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = normalized.slice(0, separatorIndex).trim();
    if (!key) continue;

    let value = normalized.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    entries[key] = value;
  }

  return entries;
};

const loadLocalEnvFiles = (): void => {
  if (hasLoadedLocalEnvFiles) return;
  hasLoadedLocalEnvFiles = true;

  for (const envFileUrl of LOCAL_ENV_FILE_URLS) {
    const envFilePath = fileURLToPath(envFileUrl);
    if (!existsSync(envFilePath)) continue;

    const parsed = parseSimpleEnvFile(readFileSync(envFilePath, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] == null) {
        process.env[key] = value;
      }
    }
  }
};

const isLikelyEmail = (value: string | null): value is string =>
  Boolean(value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));

const cleanHttpUrl = (value: unknown): string | null => {
  const raw = asNonEmptyString(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
};

const getSupabaseAuthErrorMessage = (
  payload: Record<string, unknown> | null,
  status: number,
): string =>
  asNonEmptyString(payload?.msg) ??
  asNonEmptyString(payload?.error_description) ??
  asNonEmptyString(payload?.message) ??
  asNonEmptyString(payload?.error) ??
  `Supabase auth request failed (${status}).`;

const isExistingUserError = (message: string): boolean =>
  /already (?:been )?registered|already exists|user already/i.test(message);

const ensureExistingAuthUser = async ({
  supabaseUrl,
  serviceRoleKey,
  email,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  email: string;
}): Promise<void> => {
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

  if (response.ok) return;

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const message = getSupabaseAuthErrorMessage(payload, response.status);
  if (isExistingUserError(message)) return;
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
}): Promise<void> => {
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

  if (response.ok) return;

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  throw new Error(getSupabaseAuthErrorMessage(payload, response.status));
};

type AuthenticatedBrandStyleUser = {
  userId: string;
  email: string | null;
};

const getLocalSupabaseConfig = () => {
  loadLocalEnvFiles();

  const supabaseUrl =
    cleanHttpUrl(process.env.SUPABASE_URL ?? null) ??
    cleanHttpUrl(process.env.VITE_SUPABASE_URL ?? null);
  const anonKey =
    asNonEmptyString(process.env.SUPABASE_ANON_KEY ?? null) ??
    asNonEmptyString(process.env.VITE_SUPABASE_ANON_KEY ?? null);

  if (!supabaseUrl || !anonKey) {
    return null;
  }

  return { supabaseUrl, anonKey };
};

const getBearerToken = (req: IncomingMessage): string | null => {
  const raw = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  const match = raw?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
};

const verifySupabaseAccessToken = async (
  token: string,
): Promise<AuthenticatedBrandStyleUser | null> => {
  const config = getLocalSupabaseConfig();
  if (!config) return null;

  const response = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: config.anonKey,
    },
  }).catch(() => null);

  if (!response?.ok) return null;

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const userId = asNonEmptyString(payload?.id);
  if (!userId) return null;

  return {
    userId,
    email: asNonEmptyString(payload?.email),
  };
};

const authenticateBrandStyleUser = async (
  req: IncomingMessage,
): Promise<AuthenticatedBrandStyleUser | null> => {
  const token = getBearerToken(req);
  return token ? verifySupabaseAccessToken(token) : null;
};

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const isLoopbackHttpsUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
};

// A local Dreamlit webapp (next dev --experimental-https) serves mkcert
// certificates that Node's fetch does not trust. For loopback HTTPS endpoints
// only, skip TLS verification so local development works without extra setup.
let insecureLoopbackFetch: typeof fetch | null = null;

const getLoopbackHttpsFetch = (): typeof fetch => {
  // Node's built-in fetch rejects dispatchers from the npm undici package, so
  // use undici's own fetch together with its Agent.
  insecureLoopbackFetch ??= (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { Agent, fetch: undiciFetch } = await import("undici");
    const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...((init ?? {}) as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    });
  }) as unknown as typeof fetch;
  return insecureLoopbackFetch;
};

const getBrandStyleExtractorConfig = () => {
  loadLocalEnvFiles();

  const endpoint = cleanHttpUrl(process.env.BRAND_STYLE_EXTRACTOR_API ?? null);
  const secret = asNonEmptyString(process.env.LANDING_TO_WEBAPP_HMAC_SECRET ?? null);
  if (!endpoint || !secret) return null;

  return {
    endpoint,
    secret,
    ...(isLoopbackHttpsUrl(endpoint) ? { fetchImpl: getLoopbackHttpsFetch() } : {}),
  };
};

const handleGetBrandStyleProfile = async (
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  if (req.method !== "GET") {
    writeJson(res, 405, { error: "Use GET for this route." });
    return;
  }

  const user = await authenticateBrandStyleUser(req);
  if (!user) {
    writeJson(res, 401, { error: "Sign in to access your Brand Style profile." });
    return;
  }

  const extractor = getBrandStyleExtractorConfig();
  if (!extractor) {
    writeJson(res, 503, {
      error:
        "Brand Style extraction is not configured. Add BRAND_STYLE_EXTRACTOR_API and LANDING_TO_WEBAPP_HMAC_SECRET to packages/web-ui/.env.local or export them before starting the local API.",
    });
    return;
  }

  try {
    const profile = await fetchBrandStyleLeadProfile({
      ...extractor,
      exporterUserId: user.userId,
      email: user.email,
    });
    writeJson(res, 200, { ok: true, profile });
  } catch (error) {
    writeJson(res, 502, { error: asErrorMessage(error) });
  }
};

const handleExtractBrandStyleProfile = async (
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  if (req.method !== "POST") {
    writeJson(res, 405, { error: "Use POST for this route." });
    return;
  }

  const user = await authenticateBrandStyleUser(req);
  if (!user) {
    writeJson(res, 401, { error: "Sign in to create your Brand Style profile." });
    return;
  }

  const extractor = getBrandStyleExtractorConfig();
  if (!extractor) {
    writeJson(res, 503, {
      error:
        "Brand Style extraction is not configured. Add BRAND_STYLE_EXTRACTOR_API and LANDING_TO_WEBAPP_HMAC_SECRET to packages/web-ui/.env.local or export them before starting the local API.",
    });
    return;
  }

  const body = asRecord(await readJsonBody(req));
  const websiteUrl = normalizeBrandStyleWebsiteUrl(body?.website_url ?? body?.website);
  if (!websiteUrl) {
    writeJson(res, 400, { error: "A valid website URL is required." });
    return;
  }

  try {
    const rawResponse = await extractBrandStyleFromWebsite({
      ...extractor,
      websiteUrl,
      exporterUserId: user.userId,
      email: user.email,
    });
    writeJson(res, 200, {
      ok: true,
      website_url: websiteUrl,
      brand_style: pickBrandStylePayload(rawResponse),
    });
  } catch (error) {
    writeJson(res, 502, { error: asErrorMessage(error) });
  }
};

const handleSendMagicLink = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  if (req.method !== "POST") {
    writeJson(res, 405, { error: "Use POST for this route." });
    return;
  }

  const body = asRecord(await readJsonBody(req));
  const email = asNonEmptyString(body?.email)?.toLowerCase() ?? null;
  const redirectUrl = cleanHttpUrl(body?.redirect_url);
  const captchaToken = asNonEmptyString(body?.captcha_token);

  if (!isLikelyEmail(email)) {
    writeJson(res, 400, { error: "Enter a valid email address." });
    return;
  }

  if (!redirectUrl) {
    writeJson(res, 400, { error: "A valid redirect URL is required." });
    return;
  }

  loadLocalEnvFiles();

  const supabaseUrl =
    cleanHttpUrl(process.env.SUPABASE_URL ?? null) ??
    cleanHttpUrl(process.env.VITE_SUPABASE_URL ?? null);
  const anonKey =
    asNonEmptyString(process.env.SUPABASE_ANON_KEY ?? null) ??
    asNonEmptyString(process.env.VITE_SUPABASE_ANON_KEY ?? null);
  const serviceRoleKey = asNonEmptyString(process.env.SUPABASE_SERVICE_ROLE_KEY ?? null);

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    writeJson(res, 503, {
      error:
        "Auth is not fully configured. Add SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY to packages/web-ui/.env.local or export them before starting the local API.",
    });
    return;
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
    writeJson(res, 200, { ok: true });
  } catch (error) {
    writeJson(res, 400, { error: asErrorMessage(error) });
  }
};

const isJobStatus = (value: unknown): value is "idle" | "running" | "succeeded" | "failed" =>
  value === "idle" || value === "running" || value === "succeeded" || value === "failed";

const isLoopbackHost = (host: string): boolean => {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
};

const isAuthorized = (req: IncomingMessage, token: string | null): boolean => {
  if (!token) return true;
  return req.headers.authorization === `Bearer ${token}`;
};

const ARTIFACT_ACCESS_TOKEN_TTL_MS = 5 * 60 * 1000;

const rawDbStartFromBody = (body: Record<string, unknown>) => ({
  source_edge_function_url: body.source_edge_function_url,
  source_edge_function_access_key:
    body.source_edge_function_access_key ?? body.source_edge_function_token,
  target_db_url: body.target_db_url,
  confirm_target_blank: body.confirm_target_blank,
  hard_timeout_seconds: body.hard_timeout_seconds,
});

const rawStorageStartFromBody = (body: Record<string, unknown>) => ({
  source_edge_function_url: body.source_edge_function_url,
  source_edge_function_access_key:
    body.source_edge_function_access_key ?? body.source_edge_function_token,
  source_project_url: body.source_project_url,
  target_project_url: body.target_project_url,
  target_admin_key: body.target_admin_key,
  storage_copy_concurrency: body.storage_copy_concurrency,
  skip_existing_target_objects: body.skip_existing_target_objects,
});

const rawExportStartFromBody = (body: Record<string, unknown>) => ({
  source_edge_function_url: body.source_edge_function_url,
  source_edge_function_access_key:
    body.source_edge_function_access_key ?? body.source_edge_function_token,
  target_db_url: body.target_db_url,
  confirm_target_blank: body.confirm_target_blank,
  source_project_url: body.source_project_url,
  target_project_url: body.target_project_url,
  target_admin_key: body.target_admin_key,
  storage_copy_concurrency: body.storage_copy_concurrency,
  hard_timeout_seconds: body.hard_timeout_seconds,
});

const rawDownloadStartFromBody = (body: Record<string, unknown>) => ({
  source_edge_function_url: body.source_edge_function_url,
  source_edge_function_access_key:
    body.source_edge_function_access_key ?? body.source_edge_function_token,
  source_project_url: body.source_project_url,
  storage_copy_concurrency: body.storage_copy_concurrency,
  hard_timeout_seconds: body.hard_timeout_seconds,
});

const rawTargetDbTestFromBody = (body: Record<string, unknown>) => ({
  target_db_url: body.target_db_url,
  hard_timeout_seconds: body.hard_timeout_seconds,
});

const rawTargetAdminKeyTestFromBody = (body: Record<string, unknown>) => ({
  target_project_url: body.target_project_url,
  target_admin_key: body.target_admin_key,
});

const formatCallbackHost = (host: string): string => {
  if (isLoopbackHost(host)) return "host.docker.internal";
  if (host.includes(":") && !host.startsWith("[")) {
    return `[${host}]`;
  }
  return host;
};

const buildContainerCallbackBaseUrl = (host: string, port: number): string =>
  `http://${formatCallbackHost(host)}:${port}`;

const testTargetAdminKey = async (
  raw: ReturnType<typeof rawTargetAdminKeyTestFromBody>,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> => {
  const targetProjectUrlRaw = trimOrNull(
    typeof raw.target_project_url === "string" ? raw.target_project_url : null,
  );
  const targetAdminKey = trimOrNull(
    typeof raw.target_admin_key === "string" ? raw.target_admin_key : null,
  );

  if (!targetProjectUrlRaw || !targetAdminKey) {
    return {
      ok: false,
      status: 400,
      error: "Supabase project URL and secret API key are required.",
    };
  }

  let targetProjectUrl: string;
  try {
    targetProjectUrl = normalizeProjectUrl(targetProjectUrlRaw);
  } catch {
    return {
      ok: false,
      status: 400,
      error: "Supabase project URL is invalid. Check the connection string and try again.",
    };
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
    return {
      ok: false,
      status: 502,
      error: "Could not reach Supabase. Check the project URL and try again.",
    };
  }

  if (response.ok) {
    return { ok: true };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      status: 400,
      error:
        "Secret API key was rejected. Create a new secret key for this Supabase project and try again.",
    };
  }

  if (response.status === 404) {
    return {
      ok: false,
      status: 400,
      error:
        "Could not verify the secret API key for this Supabase project. Check the project URL and try again.",
    };
  }

  return {
    ok: false,
    status: 502,
    error: "Supabase could not verify the secret API key right now. Try again in a moment.",
  };
};

const persistUnhandledJobFailure = async (
  jobId: string,
  action: "start-db" | "start-storage" | "start-export" | "start-download" | "start-target-db-test",
  error: unknown,
): Promise<void> => {
  const details = asErrorMessage(error);
  const sanitizedDetails = sanitizeStoredLogText(details);
  const task =
    action === "start-db" || action === "start-target-db-test"
      ? "db"
      : action === "start-storage"
        ? "storage"
        : action === "start-download"
          ? "download"
          : "export";

  const current = await readJob(jobId);
  const next = pushEvent(
    {
      ...current,
      status: "failed",
      finished_at: nowIso(),
      error:
        action === "start-target-db-test"
          ? "Supabase database connection test failed due to an internal server error."
          : task === "db"
            ? "DB clone failed due to an internal server error."
            : task === "storage"
              ? "Storage copy failed due to an internal server error."
              : task === "download"
                ? "ZIP export failed due to an internal server error."
                : "Combined export failed due to an internal server error.",
      debug: {
        ...(current.debug ?? buildDefaultDebug({ task })),
        task,
        failure_class: "internal_server_error",
        failure_hint: "Inspect local server logs and retry.",
        monitor_raw_error: sanitizedDetails,
      },
    },
    {
      level: "error",
      phase:
        action === "start-target-db-test"
          ? "target_db_connection.failed"
          : task === "db"
            ? "db_clone.failed"
            : task === "storage"
              ? "storage_copy.failed"
              : task === "download"
                ? "download.failed"
                : "export.failed",
      message: "Migration job crashed unexpectedly.",
      data: { error: sanitizeLogText(details) },
    },
  );

  await writeJob(jobId, next);
};

export const runApiServer = async (options: {
  host: string;
  port: number;
  token: string | null;
  dbOptions: DbCloneRunOptions;
}): Promise<void> => {
  if (!isLoopbackHost(options.host) && !options.token) {
    throw new Error(
      "Refusing to bind non-loopback host without auth token. Set API bearer token and retry.",
    );
  }

  const runningJobs = new Set<string>();
  const callbackSessions = new Map<string, { callbackToken: string; runId: string }>();
  const artifactAccessSessions = new Map<
    string,
    { token: string; runId: string; expiresAt: number }
  >();

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        writeJson(res, 204, {});
        return;
      }

      const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (requestUrl.pathname === "/auth/send-magic-link") {
        await handleSendMagicLink(req, res);
        return;
      }
      if (requestUrl.pathname === "/brand-style") {
        await handleGetBrandStyleProfile(req, res);
        return;
      }
      if (requestUrl.pathname === "/brand-style/extract") {
        await handleExtractBrandStyleProfile(req, res);
        return;
      }
      const match = requestUrl.pathname.match(
        /^\/jobs\/([^/]+)\/(start-db|start-storage|start-export|start-download|start-target-db-test|test-target-admin-key|status|summary|artifact-access|artifact|container-callback)$/,
      );

      if (requestUrl.pathname === "/health" && req.method === "GET") {
        writeJson(res, 200, { ok: true });
        return;
      }

      if (!match) {
        writeJson(res, 404, { error: "Invalid migration route." });
        return;
      }

      const jobId = decodeURIComponent(match[1] ?? "");
      const action = match[2] ?? "";
      if (!jobId) {
        writeJson(res, 400, { error: "Job ID is required." });
        return;
      }
      if (!isValidJobId(jobId)) {
        writeJson(res, 400, {
          error: "Invalid Job ID. Use 1-80 chars from: letters, numbers, dot, underscore, hyphen.",
        });
        return;
      }

      const artifactToken = requestUrl.searchParams.get("token");
      const artifactAccess = artifactAccessSessions.get(jobId);
      const hasValidArtifactToken =
        action === "artifact" &&
        typeof artifactToken === "string" &&
        artifactAccess?.token === artifactToken &&
        artifactAccess.expiresAt > Date.now();

      if (
        action !== "container-callback" &&
        !isAuthorized(req, options.token) &&
        !hasValidArtifactToken
      ) {
        writeJson(res, 401, {
          error: "Unauthorized. Provide a valid API token and try again.",
        });
        return;
      }

      if (action === "container-callback") {
        if (req.method !== "POST") {
          writeJson(res, 405, { error: "Use POST for this action." });
          return;
        }

        const session = callbackSessions.get(jobId);
        if (!session) {
          writeJson(res, 409, { error: "Job callback session not found." });
          return;
        }

        const parsedBody = asRecord(await readJsonBody(req));
        const callbackBody = parsedBody ? normalizeContainerCallbackBody(parsedBody) : null;

        if (!callbackBody) {
          writeJson(res, 400, { error: "Invalid callback payload." });
          return;
        }

        if (callbackBody.callback_token !== session.callbackToken) {
          writeJson(res, 401, { error: "Invalid callback token." });
          return;
        }

        if (callbackBody.run_id !== session.runId) {
          writeJson(res, 409, { error: "Callback run_id does not match active job run." });
          return;
        }

        await updateJob(jobId, (current) => {
          if (current.run_id !== session.runId) return current;

          const nextDebug =
            current.debug && callbackBody.debug_patch
              ? {
                  ...current.debug,
                  ...callbackBody.debug_patch,
                }
              : current.debug;
          const nextStatus =
            callbackBody.status && isJobStatus(callbackBody.status)
              ? callbackBody.status
              : current.status;
          const nextFinishedAt =
            callbackBody.status === "succeeded" || callbackBody.status === "failed"
              ? (callbackBody.finished_at ?? nowIso())
              : current.finished_at;
          const nextError = callbackBody.error !== undefined ? callbackBody.error : current.error;

          return pushEvent(
            {
              ...current,
              status: nextStatus,
              finished_at: nextFinishedAt,
              error: nextError,
              debug: nextDebug,
            },
            {
              level: callbackBody.level!,
              phase: callbackBody.phase!,
              message: callbackBody.message!,
              data: callbackBody.data,
            },
          );
        });

        writeJson(res, 202, { ok: true });
        return;
      }

      if (action === "status" && req.method === "GET") {
        const status = await getMigrationStatus(jobId);
        writeJson(res, 200, { ...status, summary: buildMigrationSummary(status) });
        return;
      }

      if (action === "summary" && req.method === "GET") {
        writeJson(res, 200, await getMigrationSummary(jobId));
        return;
      }

      if (action === "artifact-access" && req.method === "POST") {
        const status = await getMigrationStatus(jobId);
        if (status.debug?.task !== "download") {
          writeJson(res, 404, { error: "ZIP artifact not found for this job." });
          return;
        }

        if (status.status !== "succeeded" || !(await artifactExists(jobId))) {
          writeJson(res, 409, { error: "ZIP export is still preparing." });
          return;
        }

        const token = crypto.randomUUID().replaceAll("-", "");
        const expiresAt = Date.now() + ARTIFACT_ACCESS_TOKEN_TTL_MS;
        artifactAccessSessions.set(jobId, {
          token,
          runId: status.run_id ?? "",
          expiresAt,
        });

        writeJson(res, 200, {
          download_url: `${requestUrl.origin}/jobs/${encodeURIComponent(jobId)}/artifact?token=${encodeURIComponent(token)}`,
          expires_at: new Date(expiresAt).toISOString(),
        });
        return;
      }

      if (action === "artifact" && req.method === "GET") {
        if (!(await artifactExists(jobId))) {
          writeJson(res, 404, { error: "ZIP artifact not found for this job." });
          return;
        }

        const status = await getMigrationStatus(jobId);
        if (hasValidArtifactToken) {
          if ((artifactAccess?.runId ?? "") !== (status.run_id ?? "")) {
            artifactAccessSessions.delete(jobId);
            writeJson(res, 410, {
              error: "Artifact access token is no longer valid for this run.",
            });
            return;
          }
          artifactAccessSessions.delete(jobId);
        }

        res.statusCode = 200;
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", `attachment; filename="${artifactFileName(jobId)}"`);
        createReadStream(artifactFilePath(jobId)).pipe(res);
        return;
      }

      if (action === "test-target-admin-key") {
        if (req.method !== "POST") {
          writeJson(res, 405, { error: "Use POST for this action." });
          return;
        }

        const parsedBody = asRecord(await readJsonBody(req));
        if (!parsedBody) {
          writeJson(res, 400, {
            error: "Request body is required. Add required fields and try again.",
          });
          return;
        }

        const result = await testTargetAdminKey(rawTargetAdminKeyTestFromBody(parsedBody));
        if (!result.ok) {
          writeJson(res, result.status, { error: result.error });
          return;
        }

        writeJson(res, 200, { ok: true });
        return;
      }

      if (
        action !== "start-db" &&
        action !== "start-storage" &&
        action !== "start-export" &&
        action !== "start-download" &&
        action !== "start-target-db-test"
      ) {
        writeJson(res, 405, { error: "Method not allowed." });
        return;
      }

      if (req.method !== "POST") {
        writeJson(res, 405, { error: "Use POST for this action." });
        return;
      }

      const parsedBody = asRecord(await readJsonBody(req));
      if (!parsedBody) {
        writeJson(res, 400, {
          error: "Request body is required. Add required fields and try again.",
        });
        return;
      }

      if (runningJobs.has(jobId)) {
        writeJson(res, 409, {
          error: "Job is already running for this ID. Wait for completion and retry.",
        });
        return;
      }

      if (action === "start-db") {
        const normalizedDb = prepareDbMigrationInput(rawDbStartFromBody(parsedBody));

        if (!normalizedDb.ok) {
          writeJson(res, 400, { error: normalizedDb.error });
          return;
        }

        runningJobs.add(jobId);
        void runPreparedDbMigration(jobId, normalizedDb.value, options.dbOptions)
          .catch((error: unknown) => {
            process.stderr.write(
              sanitizeLogText(
                `[api] Unexpected DB migration failure for ${jobId}: ${asErrorMessage(error)}\n`,
              ),
            );
            void persistUnhandledJobFailure(jobId, "start-db", error);
          })
          .finally(() => {
            runningJobs.delete(jobId);
          });

        writeJson(res, 202, { ok: true, job_id: jobId, status: "running" });
        return;
      }

      if (action === "start-export") {
        const normalizedExport = prepareExportMigrationInput(rawExportStartFromBody(parsedBody));

        if (!normalizedExport.ok) {
          writeJson(res, 400, { error: normalizedExport.error });
          return;
        }

        const runId = `run-${Date.now()}-${randomBytes(4).toString("hex")}`;
        const callbackToken = randomBytes(24).toString("hex");
        callbackSessions.set(jobId, { callbackToken, runId });
        runningJobs.add(jobId);

        const exportOptions: ExportRunOptions = {
          ...options.dbOptions,
          runId,
          callbackToken,
          callbackUrl: `${buildContainerCallbackBaseUrl(options.host, options.port)}/jobs/${encodeURIComponent(jobId)}/container-callback`,
        };

        void runPreparedExportMigration(jobId, normalizedExport.value, exportOptions)
          .catch((error: unknown) => {
            process.stderr.write(
              sanitizeLogText(
                `[api] Unexpected export failure for ${jobId}: ${asErrorMessage(error)}\n`,
              ),
            );
            void persistUnhandledJobFailure(jobId, "start-export", error);
          })
          .finally(() => {
            callbackSessions.delete(jobId);
            runningJobs.delete(jobId);
          });

        writeJson(res, 202, { ok: true, job_id: jobId, status: "running" });
        return;
      }

      if (action === "start-download") {
        const normalizedDownload = prepareDownloadMigrationInput(
          rawDownloadStartFromBody(parsedBody),
        );

        if (!normalizedDownload.ok) {
          writeJson(res, 400, { error: normalizedDownload.error });
          return;
        }

        const runId = `run-${Date.now()}-${randomBytes(4).toString("hex")}`;
        const callbackToken = randomBytes(24).toString("hex");
        callbackSessions.set(jobId, { callbackToken, runId });
        runningJobs.add(jobId);

        const downloadOptions: DownloadRunOptions = {
          ...options.dbOptions,
          runId,
          callbackToken,
          callbackUrl: `${buildContainerCallbackBaseUrl(options.host, options.port)}/jobs/${encodeURIComponent(jobId)}/container-callback`,
        };

        void runPreparedDownloadMigration(jobId, normalizedDownload.value, downloadOptions)
          .catch((error: unknown) => {
            process.stderr.write(
              sanitizeLogText(
                `[api] Unexpected ZIP export failure for ${jobId}: ${asErrorMessage(error)}\n`,
              ),
            );
            void persistUnhandledJobFailure(jobId, "start-download", error);
          })
          .finally(() => {
            callbackSessions.delete(jobId);
            runningJobs.delete(jobId);
          });

        writeJson(res, 202, { ok: true, job_id: jobId, status: "running" });
        return;
      }

      if (action === "start-target-db-test") {
        const normalizedTargetDb = prepareTargetDbTestInput(rawTargetDbTestFromBody(parsedBody));

        if (!normalizedTargetDb.ok) {
          writeJson(res, 400, { error: normalizedTargetDb.error });
          return;
        }

        const runId = `run-${Date.now()}-${randomBytes(4).toString("hex")}`;
        const callbackToken = randomBytes(24).toString("hex");
        callbackSessions.set(jobId, { callbackToken, runId });
        runningJobs.add(jobId);

        const targetDbTestOptions: TargetDbTestRunOptions = {
          ...options.dbOptions,
          runId,
          callbackToken,
          callbackUrl: `${buildContainerCallbackBaseUrl(options.host, options.port)}/jobs/${encodeURIComponent(jobId)}/container-callback`,
        };

        void runPreparedTargetDbTest(jobId, normalizedTargetDb.value, targetDbTestOptions)
          .catch((error: unknown) => {
            process.stderr.write(
              sanitizeLogText(
                `[api] Unexpected target DB test failure for ${jobId}: ${asErrorMessage(error)}\n`,
              ),
            );
            void persistUnhandledJobFailure(jobId, "start-target-db-test", error);
          })
          .finally(() => {
            callbackSessions.delete(jobId);
            runningJobs.delete(jobId);
          });

        writeJson(res, 202, { ok: true, job_id: jobId, status: "running" });
        return;
      }

      const normalizedStorage = prepareStorageMigrationInput(rawStorageStartFromBody(parsedBody));

      if (!normalizedStorage.ok) {
        writeJson(res, 400, { error: normalizedStorage.error });
        return;
      }

      runningJobs.add(jobId);
      void runPreparedStorageMigration(jobId, normalizedStorage.value)
        .catch((error: unknown) => {
          process.stderr.write(
            sanitizeLogText(
              `[api] Unexpected storage migration failure for ${jobId}: ${asErrorMessage(error)}\n`,
            ),
          );
          void persistUnhandledJobFailure(jobId, "start-storage", error);
        })
        .finally(() => {
          runningJobs.delete(jobId);
        });

      writeJson(res, 202, { ok: true, job_id: jobId, status: "running" });
    } catch (error) {
      const message = asErrorMessage(error);
      if (message === "request_too_large") {
        writeJson(res, 413, {
          error: "Request is too large. Reduce payload size and try again.",
        });
        return;
      }
      if (message === "invalid_json") {
        writeJson(res, 400, {
          error: "Invalid JSON body. Fix payload and try again.",
        });
        return;
      }
      writeJson(res, 500, {
        error: "Migration service failed. Retry in a moment.",
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });

  process.stdout.write(
    `Local exporter API server listening on http://${options.host}:${options.port}\n`,
  );
  if (options.token) {
    process.stdout.write("Bearer auth enabled.\n");
  } else {
    process.stdout.write("Bearer auth disabled for local use.\n");
  }
};
