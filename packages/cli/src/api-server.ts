import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildMigrationSummary,
  sanitizeLogText,
  sanitizeLogValue,
  sanitizeStoredLogText,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core";
import {
  getMigrationStatus,
  getMigrationSummary,
  prepareDbMigrationInput,
  prepareDownloadMigrationInput,
  prepareExportMigrationInput,
  prepareStorageMigrationInput,
  runPreparedDbMigration,
  runPreparedDownloadMigration,
  runPreparedExportMigration,
  runPreparedStorageMigration,
} from "./actions.js";
import type { DbCloneRunOptions } from "./db-clone.js";
import type { DownloadRunOptions } from "./download.js";
import type { ExportRunOptions } from "./export.js";
import { asErrorMessage, nowIso, isRecord } from "./inputs.js";
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

const isJobEventLevel = (value: unknown): value is "info" | "warn" | "error" =>
  value === "info" || value === "warn" || value === "error";

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

type ContainerCallbackBody = {
  callback_token?: string;
  run_id?: string;
  level?: "info" | "warn" | "error";
  phase?: string;
  message?: string;
  data?: Record<string, unknown>;
  status?: "running" | "succeeded" | "failed";
  error?: string | null;
  finished_at?: string | null;
  debug_patch?: Record<string, unknown>;
};

const normalizeContainerCallbackBody = (
  body: Record<string, unknown>,
): ContainerCallbackBody | null => {
  const callbackToken = asNonEmptyString(body.callback_token);
  const runId = asNonEmptyString(body.run_id);
  const level = isJobEventLevel(body.level) ? body.level : null;
  const phase = asNonEmptyString(body.phase);
  const message = asNonEmptyString(body.message);
  const status =
    body.status === "running" || body.status === "succeeded" || body.status === "failed"
      ? body.status
      : undefined;
  const data = asRecord(body.data)
    ? (sanitizeLogValue(body.data) as Record<string, unknown>)
    : undefined;
  const debugPatch = asRecord(body.debug_patch)
    ? (sanitizeLogValue(body.debug_patch) as Record<string, unknown>)
    : undefined;
  if (typeof debugPatch?.monitor_raw_error === "string") {
    debugPatch.monitor_raw_error = sanitizeStoredLogText(debugPatch.monitor_raw_error);
  }
  const errorValue =
    body.error === null
      ? null
      : typeof body.error === "string"
        ? sanitizeLogText(body.error)
        : undefined;
  const finishedAt =
    body.finished_at === null
      ? null
      : typeof body.finished_at === "string"
        ? body.finished_at
        : undefined;

  if (!callbackToken || !runId || !level || !phase || !message) {
    return null;
  }

  return {
    callback_token: callbackToken,
    run_id: runId,
    level,
    phase,
    message: sanitizeLogText(message),
    data,
    status,
    error: errorValue,
    finished_at: finishedAt,
    debug_patch: debugPatch,
  };
};

const formatCallbackHost = (host: string): string => {
  if (isLoopbackHost(host)) return "host.docker.internal";
  if (host.includes(":") && !host.startsWith("[")) {
    return `[${host}]`;
  }
  return host;
};

const buildContainerCallbackBaseUrl = (host: string, port: number): string =>
  `http://${formatCallbackHost(host)}:${port}`;

const persistUnhandledJobFailure = async (
  jobId: string,
  action: "start-db" | "start-storage" | "start-export" | "start-download",
  error: unknown,
): Promise<void> => {
  const details = asErrorMessage(error);
  const sanitizedDetails = sanitizeStoredLogText(details);
  const task =
    action === "start-db"
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
        task === "db"
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
        task === "db"
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
      const match = requestUrl.pathname.match(
        /^\/jobs\/([^/]+)\/(start-db|start-storage|start-export|start-download|status|summary|artifact|container-callback)$/,
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

      if (action !== "container-callback" && !isAuthorized(req, options.token)) {
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

      if (action === "artifact" && req.method === "GET") {
        if (!(await artifactExists(jobId))) {
          writeJson(res, 404, { error: "ZIP artifact not found for this job." });
          return;
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

      if (
        action !== "start-db" &&
        action !== "start-storage" &&
        action !== "start-export" &&
        action !== "start-download"
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
