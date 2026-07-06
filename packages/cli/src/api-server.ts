import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  buildMigrationSummary,
  JOB_ROUTE_ACTIONS,
  normalizeContainerCallbackBody,
  sanitizeLogText,
  sanitizeStoredLogText,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core";
import {
  getMigrationStatus,
  getMigrationSummary,
  prepareDbMigrationInput,
  prepareDownloadMigrationInput,
  prepareExportMigrationInput,
  prepareSourceInspectInput,
  prepareStorageMigrationInput,
  prepareTargetDbTestInput,
  runPreparedDbMigration,
  runPreparedDownloadMigration,
  runPreparedExportMigration,
  runPreparedSourceInspect,
  runPreparedStorageMigration,
  runPreparedTargetDbTest,
} from "./actions.js";
import type { DownloadRunOptions } from "./download.js";
import type { ExportRunOptions } from "./export.js";
import type { DockerRuntimeOptions } from "./runtime-options.js";
import type { SourceInspectRunOptions } from "./source-inspect.js";
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
const JOB_ROUTE_ACTION_PATTERN = JOB_ROUTE_ACTIONS.join("|");

const rawDbStartFromBody = (body: Record<string, unknown>) => ({
  source_type: body.source_type,
  source_edge_function_url: body.source_edge_function_url,
  source_edge_function_access_key:
    body.source_edge_function_access_key ?? body.source_edge_function_token,
  source_db_url: body.source_db_url,
  target_db_url: body.target_db_url,
  confirm_target_blank: body.confirm_target_blank,
  hard_timeout_seconds: body.hard_timeout_seconds,
  exclude_data_tables: body.exclude_data_tables,
  enable_rls_on_restored_tables: body.enable_rls_on_restored_tables,
  auth_user_migration: body.auth_user_migration,
  verification: body.verification,
});

const rawStorageStartFromBody = (body: Record<string, unknown>) => ({
  source_type: body.source_type,
  source_edge_function_url: body.source_edge_function_url,
  source_edge_function_access_key:
    body.source_edge_function_access_key ?? body.source_edge_function_token,
  source_db_url: body.source_db_url,
  source_project_url: body.source_project_url,
  target_project_url: body.target_project_url,
  target_admin_key: body.target_admin_key,
  storage_copy_concurrency: body.storage_copy_concurrency,
  skip_existing_target_objects: body.skip_existing_target_objects,
});

const rawExportStartFromBody = (body: Record<string, unknown>) => ({
  source_type: body.source_type,
  source_edge_function_url: body.source_edge_function_url,
  source_edge_function_access_key:
    body.source_edge_function_access_key ?? body.source_edge_function_token,
  source_db_url: body.source_db_url,
  target_db_url: body.target_db_url,
  confirm_target_blank: body.confirm_target_blank,
  source_project_url: body.source_project_url,
  target_project_url: body.target_project_url,
  target_admin_key: body.target_admin_key,
  storage_copy_concurrency: body.storage_copy_concurrency,
  hard_timeout_seconds: body.hard_timeout_seconds,
  exclude_data_tables: body.exclude_data_tables,
  enable_rls_on_restored_tables: body.enable_rls_on_restored_tables,
  auth_user_migration: body.auth_user_migration,
  verification: body.verification,
});

const rawDownloadStartFromBody = (body: Record<string, unknown>) => ({
  source_type: body.source_type,
  source_edge_function_url: body.source_edge_function_url,
  source_edge_function_access_key:
    body.source_edge_function_access_key ?? body.source_edge_function_token,
  source_db_url: body.source_db_url,
  source_project_url: body.source_project_url,
  storage_copy_concurrency: body.storage_copy_concurrency,
  hard_timeout_seconds: body.hard_timeout_seconds,
  exclude_data_tables: body.exclude_data_tables,
});

const rawTargetDbTestFromBody = (body: Record<string, unknown>) => ({
  target_db_url: body.target_db_url,
  hard_timeout_seconds: body.hard_timeout_seconds,
});

const rawSourceInspectFromBody = (body: Record<string, unknown>) => ({
  source_edge_function_url: body.source_edge_function_url,
  source_edge_function_access_key:
    body.source_edge_function_access_key ?? body.source_edge_function_token,
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
  action:
    | "start-db"
    | "start-storage"
    | "start-export"
    | "start-download"
    | "start-target-db-test"
    | "start-source-inspect",
  error: unknown,
): Promise<void> => {
  const details = asErrorMessage(error);
  const sanitizedDetails = sanitizeStoredLogText(details);
  const task =
    action === "start-db" || action === "start-target-db-test" || action === "start-source-inspect"
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
          : action === "start-source-inspect"
            ? "Source inspection failed due to an internal server error."
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
          : action === "start-source-inspect"
            ? "source_inspect.failed"
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
  dbOptions: DockerRuntimeOptions;
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
      const match = requestUrl.pathname.match(
        new RegExp(`^/jobs/([^/]+)/(${JOB_ROUTE_ACTION_PATTERN})$`),
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
        action !== "start-target-db-test" &&
        action !== "start-source-inspect"
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

      if (action === "start-source-inspect") {
        const normalizedInspect = prepareSourceInspectInput(rawSourceInspectFromBody(parsedBody));

        if (!normalizedInspect.ok) {
          writeJson(res, 400, { error: normalizedInspect.error });
          return;
        }

        const runId = `run-${Date.now()}-${randomBytes(4).toString("hex")}`;
        const callbackToken = randomBytes(24).toString("hex");
        callbackSessions.set(jobId, { callbackToken, runId });
        runningJobs.add(jobId);

        const sourceInspectOptions: SourceInspectRunOptions = {
          ...options.dbOptions,
          runId,
          callbackToken,
          callbackUrl: `${buildContainerCallbackBaseUrl(options.host, options.port)}/jobs/${encodeURIComponent(jobId)}/container-callback`,
        };

        void runPreparedSourceInspect(jobId, normalizedInspect.value, sourceInspectOptions)
          .catch((error: unknown) => {
            process.stderr.write(
              sanitizeLogText(
                `[api] Unexpected source inspection failure for ${jobId}: ${asErrorMessage(error)}\n`,
              ),
            );
            void persistUnhandledJobFailure(jobId, "start-source-inspect", error);
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
