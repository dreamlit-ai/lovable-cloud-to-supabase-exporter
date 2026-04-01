import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import {
  classifyContainerFailure,
  parseLogVerbosity,
  sanitizeLogText,
  sanitizeLogValue,
  sanitizeStoredLogText,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core";
import {
  getStorageCopyFailureDetails,
  getStorageCopyFailureHint,
  runStorageCopyEngine,
  toStorageFailureEventData as buildStorageFailureEventData,
  type StorageCopyObjectFailure,
  type StorageCopyProgress,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core/storage-copy";
import {
  createSourceStorageObjectEnumerator,
  type SourceStorageObjectEnumerator,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core/source-storage-discovery";
import {
  runStorageExportEngine,
  type StorageExportProgress,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core/storage-export";
import { ZipArtifactWriter, createSchemaSqlFilterStream } from "./archive-writer.js";

type SourceEdgePayload = {
  supabase_db_url?: unknown;
  service_role_key?: unknown;
  error?: unknown;
  message?: unknown;
};

type SourceEdgeResolved = {
  sourceDbUrl: string;
  sourceAdminKey: string | null;
  sourceProjectUrl: string;
};

type RunnerErrorOptions = {
  exitCode: number;
  phase: string;
  failureClass: string;
  failureHint: string;
  eventData?: Record<string, unknown>;
  alreadyReported?: boolean;
};

class RunnerError extends Error {
  exitCode: number;
  phase: string;
  failureClass: string;
  failureHint: string;
  eventData?: Record<string, unknown>;
  alreadyReported: boolean;

  constructor(message: string, options: RunnerErrorOptions) {
    super(message);
    this.exitCode = options.exitCode;
    this.phase = options.phase;
    this.failureClass = options.failureClass;
    this.failureHint = options.failureHint;
    this.eventData = options.eventData;
    this.alreadyReported = options.alreadyReported === true;
  }
}

const toStorageFailureEventData = (error: unknown): Record<string, unknown> | undefined => {
  const details = getStorageCopyFailureDetails(error);
  return details ? buildStorageFailureEventData(details) : undefined;
};

const buildStorageCopyOutcomeMessage = (
  objectsFailed: number,
  objectsSkippedMissing: number,
  objectsSkippedExisting: number,
): string => {
  if (objectsFailed > 0) {
    const failureLabel = `${objectsFailed} object failure${objectsFailed === 1 ? "" : "s"}`;
    if (objectsSkippedMissing > 0 && objectsSkippedExisting > 0) {
      return `Storage copy completed with ${failureLabel}. Missing source objects were skipped, and existing target objects were left in place.`;
    }
    if (objectsSkippedMissing > 0) {
      return `Storage copy completed with ${failureLabel}. Missing source objects were skipped.`;
    }
    if (objectsSkippedExisting > 0) {
      return `Storage copy completed with ${failureLabel}. Existing target objects were left in place.`;
    }
    return `Storage copy completed with ${failureLabel}.`;
  }
  if (objectsSkippedMissing > 0 && objectsSkippedExisting > 0) {
    return "Storage copy completed with missing source objects skipped. Existing target objects were also left in place.";
  }
  if (objectsSkippedMissing > 0) {
    return "Storage copy completed with missing objects skipped.";
  }
  if (objectsSkippedExisting > 0) {
    return "Storage copy completed. Existing target objects were left in place.";
  }
  return "Storage copy completed.";
};

const buildStorageCopyFailureHintWithRetry = (
  primaryFailure: StorageCopyObjectFailure | null,
): string => {
  const base = getStorageCopyFailureHint(primaryFailure);
  return base.includes("Retry")
    ? base
    : `${base} Retry storage only to continue copying the remaining objects.`;
};

const buildFailedObjectSamplesData = (samples: StorageCopyObjectFailure[]) =>
  samples.map((sample) => ({
    message: sample.message,
    ...buildStorageFailureEventData(sample),
  }));

const buildStorageCopySummaryData = (
  summary: {
    bucketIds: string[];
    bucketsTotal: number;
    bucketsCreated: number;
    objectsTotal: number;
    objectsCopied: number;
    objectsFailed: number;
    objectsSkippedExisting: number;
    objectsSkippedMissing: number;
    failedObjectSamples: StorageCopyObjectFailure[];
  },
  extras: Record<string, unknown> = {},
): Record<string, unknown> => {
  const primaryFailure = summary.failedObjectSamples[0] ?? null;

  return {
    bucket_ids: summary.bucketIds,
    buckets_total: summary.bucketsTotal,
    buckets_created: summary.bucketsCreated,
    objects_total: summary.objectsTotal,
    objects_copied: summary.objectsCopied,
    objects_failed: summary.objectsFailed,
    objects_skipped_existing: summary.objectsSkippedExisting,
    objects_skipped_missing: summary.objectsSkippedMissing,
    failed_objects_sample: buildFailedObjectSamplesData(summary.failedObjectSamples),
    ...(primaryFailure ? buildStorageFailureEventData(primaryFailure) : {}),
    ...extras,
  };
};

type CallbackPayload = {
  callback_token: string;
  run_id: string;
  level: "info" | "warn" | "error";
  phase: string;
  message: string;
  data?: Record<string, unknown>;
  status?: "running" | "succeeded" | "failed";
  error?: string | null;
  finished_at?: string | null;
  debug_patch?: Record<string, unknown>;
};

const nowIso = () => new Date().toISOString();
const APP_SCHEMA = "public";
const DATA_SCHEMAS = ["public", "auth"];
const DEFAULT_STORAGE_JOB_CONCURRENCY = 32;
const STORAGE_OBJECT_QUERY_BATCH_SIZE = 2000;
const DEFAULT_ARTIFACT_LIVE_TIMEOUT_SECONDS = 5 * 60;
const ARTIFACT_CONTENT_TYPE = "application/zip";
const EXCLUDED_TABLES = [
  "auth.schema_migrations",
  "storage.migrations",
  "supabase_functions.migrations",
  "auth.sessions",
  "auth.refresh_tokens",
  "auth.flow_state",
  "auth.one_time_tokens",
  "auth.audit_log_entries",
];

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const asPostgresUrl = (value: unknown): string | null => {
  const raw = asNonEmptyString(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
};

const asBooleanEnv = (value: string | null): boolean =>
  value !== null && ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());

const requiredEnv = (name: string): string => {
  const value = asNonEmptyString(process.env[name]);
  if (!value) {
    throw new RunnerError(`Missing required env: ${name}`, {
      exitCode: 65,
      phase: "export.failed",
      failureClass: "runtime_config_invalid",
      failureHint: `Provide ${name} and retry.`,
    });
  }
  return value;
};

const optionalEnv = (name: string): string | null => asNonEmptyString(process.env[name]);
const logVerbosity = parseLogVerbosity(process.env.LOG_VERBOSITY);

const writeSanitizedText = (stream: NodeJS.WriteStream, text: string): void => {
  stream.write(sanitizeLogText(text));
};

const sanitizeLogRecord = (
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | null => {
  if (!data) return null;
  return sanitizeLogValue(data) as Record<string, unknown>;
};

const logRuntime = (
  level: "info" | "warn" | "error" | "debug",
  message: string,
  data?: Record<string, unknown>,
): void => {
  if (level === "debug" && logVerbosity !== "debug") {
    return;
  }

  const sanitizedData = sanitizeLogRecord(data);
  let line = `[runtime][${level}] ${sanitizeLogText(message)}`;
  if (sanitizedData && Object.keys(sanitizedData).length > 0) {
    line += ` ${JSON.stringify(sanitizedData)}`;
  }
  line += "\n";

  if (level === "warn" || level === "error") {
    process.stderr.write(line);
    return;
  }

  process.stdout.write(line);
};

const attachSanitizedOutput = (
  stream: NodeJS.ReadableStream,
  target: NodeJS.WriteStream,
  onText: (text: string) => void,
) => {
  let pending = "";

  stream.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    onText(text);
    pending += text;

    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      writeSanitizedText(target, `${line}\n`);
    }
  });

  return () => {
    if (!pending) return;
    writeSanitizedText(target, pending);
    pending = "";
  };
};

const parseJsonPayload = (raw: string): SourceEdgePayload | null => {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as SourceEdgePayload;
  } catch {
    return null;
  }
};

const payloadErrorMessage = (payload: SourceEdgePayload | null): string | null => {
  if (!payload) return null;
  return asNonEmptyString(payload.error) ?? asNonEmptyString(payload.message);
};

const edgeFunctionOrigin = (edgeFunctionUrl: string): string => {
  const parsed = new URL(edgeFunctionUrl);
  return `${parsed.protocol}//${parsed.host}`;
};

const resolveSourceFromEdgeFunction = async (
  sourceEdgeFunctionUrl: string,
  sourceEdgeFunctionAccessKey: string,
): Promise<SourceEdgeResolved> => {
  logRuntime("debug", "source_edge_function.request", {
    source_edge_function_url: sourceEdgeFunctionUrl,
  });

  let response: Response;
  try {
    response = await fetch(sourceEdgeFunctionUrl, {
      method: "POST",
      headers: {
        "x-access-key": sourceEdgeFunctionAccessKey,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
  } catch {
    throw new RunnerError("Could not call source edge function from export runtime.", {
      exitCode: 61,
      phase: "db_clone.failed",
      failureClass: "source_edge_function_resolve_failed",
      failureHint: "Check source edge function URL/access key and network reachability.",
    });
  }

  const raw = await response.text();
  const payload = parseJsonPayload(raw);
  logRuntime("debug", "source_edge_function.response", {
    source_edge_function_url: sourceEdgeFunctionUrl,
    status: response.status,
    ok: response.ok,
  });
  if (payload === null) {
    throw new RunnerError("Source edge function returned invalid JSON.", {
      exitCode: 61,
      phase: "db_clone.failed",
      failureClass: "source_edge_function_resolve_failed",
      failureHint: "Return JSON with supabase_db_url and service_role_key.",
    });
  }

  if (!response.ok) {
    throw new RunnerError(
      payloadErrorMessage(payload) ?? "Source edge function request failed inside export runtime.",
      {
        exitCode: 61,
        phase: "db_clone.failed",
        failureClass: "source_edge_function_resolve_failed",
        failureHint: "Check source edge function URL/access key and function response.",
      },
    );
  }

  const sourceDbUrl = asPostgresUrl(payload.supabase_db_url);
  if (!sourceDbUrl) {
    throw new RunnerError("Source edge function response is missing supabase_db_url.", {
      exitCode: 61,
      phase: "db_clone.failed",
      failureClass: "source_edge_function_resolve_failed",
      failureHint: "Return a valid postgres URL in supabase_db_url.",
    });
  }

  return {
    sourceDbUrl,
    sourceAdminKey: asNonEmptyString(payload.service_role_key),
    sourceProjectUrl: edgeFunctionOrigin(sourceEdgeFunctionUrl),
  };
};

const runCommandCapture = async (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<string> => {
  return await new Promise<string>((resolve, reject) => {
    const startedAt = Date.now();
    const commandLine = [command, ...args].join(" ");
    logRuntime("info", "command.started", {
      command: commandLine,
      cwd: cwd ?? null,
    });

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      cwd,
    });

    let output = "";

    const flushStdout = attachSanitizedOutput(child.stdout, process.stdout, (text) => {
      output += text;
    });
    const flushStderr = attachSanitizedOutput(child.stderr, process.stderr, (text) => {
      output += text;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      flushStdout();
      flushStderr();

      const durationMs = Date.now() - startedAt;
      logRuntime((code ?? 1) === 0 ? "info" : "warn", "command.finished", {
        command: commandLine,
        exit_code: code ?? 1,
        duration_ms: durationMs,
      });

      if ((code ?? 1) === 0) {
        resolve(output.trim());
        return;
      }
      reject(new Error(`${output}\nexit code: ${code ?? 1}`.trim()));
    });
  });
};

const runCommandStream = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): { stdout: NodeJS.ReadableStream; completed: Promise<void> } => {
  const startedAt = Date.now();
  const commandLine = [command, ...args].join(" ");
  logRuntime("info", "command.started", {
    command: commandLine,
    cwd: cwd ?? null,
  });

  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    cwd,
  });
  if (!child.stdout || !child.stderr) {
    throw new Error(`Could not capture ${command} output streams.`);
  }

  let stderrOutput = "";
  const flushStderr = attachSanitizedOutput(child.stderr, process.stderr, (text) => {
    stderrOutput += text;
  });

  const completed = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      flushStderr();

      const durationMs = Date.now() - startedAt;
      logRuntime((code ?? 1) === 0 ? "info" : "warn", "command.finished", {
        command: commandLine,
        exit_code: code ?? 1,
        duration_ms: durationMs,
      });

      if ((code ?? 1) === 0) {
        resolve();
        return;
      }

      reject(new Error(`${stderrOutput}\nexit code: ${code ?? 1}`.trim()));
    });
  });

  return {
    stdout: child.stdout,
    completed,
  };
};

const buildDownloadManifest = (): string =>
  `${JSON.stringify(
    {
      generated_at: nowIso(),
      db: {
        schema_file: "db/schema.sql",
        data_file: "db/data.sql",
      },
      storage: {
        root: "storage/",
        buckets_manifest: "storage/buckets.json",
      },
    },
    null,
    2,
  )}\n`;

const appendDatabaseDumpEntries = async (
  sourceDbUrl: string,
  artifactWriter: ZipArtifactWriter,
): Promise<void> => {
  artifactWriter.appendText("manifest.json", buildDownloadManifest());

  const schemaDump = runCommandStream(
    "pg_dump",
    [
      sourceDbUrl,
      "--format=plain",
      "--schema-only",
      `--schema=${APP_SCHEMA}`,
      "--no-owner",
      "--no-acl",
    ],
    process.env,
  );
  artifactWriter.appendEntry({
    name: "db/schema.sql",
    body: schemaDump.stdout.pipe(createSchemaSqlFilterStream()),
  });
  await schemaDump.completed.catch((error) => {
    throw new RunnerError(error instanceof Error ? error.message : "Schema dump failed.", {
      exitCode: 41,
      phase: "db_clone.failed",
      failureClass: "source_schema_dump_failed",
      failureHint: "Verify source DB reachability and pg_dump permissions.",
    });
  });

  const dataDump = runCommandStream(
    "pg_dump",
    [
      sourceDbUrl,
      "--format=plain",
      "--data-only",
      ...DATA_SCHEMAS.map((schema) => `--schema=${schema}`),
      ...EXCLUDED_TABLES.map((table) => `--exclude-table=${table}`),
      "--no-owner",
      "--no-acl",
    ],
    process.env,
  );
  artifactWriter.appendEntry({
    name: "db/data.sql",
    body: dataDump.stdout,
  });
  await dataDump.completed.catch((error) => {
    throw new RunnerError(error instanceof Error ? error.message : "Data dump failed.", {
      exitCode: 42,
      phase: "db_clone.failed",
      failureClass: "source_data_dump_failed",
      failureHint: "Verify source DB permissions and pg_dump connectivity.",
    });
  });

  logRuntime("info", "download_export.db_artifacts_streamed", {
    schema_file: "db/schema.sql",
    data_file: "db/data.sql",
    manifest_file: "manifest.json",
  });
};

const finalizeZipArtifact = async (
  artifactWriter: ZipArtifactWriter,
  context: {
    artifactOutputPath?: string | null;
    artifactFileName: string;
    delivery: "filesystem" | "live_stream";
  },
): Promise<void> => {
  await artifactWriter.finalize().catch((error) => {
    throw new RunnerError(error instanceof Error ? error.message : "ZIP archive creation failed.", {
      exitCode: 66,
      phase: "download.failed",
      failureClass: "artifact_archive_failed",
      failureHint: "Retry the ZIP export. If it persists, inspect runtime logs.",
    });
  });

  logRuntime("info", "artifact_archive.created", {
    artifact_output_path: context.artifactOutputPath ?? null,
    artifact_file_name: context.artifactFileName,
    artifact_delivery: context.delivery,
    artifact_total_size: artifactWriter.bytesWritten(),
  });
};

const parseIntegerEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(optionalEnv(name) ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
};

const postDownloadArtifactReady = async (
  postProgress: ReturnType<typeof buildCallbackPoster>,
  data: Record<string, unknown>,
): Promise<void> => {
  await postProgress({
    level: "info",
    phase: "artifact_delivery.ready",
    message: "ZIP artifact is ready to stream.",
    status: "running",
    data,
  });
};

const buildDownloadSuccessPayload = (
  artifactFileName: string,
  artifactTotalSize: number | null,
  artifactDelivery: "filesystem" | "live" | "live_stream",
) => ({
  artifact_file_name: artifactFileName,
  artifact_total_size: artifactTotalSize,
  artifact_delivery: artifactDelivery,
});

const serveArtifactLiveFile = async (
  artifactPath: string,
  postProgress: ReturnType<typeof buildCallbackPoster>,
): Promise<void> => {
  const port = parseIntegerEnv("ARTIFACT_LIVE_PORT", 0);
  if (port <= 0) {
    const artifactInfo = await stat(artifactPath);
    logRuntime("info", "artifact_delivery.completed", {
      artifact_path: artifactPath,
      delivery: "filesystem_only",
    });
    await postProgress({
      level: "info",
      phase: "download.succeeded",
      message: "ZIP export completed.",
      status: "succeeded",
      finished_at: nowIso(),
      error: null,
      data: buildDownloadSuccessPayload(
        path.basename(artifactPath),
        artifactInfo.size,
        "filesystem",
      ),
    });
    return;
  }

  const timeoutSeconds = parseIntegerEnv(
    "ARTIFACT_LIVE_TIMEOUT_SECONDS",
    DEFAULT_ARTIFACT_LIVE_TIMEOUT_SECONDS,
  );
  const artifactInfo = await stat(artifactPath);
  const fileName = path.basename(artifactPath);
  logRuntime("info", "artifact_delivery.ready", {
    artifact_file_name: fileName,
    artifact_total_size: artifactInfo.size,
    port,
    timeout_seconds: timeoutSeconds,
  });

  await new Promise<void>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      if (req.method !== "GET" || req.url !== "/artifact") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found.");
        return;
      }

      const stream = createReadStream(artifactPath);
      let settled = false;
      const complete = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        server.close(() => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      };

      res.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(artifactInfo.size),
        "Content-Type": ARTIFACT_CONTENT_TYPE,
      });

      stream.on("error", (error) => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        }
        res.end("Artifact read failed.");
        complete(error instanceof Error ? error : new Error("Artifact read failed."));
      });

      res.on("finish", () => {
        complete();
      });

      res.on("close", () => {
        if (!res.writableEnded) {
          complete(new Error("Artifact stream closed before completion."));
        }
      });

      stream.pipe(res);
    });

    server.on("error", (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });

    const timeoutId = setTimeout(() => {
      server.close(() => resolve());
    }, timeoutSeconds * 1000);
    timeoutId.unref();

    server.listen(port, "0.0.0.0", () => {
      logRuntime("info", "artifact_delivery.live", {
        artifact_file_name: fileName,
        artifact_total_size: artifactInfo.size,
        port,
      });
      void postDownloadArtifactReady(
        postProgress,
        buildDownloadSuccessPayload(fileName, artifactInfo.size, "live"),
      ).catch((error) => {
        clearTimeout(timeoutId);
        server.close(() => {
          reject(error instanceof Error ? error : new Error("Progress callback failed."));
        });
      });
    });
  });
};

const serveArtifactLiveStream = async (
  artifactFileName: string,
  postProgress: ReturnType<typeof buildCallbackPoster>,
  generateArtifact: (artifactWriter: ZipArtifactWriter) => Promise<void>,
): Promise<void> => {
  const port = parseIntegerEnv("ARTIFACT_LIVE_PORT", 0);
  if (port <= 0) {
    throw new RunnerError("Streaming artifact delivery requires ARTIFACT_LIVE_PORT.", {
      exitCode: 65,
      phase: "download.failed",
      failureClass: "runtime_config_invalid",
      failureHint: "Set ARTIFACT_LIVE_PORT or use the filesystem artifact flow.",
    });
  }

  const timeoutSeconds = parseIntegerEnv(
    "ARTIFACT_LIVE_TIMEOUT_SECONDS",
    DEFAULT_ARTIFACT_LIVE_TIMEOUT_SECONDS,
  );

  await new Promise<void>((resolve, reject) => {
    let handledRequest = false;
    let settled = false;

    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      server.close(() => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    };

    const server = createServer((req, res) => {
      if (req.method !== "GET" || req.url !== "/artifact") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found.");
        return;
      }

      if (handledRequest) {
        res.writeHead(409, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Artifact stream already started.");
        return;
      }

      handledRequest = true;
      res.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${artifactFileName}"`,
        "Content-Type": ARTIFACT_CONTENT_TYPE,
      });

      const artifactWriter = ZipArtifactWriter.createWritable(res);
      void (async () => {
        try {
          await generateArtifact(artifactWriter);
          await finalizeZipArtifact(artifactWriter, {
            artifactFileName,
            artifactOutputPath: null,
            delivery: "live_stream",
          });
          const artifactTotalSize = artifactWriter.bytesWritten();
          logRuntime("info", "artifact_delivery.completed", {
            artifact_file_name: artifactFileName,
            artifact_total_size: artifactTotalSize,
            delivery: "live_stream",
          });
          await postProgress({
            level: "info",
            phase: "download.succeeded",
            message: "ZIP export completed.",
            status: "succeeded",
            finished_at: nowIso(),
            error: null,
            data: buildDownloadSuccessPayload(artifactFileName, artifactTotalSize, "live_stream"),
          });
          settle();
        } catch (error) {
          artifactWriter.abort();
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Artifact stream failed.");
          } else {
            res.destroy(error instanceof Error ? error : new Error("Artifact stream failed."));
          }
          settle(error instanceof Error ? error : new Error("Artifact stream failed."));
        }
      })();
    });

    server.on("error", (error) => {
      settle(error instanceof Error ? error : new Error("Artifact server failed."));
    });

    const timeoutId = setTimeout(() => {
      settle(
        new RunnerError(
          "ZIP artifact stream was never requested before the live timeout expired.",
          {
            exitCode: 70,
            phase: "download.failed",
            failureClass: "artifact_delivery_timeout",
            failureHint: "Open the artifact download immediately after the export becomes ready.",
          },
        ),
      );
    }, timeoutSeconds * 1000);
    timeoutId.unref();

    server.listen(port, "0.0.0.0", () => {
      logRuntime("info", "artifact_delivery.ready", {
        artifact_file_name: artifactFileName,
        artifact_total_size: null,
        port,
        timeout_seconds: timeoutSeconds,
      });
      void postDownloadArtifactReady(
        postProgress,
        buildDownloadSuccessPayload(artifactFileName, null, "live_stream"),
      ).catch((error) => {
        settle(error instanceof Error ? error : new Error("Progress callback failed."));
      });
    });
  });
};

const runDownloadArtifactExport = async (
  artifactWriter: ZipArtifactWriter,
  input: {
    resolvedSource: SourceEdgeResolved;
    sourceProjectUrl: string;
    concurrency: number;
    postProgress: ReturnType<typeof buildCallbackPoster>;
  },
): Promise<void> => {
  await input.postProgress({
    level: "info",
    phase: "db_clone.started",
    message: "Database export started.",
    status: "running",
  });
  await appendDatabaseDumpEntries(input.resolvedSource.sourceDbUrl, artifactWriter);
  await input.postProgress({
    level: "info",
    phase: "db_clone.succeeded",
    message: "Database export completed.",
    status: "running",
  });

  if (!input.resolvedSource.sourceAdminKey) {
    throw new RunnerError("Source edge function response is missing service_role_key.", {
      exitCode: 62,
      phase: "storage_copy.failed",
      failureClass: "source_admin_key_missing",
      failureHint: "Redeploy the migrate-helper that returns service_role_key and retry.",
    });
  }

  await input.postProgress({
    level: "info",
    phase: "storage_copy.started",
    message: "Storage export started.",
    status: "running",
    data: {
      source_project_url: input.sourceProjectUrl,
      concurrency: input.concurrency,
    },
  });

  const sourceObjectEnumerator = await resolveSourceObjectEnumerator({
    sourceDbUrl: input.resolvedSource.sourceDbUrl,
    postProgress: input.postProgress,
  });

  const summary = await runStorageExportEngine({
    sourceProjectUrl: input.sourceProjectUrl,
    sourceAdminKey: input.resolvedSource.sourceAdminKey,
    concurrency: input.concurrency,
    sourceObjectEnumerator,
    writeFile: async (entry) => {
      artifactWriter.appendEntry({
        name: entry.relativePath,
        body: entry.body,
      });
    },
    onStage: async (stage) => {
      logRuntime("debug", "storage_export.stage", {
        stage: stage.stage,
        ...stage.data,
      });
      await input.postProgress({
        level: "info",
        phase: "storage_copy.debug",
        message: stage.message,
        status: "running",
        data: {
          stage: stage.stage,
          ...stage.data,
        },
      });
    },
    onProgress: async (progress: StorageExportProgress) => {
      logRuntime("debug", "storage_export.progress", {
        bucket_id: progress.bucketId,
        prefix: progress.prefix,
        buckets_processed: progress.bucketsProcessed,
        buckets_total: progress.bucketsTotal,
        prefixes_scanned: progress.prefixesScanned,
        scan_complete: progress.scanComplete,
        objects_total: progress.objectsTotal,
        objects_copied: progress.objectsCopied,
        objects_skipped_missing: progress.objectsSkippedMissing,
      });
      await input.postProgress({
        level: "info",
        phase: "storage_copy.progress",
        message: "Storage export in progress.",
        status: "running",
        data: {
          bucket_id: progress.bucketId,
          prefix: progress.prefix,
          buckets_processed: progress.bucketsProcessed,
          buckets_total: progress.bucketsTotal,
          prefixes_scanned: progress.prefixesScanned,
          scan_complete: progress.scanComplete,
          objects_total: progress.objectsTotal,
          objects_copied: progress.objectsCopied,
          objects_skipped_missing: progress.objectsSkippedMissing,
        },
      });
    },
  }).catch((error) => {
    throw new RunnerError(asNonEmptyString((error as Error)?.message) ?? "Storage export failed.", {
      exitCode: 63,
      phase: "storage_copy.failed",
      failureClass: "storage_export_failed",
      failureHint: "Check source admin key and storage bucket/object permissions.",
    });
  });

  logRuntime("info", "storage_export.summary", {
    bucket_ids: summary.bucketIds,
    buckets_total: summary.bucketsTotal,
    objects_total: summary.objectsTotal,
    objects_copied: summary.objectsCopied,
    objects_skipped_missing: summary.objectsSkippedMissing,
    concurrency: input.concurrency,
  });

  await input.postProgress({
    level: "info",
    phase: summary.objectsSkippedMissing > 0 ? "storage_copy.partial" : "storage_copy.succeeded",
    message:
      summary.objectsSkippedMissing > 0
        ? "Storage export completed with missing objects skipped."
        : "Storage export completed.",
    status: "running",
    data: {
      bucket_ids: summary.bucketIds,
      buckets_total: summary.bucketsTotal,
      buckets_created: 0,
      objects_total: summary.objectsTotal,
      objects_copied: summary.objectsCopied,
      objects_skipped_missing: summary.objectsSkippedMissing,
      concurrency: input.concurrency,
    },
  });
};

type TargetDbInspection = {
  publicRelations: number;
  publicRoutines: number;
  publicRoutineNames: string[];
  authUsers: number;
};

type DbCloneStage = "dump_schema" | "dump_data" | "restore_schema" | "restore_data" | "completed";

const describeBlockingTargetDbContents = (inspection: TargetDbInspection) => {
  const parts: string[] = [];
  if (inspection.publicRelations > 0) {
    parts.push(
      `${inspection.publicRelations} public table${inspection.publicRelations === 1 ? "" : "s"}`,
    );
  }
  if (inspection.authUsers > 0) {
    parts.push(`${inspection.authUsers} auth user${inspection.authUsers === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
};

const inspectTargetDb = async (targetDbUrl: string): Promise<TargetDbInspection> => {
  const psqlEnv = {
    ...process.env,
    PGCONNECT_TIMEOUT: "10",
  };

  await runCommandCapture(
    "psql",
    [targetDbUrl, "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-Atqc", "SELECT 1;"],
    psqlEnv,
  ).catch((error) => {
    throw new RunnerError(
      "Could not connect to the target database with the provided credentials.",
      {
        exitCode: 67,
        phase: "target_validation.failed",
        failureClass: "target_db_connection_failed",
        failureHint:
          "Check the Supabase Postgres connection string, postgres password, and network reachability, then retry.",
        eventData: {
          error: error instanceof Error ? error.message : "unknown",
        },
      },
    );
  });

  const inspectionRaw = await runCommandCapture(
    "psql",
    [
      targetDbUrl,
      "--no-psqlrc",
      "-v",
      "ON_ERROR_STOP=1",
      "-Atqc",
      `SELECT json_build_object(
        'public_relations',
        (
          SELECT COUNT(*)::int
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        ),
        'public_routines',
        (
          SELECT COUNT(*)::int
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
        ),
        'public_routine_names',
        COALESCE(
          (
            SELECT json_agg(
              format(
                '%I.%I(%s)',
                n.nspname,
                p.proname,
                pg_get_function_identity_arguments(p.oid)
              )
              ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)
            )
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public'
          ),
          '[]'::json
        ),
        'auth_users',
        CASE
          WHEN to_regclass('auth.users') IS NULL THEN 0
          ELSE (SELECT COUNT(*)::int FROM auth.users)
        END
      )::text;`,
    ],
    psqlEnv,
  ).catch((error) => {
    throw new RunnerError(
      "Connected to the target database, but could not verify whether it is empty.",
      {
        exitCode: 69,
        phase: "target_validation.failed",
        failureClass: "target_db_inspection_failed",
        failureHint: "Use the postgres credentials from Supabase Connect, then retry.",
        eventData: {
          error: error instanceof Error ? error.message : "unknown",
        },
      },
    );
  });

  let inspection: TargetDbInspection | null = null;
  try {
    const parsed = JSON.parse(inspectionRaw) as Record<string, unknown>;
    const publicRelations =
      typeof parsed.public_relations === "number"
        ? parsed.public_relations
        : Number.parseInt(String(parsed.public_relations ?? "0"), 10);
    const publicRoutines =
      typeof parsed.public_routines === "number"
        ? parsed.public_routines
        : Number.parseInt(String(parsed.public_routines ?? "0"), 10);
    const publicRoutineNames = Array.isArray(parsed.public_routine_names)
      ? parsed.public_routine_names
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter((value) => value.length > 0)
      : [];
    const authUsers =
      typeof parsed.auth_users === "number"
        ? parsed.auth_users
        : Number.parseInt(String(parsed.auth_users ?? "0"), 10);

    if (
      Number.isFinite(publicRelations) &&
      Number.isFinite(publicRoutines) &&
      Number.isFinite(authUsers)
    ) {
      inspection = {
        publicRelations,
        publicRoutines,
        publicRoutineNames,
        authUsers,
      };
    }
  } catch {
    inspection = null;
  }

  if (!inspection) {
    throw new RunnerError(
      "Connected to the target database, but the empty-state check returned an unexpected response.",
      {
        exitCode: 69,
        phase: "target_validation.failed",
        failureClass: "target_db_inspection_failed",
        failureHint:
          "Retry once. If it persists, inspect the runtime logs for the target DB preflight query.",
      },
    );
  }

  if (inspection.publicRelations > 0 || inspection.authUsers > 0) {
    throw new RunnerError(
      `Target database does not appear empty. Found ${describeBlockingTargetDbContents(
        inspection,
      )}.`,
      {
        exitCode: 68,
        phase: "target_validation.failed",
        failureClass: "target_db_not_empty",
        failureHint: "Start with a fresh or reset Supabase database, then retry.",
        eventData: {
          public_relations: inspection.publicRelations,
          public_routines: inspection.publicRoutines,
          public_routine_names: inspection.publicRoutineNames,
          auth_users: inspection.authUsers,
        },
      },
    );
  }

  logRuntime("info", "target_validation.inspected", {
    public_relations: inspection.publicRelations,
    public_routines: inspection.publicRoutines,
    auth_users: inspection.authUsers,
  });

  return inspection;
};

const quoteSqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

const buildPsqlEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PGCONNECT_TIMEOUT: "10",
});

type SourceStorageObjectRow = {
  object_path: unknown;
  metadata?: unknown;
};

const parseSourceStorageObjectRows = (
  raw: string,
): Array<{ objectPath: string; metadata: Record<string, unknown> | null }> =>
  raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SourceStorageObjectRow)
    .map((row) => {
      const objectPath = asNonEmptyString(row.object_path);
      if (!objectPath) {
        throw new Error("Source storage object query returned a row without object_path.");
      }
      return {
        objectPath,
        metadata:
          row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
            ? (row.metadata as Record<string, unknown>)
            : null,
      };
    });

const runPsqlQueryCapture = async (sourceDbUrl: string, sql: string): Promise<string> =>
  runCommandCapture(
    "psql",
    [sourceDbUrl, "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-Atqc", sql],
    buildPsqlEnv(),
  );

const countSourceStorageObjectsFromDb = async (sourceDbUrl: string): Promise<number> => {
  const raw = await runPsqlQueryCapture(
    sourceDbUrl,
    "SELECT COUNT(*)::bigint FROM storage.objects;",
  );
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("Source storage object count query returned an invalid result.");
  }
  return parsed;
};

const listSourceStorageObjectsFromDb = async (
  sourceDbUrl: string,
  bucketId: string,
  lastObjectPath: string | null,
  limit = STORAGE_OBJECT_QUERY_BATCH_SIZE,
): Promise<Array<{ objectPath: string; metadata: Record<string, unknown> | null }>> => {
  const afterClause = lastObjectPath ? `AND name > ${quoteSqlLiteral(lastObjectPath)}` : "";
  const sql = `SELECT json_build_object('object_path', name, 'metadata', metadata)::text
FROM storage.objects
WHERE bucket_id = ${quoteSqlLiteral(bucketId)}
  ${afterClause}
ORDER BY name
LIMIT ${Math.max(1, Math.trunc(limit))};`;

  const raw = await runPsqlQueryCapture(sourceDbUrl, sql);
  return raw.trim() ? parseSourceStorageObjectRows(raw) : [];
};

const resolveSourceObjectEnumerator = async (input: {
  sourceDbUrl: string;
  postProgress: ReturnType<typeof buildCallbackPoster>;
}): Promise<SourceStorageObjectEnumerator> => {
  await input.postProgress({
    level: "info",
    phase: "storage_copy.debug",
    message: "Counting source storage objects from the source database.",
    status: "running",
    data: {
      stage: "count_source_objects",
    },
  });

  try {
    const sourceObjectEnumerator = await createSourceStorageObjectEnumerator({
      countObjects: async () => countSourceStorageObjectsFromDb(input.sourceDbUrl),
      listObjects: async (bucketId, lastObjectPath, limit) =>
        listSourceStorageObjectsFromDb(input.sourceDbUrl, bucketId, lastObjectPath, limit),
      pageSize: STORAGE_OBJECT_QUERY_BATCH_SIZE,
    });
    await input.postProgress({
      level: "info",
      phase: "storage_copy.debug",
      message: `Counted ${sourceObjectEnumerator.exactTotalObjects ?? 0} source storage objects from the source database.`,
      status: "running",
      data: {
        stage: "count_source_objects",
        objects_total: sourceObjectEnumerator.exactTotalObjects ?? 0,
      },
    });
    return sourceObjectEnumerator;
  } catch (error) {
    const message =
      error instanceof Error ? sanitizeLogText(error.message) : "Unknown source DB query error.";
    logRuntime("error", "storage_copy.discovery_failed", {
      reason: message,
    });
    throw new RunnerError(`Source database storage discovery failed: ${message}`, {
      exitCode: 63,
      phase: "storage_copy.failed",
      failureClass: "storage_discovery_failed",
      failureHint: "Check source database access and storage.objects visibility.",
      eventData: {
        stage: "count_source_objects",
      },
    });
  }
};

const inspectSourceCloneTableCount = async (sourceDbUrl: string): Promise<number | null> => {
  const schemasArray = DATA_SCHEMAS.map(quoteSqlLiteral).join(", ");
  const excludedArray = EXCLUDED_TABLES.map(quoteSqlLiteral).join(", ");

  return await runCommandCapture(
    "psql",
    [
      sourceDbUrl,
      "--no-psqlrc",
      "-v",
      "ON_ERROR_STOP=1",
      "-Atqc",
      `SELECT COUNT(*)::int
       FROM information_schema.tables t
       WHERE t.table_type = 'BASE TABLE'
         AND t.table_schema = ANY(ARRAY[${schemasArray}])
         AND (t.table_schema || '.' || t.table_name) <> ALL(ARRAY[${excludedArray}]);`,
    ],
    buildPsqlEnv(),
  )
    .then((raw) => {
      const parsed = Number.parseInt(String(raw).trim(), 10);
      return Number.isFinite(parsed) ? parsed : null;
    })
    .catch(() => null);
};

const parseDbCloneStage = (line: string): DbCloneStage | null => {
  if (line.includes("[clone] dump schema")) return "dump_schema";
  if (line.includes("[clone] dump data")) return "dump_data";
  if (line.includes("[clone] restore schema")) return "restore_schema";
  if (line.includes("[clone] restore data")) return "restore_data";
  if (line.includes("[clone] completed")) return "completed";
  return null;
};

const runCloneProcess = async (
  sourceDbUrl: string,
  targetDbUrl: string,
  options?: {
    onStage?: (stage: DbCloneStage) => Promise<void> | void;
  },
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    logRuntime("info", "clone_process.started", {
      source_db_url: sourceDbUrl,
      target_db_url: targetDbUrl,
      log_verbosity: logVerbosity,
    });

    const child = spawn("/run-clone.sh", [], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SOURCE_DB_URL: sourceDbUrl,
        TARGET_DB_URL: targetDbUrl,
      },
    });

    let output = "";
    let lastStage: DbCloneStage | null = null;

    const handleStageText = (text: string) => {
      for (const rawLine of text.split(/\r?\n/)) {
        const stage = parseDbCloneStage(rawLine.trim());
        if (!stage || stage === lastStage) continue;
        lastStage = stage;
        void Promise.resolve(options?.onStage?.(stage)).catch((error) => {
          reject(error);
        });
      }
    };

    const flushStdout = attachSanitizedOutput(child.stdout, process.stdout, (text) => {
      output += text;
      handleStageText(text);
    });

    const flushStderr = attachSanitizedOutput(child.stderr, process.stderr, (text) => {
      output += text;
      handleStageText(text);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      flushStdout();
      flushStderr();

      logRuntime((code ?? 1) === 0 ? "info" : "warn", "clone_process.finished", {
        exit_code: code ?? 1,
        duration_ms: Date.now() - startedAt,
        last_stage: lastStage,
      });

      if ((code ?? 1) === 0) {
        resolve();
        return;
      }

      const raw = `${output}\nexit code: ${code ?? 1}`;
      const classified = classifyContainerFailure(raw);
      reject(
        new RunnerError(classified.message, {
          exitCode: classified.exitCode ?? code ?? 1,
          phase: "db_clone.failed",
          failureClass: classified.failureClass,
          failureHint: classified.hint,
          eventData: {
            monitor_exit_code: classified.exitCode ?? code ?? 1,
          },
        }),
      );
    });
  });
};

const runDownloadFlow = async () => {
  const sourceEdgeFunctionUrl = requiredEnv("SOURCE_EDGE_FUNCTION_URL");
  const sourceEdgeFunctionAccessKey = requiredEnv("SOURCE_EDGE_FUNCTION_ACCESS_KEY");
  const sourceProjectUrlOverride = optionalEnv("SOURCE_PROJECT_URL");
  const artifactOutputPath = requiredEnv("ARTIFACT_OUTPUT_PATH");
  const artifactFileName = path.basename(artifactOutputPath);
  const concurrency = Math.max(
    1,
    Math.trunc(
      Number.parseInt(
        optionalEnv("STORAGE_COPY_CONCURRENCY") ?? String(DEFAULT_STORAGE_JOB_CONCURRENCY),
        10,
      ) || DEFAULT_STORAGE_JOB_CONCURRENCY,
    ),
  );

  const postProgress = buildCallbackPoster();
  const resolvedSource = await resolveSourceFromEdgeFunction(
    sourceEdgeFunctionUrl,
    sourceEdgeFunctionAccessKey,
  );
  const sourceProjectUrl = sourceProjectUrlOverride ?? resolvedSource.sourceProjectUrl;
  const sourceTableCount = await inspectSourceCloneTableCount(resolvedSource.sourceDbUrl);
  const useLiveArtifactStream = parseIntegerEnv("ARTIFACT_LIVE_PORT", 0) > 0;

  await postProgress({
    level: "info",
    phase: "source_edge_function.resolved",
    message: "Resolved source DB URL and source admin key from source edge function.",
    data: {
      source_project_url: sourceProjectUrl,
      source_table_count: sourceTableCount,
    },
    debug_patch: {
      source_project_url: sourceProjectUrl,
      target_project_url: null,
      storage_copy_mode: "full",
      storage_copy_concurrency: concurrency,
    },
    status: "running",
  });

  if (useLiveArtifactStream) {
    await serveArtifactLiveStream(artifactFileName, postProgress, async (artifactWriter) => {
      await runDownloadArtifactExport(artifactWriter, {
        resolvedSource,
        sourceProjectUrl,
        concurrency,
        postProgress,
      });
    });
    return;
  }

  const artifactWriter = await ZipArtifactWriter.createFile(artifactOutputPath);
  try {
    await runDownloadArtifactExport(artifactWriter, {
      resolvedSource,
      sourceProjectUrl,
      concurrency,
      postProgress,
    });
    await finalizeZipArtifact(artifactWriter, {
      artifactFileName,
      artifactOutputPath,
      delivery: "filesystem",
    });
    await serveArtifactLiveFile(artifactOutputPath, postProgress);
  } catch (error) {
    artifactWriter.abort();
    throw error;
  }
};

const runStorageFlow = async () => {
  const sourceEdgeFunctionUrl = requiredEnv("SOURCE_EDGE_FUNCTION_URL");
  const sourceEdgeFunctionAccessKey = requiredEnv("SOURCE_EDGE_FUNCTION_ACCESS_KEY");
  const targetProjectUrl = requiredEnv("TARGET_PROJECT_URL");
  const targetAdminKey = requiredEnv("TARGET_ADMIN_KEY");
  const sourceProjectUrlOverride = optionalEnv("SOURCE_PROJECT_URL");
  const concurrency = Math.max(
    1,
    Math.trunc(
      Number.parseInt(
        optionalEnv("STORAGE_COPY_CONCURRENCY") ?? String(DEFAULT_STORAGE_JOB_CONCURRENCY),
        10,
      ) || DEFAULT_STORAGE_JOB_CONCURRENCY,
    ),
  );
  const skipExistingTargetObjects = asBooleanEnv(optionalEnv("SKIP_EXISTING_TARGET_OBJECTS"));
  const storageCopyMode = skipExistingTargetObjects ? "retry_skip_existing" : "full";

  const postProgress = buildCallbackPoster();
  const resolvedSource = await resolveSourceFromEdgeFunction(
    sourceEdgeFunctionUrl,
    sourceEdgeFunctionAccessKey,
  );
  const sourceProjectUrl = sourceProjectUrlOverride ?? resolvedSource.sourceProjectUrl;
  const sourceTableCount = await inspectSourceCloneTableCount(resolvedSource.sourceDbUrl);

  await postProgress({
    level: "info",
    phase: "source_edge_function.resolved",
    message: "Resolved source DB URL and source admin key from source edge function.",
    data: {
      source_project_url: sourceProjectUrl,
      source_table_count: sourceTableCount,
    },
    debug_patch: {
      source_project_url: sourceProjectUrl,
      target_project_url: targetProjectUrl,
      storage_copy_mode: storageCopyMode,
      storage_copy_concurrency: concurrency,
    },
    status: "running",
  });

  if (!resolvedSource.sourceAdminKey) {
    throw new RunnerError("Source edge function response is missing service_role_key.", {
      exitCode: 62,
      phase: "storage_copy.failed",
      failureClass: "source_admin_key_missing",
      failureHint: "Redeploy the migrate-helper that returns service_role_key and retry.",
    });
  }

  await postProgress({
    level: "info",
    phase: "storage_copy.started",
    message: "Storage copy started.",
    status: "running",
    data: {
      target_project_url: targetProjectUrl,
      source_project_url: sourceProjectUrl,
      concurrency,
      skip_existing_target_objects: skipExistingTargetObjects,
      storage_copy_mode: storageCopyMode,
    },
  });

  const sourceObjectEnumerator = await resolveSourceObjectEnumerator({
    sourceDbUrl: resolvedSource.sourceDbUrl,
    postProgress,
  });

  const summary = await runStorageCopyEngine({
    sourceProjectUrl,
    targetProjectUrl,
    sourceAdminKey: resolvedSource.sourceAdminKey,
    targetAdminKey,
    concurrency,
    skipExistingTargetObjects,
    sourceObjectEnumerator,
    onStage: async (stage) => {
      logRuntime("debug", "storage_copy.stage", {
        stage: stage.stage,
        ...stage.data,
      });
      await postProgress({
        level: "info",
        phase: "storage_copy.debug",
        message: stage.message,
        status: "running",
        data: {
          stage: stage.stage,
          ...stage.data,
        },
      });
    },
    onProgress: async (progress: StorageCopyProgress) => {
      logRuntime("debug", "storage_copy.progress", {
        bucket_id: progress.bucketId,
        prefix: progress.prefix,
        buckets_processed: progress.bucketsProcessed,
        buckets_total: progress.bucketsTotal,
        prefixes_scanned: progress.prefixesScanned,
        scan_complete: progress.scanComplete,
        objects_total: progress.objectsTotal,
        objects_copied: progress.objectsCopied,
        objects_failed: progress.objectsFailed,
        objects_skipped_existing: progress.objectsSkippedExisting,
        objects_skipped_missing: progress.objectsSkippedMissing,
      });
      await postProgress({
        level: "info",
        phase: "storage_copy.progress",
        message: "Storage copy in progress.",
        status: "running",
        data: {
          bucket_id: progress.bucketId,
          prefix: progress.prefix,
          buckets_processed: progress.bucketsProcessed,
          buckets_total: progress.bucketsTotal,
          prefixes_scanned: progress.prefixesScanned,
          scan_complete: progress.scanComplete,
          objects_total: progress.objectsTotal,
          objects_copied: progress.objectsCopied,
          objects_failed: progress.objectsFailed,
          objects_skipped_existing: progress.objectsSkippedExisting,
          objects_skipped_missing: progress.objectsSkippedMissing,
        },
      });
    },
  }).catch((error) => {
    const failureDetails = getStorageCopyFailureDetails(error);
    throw new RunnerError(asNonEmptyString((error as Error)?.message) ?? "Storage copy failed.", {
      exitCode: 63,
      phase: "storage_copy.failed",
      failureClass: "storage_copy_failed",
      failureHint: getStorageCopyFailureHint(failureDetails),
      eventData: toStorageFailureEventData(error),
    });
  });

  logRuntime("info", "storage_copy.summary", {
    bucket_ids: summary.bucketIds,
    buckets_total: summary.bucketsTotal,
    buckets_created: summary.bucketsCreated,
    objects_total: summary.objectsTotal,
    objects_copied: summary.objectsCopied,
    objects_failed: summary.objectsFailed,
    objects_skipped_existing: summary.objectsSkippedExisting,
    objects_skipped_missing: summary.objectsSkippedMissing,
    concurrency,
    skip_existing_target_objects: skipExistingTargetObjects,
    storage_copy_mode: storageCopyMode,
  });

  const outcomeMessage = buildStorageCopyOutcomeMessage(
    summary.objectsFailed,
    summary.objectsSkippedMissing,
    summary.objectsSkippedExisting,
  );
  const primaryFailure = summary.failedObjectSamples[0] ?? null;

  await postProgress({
    level: summary.objectsFailed > 0 ? "error" : "info",
    phase:
      summary.objectsFailed > 0
        ? "storage_copy.failed"
        : summary.objectsSkippedMissing > 0
          ? "storage_copy.partial"
          : "storage_copy.succeeded",
    message: outcomeMessage,
    status: summary.objectsFailed > 0 ? "failed" : "succeeded",
    finished_at: nowIso(),
    error: summary.objectsFailed > 0 ? outcomeMessage : null,
    debug_patch:
      summary.objectsFailed > 0
        ? {
            failure_class: "storage_copy_partial_failure",
            failure_hint: buildStorageCopyFailureHintWithRetry(primaryFailure),
            monitor_raw_error: sanitizeStoredLogText(primaryFailure?.message ?? outcomeMessage),
          }
        : undefined,
    data: buildStorageCopySummaryData(summary, {
      concurrency,
      skip_existing_target_objects: skipExistingTargetObjects,
      storage_copy_mode: storageCopyMode,
    }),
  });

  if (summary.objectsFailed > 0) {
    throw new RunnerError(outcomeMessage, {
      exitCode: 63,
      phase: "storage_copy.failed",
      failureClass: "storage_copy_partial_failure",
      failureHint: buildStorageCopyFailureHintWithRetry(primaryFailure),
      eventData: primaryFailure ? buildStorageFailureEventData(primaryFailure) : undefined,
      alreadyReported: true,
    });
  }
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const postCallback = async (callbackUrl: string, payload: CallbackPayload): Promise<void> => {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(callbackUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        if (attempt > 1 || logVerbosity === "debug") {
          logRuntime("info", "callback.delivered", {
            attempt,
            callback_url: callbackUrl,
            phase: payload.phase,
            response_status: response.status,
          });
        }
        return;
      }

      const text = await response.text().catch(() => "");
      lastError = new Error(text || `Callback failed with status ${response.status}`);
      logRuntime("warn", "callback.retry", {
        attempt,
        callback_url: callbackUrl,
        phase: payload.phase,
        response_status: response.status,
        error: text || `Callback failed with status ${response.status}`,
      });
    } catch (error) {
      lastError = error;
      logRuntime("warn", "callback.retry", {
        attempt,
        callback_url: callbackUrl,
        phase: payload.phase,
        error: error instanceof Error ? error.message : "unknown",
      });
    }

    if (attempt < 4) {
      await sleep(attempt * 750);
    }
  }

  throw new RunnerError("Progress callback delivery failed.", {
    exitCode: 64,
    phase: "export.failed",
    failureClass: "progress_callback_failed",
    failureHint: "Check exporter API callback reachability and retry.",
    eventData: {
      callback_error: lastError instanceof Error ? lastError.message : "unknown",
    },
  });
};

const buildCallbackPoster = () => {
  const callbackUrl = requiredEnv("PROGRESS_CALLBACK_URL");
  const callbackToken = requiredEnv("PROGRESS_CALLBACK_TOKEN");
  const runId = requiredEnv("RUN_ID");

  return async (body: Omit<CallbackPayload, "callback_token" | "run_id">): Promise<void> => {
    const sanitizedBody: Omit<CallbackPayload, "callback_token" | "run_id"> = {
      ...body,
      message: sanitizeLogText(body.message),
      error:
        body.error === undefined || body.error === null ? body.error : sanitizeLogText(body.error),
      data: body.data ? (sanitizeLogValue(body.data) as Record<string, unknown>) : undefined,
      debug_patch: body.debug_patch
        ? (sanitizeLogValue(body.debug_patch) as Record<string, unknown>)
        : undefined,
    };

    await postCallback(callbackUrl, {
      callback_token: callbackToken,
      run_id: runId,
      ...sanitizedBody,
    });
  };
};

const main = async (): Promise<void> => {
  const jobMode = requiredEnv("JOB_MODE");
  logRuntime("info", "runtime.started", {
    job_mode: jobMode,
    log_verbosity: logVerbosity,
  });
  if (jobMode === "download") {
    await runDownloadFlow();
    return;
  }

  if (jobMode === "storage") {
    await runStorageFlow();
    return;
  }

  if (jobMode !== "export") {
    throw new RunnerError(`Unsupported JOB_MODE: ${jobMode}`, {
      exitCode: 65,
      phase: "export.failed",
      failureClass: "runtime_config_invalid",
      failureHint: "Set JOB_MODE=export, JOB_MODE=storage, or JOB_MODE=download and retry.",
    });
  }

  const sourceEdgeFunctionUrl = requiredEnv("SOURCE_EDGE_FUNCTION_URL");
  const sourceEdgeFunctionAccessKey = requiredEnv("SOURCE_EDGE_FUNCTION_ACCESS_KEY");
  const targetDbUrl = requiredEnv("TARGET_DB_URL");
  const targetProjectUrl = requiredEnv("TARGET_PROJECT_URL");
  const targetAdminKey = requiredEnv("TARGET_ADMIN_KEY");
  const sourceProjectUrlOverride = optionalEnv("SOURCE_PROJECT_URL");
  const concurrency = Math.max(
    1,
    Math.trunc(
      Number.parseInt(
        optionalEnv("STORAGE_COPY_CONCURRENCY") ?? String(DEFAULT_STORAGE_JOB_CONCURRENCY),
        10,
      ) || DEFAULT_STORAGE_JOB_CONCURRENCY,
    ),
  );

  const postProgress = buildCallbackPoster();
  await postProgress({
    level: "info",
    phase: "target_validation.started",
    message: "Checking target database connection and empty state.",
    status: "running",
    data: {
      target_project_url: targetProjectUrl,
    },
  });
  const targetInspection = await inspectTargetDb(targetDbUrl);
  await postProgress({
    level: "info",
    phase: "target_validation.succeeded",
    message:
      targetInspection.publicRoutines > 0
        ? "Connected to target database. No blocking public tables or auth users found."
        : "Connected to target database. Database appears empty.",
    status: "running",
    data: {
      public_relations: targetInspection.publicRelations,
      public_routines: targetInspection.publicRoutines,
      public_routine_names: targetInspection.publicRoutineNames,
      auth_users: targetInspection.authUsers,
    },
    debug_patch: {
      target_project_url: targetProjectUrl,
    },
  });
  const resolvedSource = await resolveSourceFromEdgeFunction(
    sourceEdgeFunctionUrl,
    sourceEdgeFunctionAccessKey,
  );
  const sourceProjectUrl = sourceProjectUrlOverride ?? resolvedSource.sourceProjectUrl;
  const sourceTableCount = await inspectSourceCloneTableCount(resolvedSource.sourceDbUrl);

  await postProgress({
    level: "info",
    phase: "source_edge_function.resolved",
    message: "Resolved source DB URL and source admin key from source edge function.",
    data: {
      source_project_url: sourceProjectUrl,
      source_table_count: sourceTableCount,
    },
    debug_patch: {
      source_project_url: sourceProjectUrl,
      target_project_url: targetProjectUrl,
      storage_copy_mode: "full",
      storage_copy_concurrency: concurrency,
    },
    status: "running",
  });

  await postProgress({
    level: "info",
    phase: "db_clone.started",
    message: "Database clone started.",
    status: "running",
    data: {
      table_count: sourceTableCount,
    },
  });
  await runCloneProcess(resolvedSource.sourceDbUrl, targetDbUrl, {
    onStage: async (stage) => {
      const stageMessage =
        stage === "dump_schema"
          ? "Dumping source schema."
          : stage === "dump_data"
            ? "Dumping source table data."
            : stage === "restore_schema"
              ? "Restoring schema on target."
              : stage === "restore_data"
                ? "Restoring table data on target."
                : "Database clone completed.";

      await postProgress({
        level: "info",
        phase: "db_clone.progress",
        message: stageMessage,
        status: "running",
        data: {
          stage,
          table_count: sourceTableCount,
        },
      });
    },
  });
  await postProgress({
    level: "info",
    phase: "db_clone.succeeded",
    message: "Database clone completed.",
    status: "running",
    data: {
      table_count: sourceTableCount,
    },
  });

  if (!resolvedSource.sourceAdminKey) {
    throw new RunnerError("Source edge function response is missing service_role_key.", {
      exitCode: 62,
      phase: "storage_copy.failed",
      failureClass: "source_admin_key_missing",
      failureHint: "Redeploy the migrate-helper that returns service_role_key and retry.",
    });
  }

  await postProgress({
    level: "info",
    phase: "storage_copy.started",
    message: "Storage copy started.",
    status: "running",
    data: {
      target_project_url: targetProjectUrl,
      source_project_url: sourceProjectUrl,
      concurrency,
    },
  });

  const sourceObjectEnumerator = await resolveSourceObjectEnumerator({
    sourceDbUrl: resolvedSource.sourceDbUrl,
    postProgress,
  });

  const summary = await runStorageCopyEngine({
    sourceProjectUrl,
    targetProjectUrl,
    sourceAdminKey: resolvedSource.sourceAdminKey,
    targetAdminKey,
    concurrency,
    sourceObjectEnumerator,
    onStage: async (stage) => {
      logRuntime("debug", "storage_copy.stage", {
        stage: stage.stage,
        ...stage.data,
      });
      await postProgress({
        level: "info",
        phase: "storage_copy.debug",
        message: stage.message,
        status: "running",
        data: {
          stage: stage.stage,
          ...stage.data,
        },
      });
    },
    onProgress: async (progress: StorageCopyProgress) => {
      logRuntime("debug", "storage_copy.progress", {
        bucket_id: progress.bucketId,
        prefix: progress.prefix,
        buckets_processed: progress.bucketsProcessed,
        buckets_total: progress.bucketsTotal,
        prefixes_scanned: progress.prefixesScanned,
        scan_complete: progress.scanComplete,
        objects_total: progress.objectsTotal,
        objects_copied: progress.objectsCopied,
        objects_failed: progress.objectsFailed,
        objects_skipped_existing: progress.objectsSkippedExisting,
        objects_skipped_missing: progress.objectsSkippedMissing,
      });
      await postProgress({
        level: "info",
        phase: "storage_copy.progress",
        message: "Storage copy in progress.",
        status: "running",
        data: {
          bucket_id: progress.bucketId,
          prefix: progress.prefix,
          buckets_processed: progress.bucketsProcessed,
          buckets_total: progress.bucketsTotal,
          prefixes_scanned: progress.prefixesScanned,
          scan_complete: progress.scanComplete,
          objects_total: progress.objectsTotal,
          objects_copied: progress.objectsCopied,
          objects_failed: progress.objectsFailed,
          objects_skipped_existing: progress.objectsSkippedExisting,
          objects_skipped_missing: progress.objectsSkippedMissing,
        },
      });
    },
  }).catch((error) => {
    const failureDetails = getStorageCopyFailureDetails(error);
    throw new RunnerError(asNonEmptyString((error as Error)?.message) ?? "Storage copy failed.", {
      exitCode: 63,
      phase: "storage_copy.failed",
      failureClass: "storage_copy_failed",
      failureHint: getStorageCopyFailureHint(failureDetails),
      eventData: toStorageFailureEventData(error),
    });
  });

  logRuntime("info", "storage_copy.summary", {
    bucket_ids: summary.bucketIds,
    buckets_total: summary.bucketsTotal,
    buckets_created: summary.bucketsCreated,
    objects_total: summary.objectsTotal,
    objects_copied: summary.objectsCopied,
    objects_failed: summary.objectsFailed,
    objects_skipped_existing: summary.objectsSkippedExisting,
    objects_skipped_missing: summary.objectsSkippedMissing,
    concurrency,
  });

  const outcomeMessage = buildStorageCopyOutcomeMessage(
    summary.objectsFailed,
    summary.objectsSkippedMissing,
    summary.objectsSkippedExisting,
  );
  const primaryFailure = summary.failedObjectSamples[0] ?? null;

  await postProgress({
    level: summary.objectsFailed > 0 ? "error" : "info",
    phase:
      summary.objectsFailed > 0
        ? "storage_copy.failed"
        : summary.objectsSkippedMissing > 0
          ? "storage_copy.partial"
          : "storage_copy.succeeded",
    message: outcomeMessage,
    status: summary.objectsFailed > 0 ? "failed" : "running",
    error: summary.objectsFailed > 0 ? outcomeMessage : undefined,
    finished_at: summary.objectsFailed > 0 ? nowIso() : undefined,
    debug_patch:
      summary.objectsFailed > 0
        ? {
            failure_class: "storage_copy_partial_failure",
            failure_hint: buildStorageCopyFailureHintWithRetry(primaryFailure),
            monitor_raw_error: sanitizeStoredLogText(primaryFailure?.message ?? outcomeMessage),
          }
        : undefined,
    data: buildStorageCopySummaryData(summary, {
      concurrency,
    }),
  });

  if (summary.objectsFailed > 0) {
    throw new RunnerError(outcomeMessage, {
      exitCode: 63,
      phase: "storage_copy.failed",
      failureClass: "storage_copy_partial_failure",
      failureHint: buildStorageCopyFailureHintWithRetry(primaryFailure),
      eventData: primaryFailure ? buildStorageFailureEventData(primaryFailure) : undefined,
      alreadyReported: true,
    });
  }

  await postProgress({
    level: "info",
    phase: "export.succeeded",
    message: "DB clone and storage copy completed.",
    status: "succeeded",
    finished_at: nowIso(),
    error: null,
  });
};

main().catch(async (error: unknown) => {
  const runnerError =
    error instanceof RunnerError
      ? error
      : new RunnerError(error instanceof Error ? error.message : "Export failed.", {
          exitCode: 1,
          phase: "export.failed",
          failureClass: "unknown",
          failureHint: "Inspect runtime logs and retry.",
        });

  logRuntime("error", "runtime.failed", {
    phase: runnerError.phase,
    failure_class: runnerError.failureClass,
    exit_code: runnerError.exitCode,
    error: runnerError.message,
  });

  process.stderr.write(`${sanitizeLogText(runnerError.message)}\n`);

  try {
    if (!runnerError.alreadyReported) {
      const postProgress = buildCallbackPoster();
      await postProgress({
        level: "error",
        phase: runnerError.phase,
        message: sanitizeLogText(runnerError.message),
        status: "failed",
        error: sanitizeLogText(runnerError.message),
        finished_at: nowIso(),
        data: runnerError.eventData
          ? (sanitizeLogValue(runnerError.eventData) as Record<string, unknown>)
          : undefined,
        debug_patch: {
          failure_class: runnerError.failureClass,
          failure_hint: runnerError.failureHint,
          monitor_raw_error: sanitizeStoredLogText(runnerError.message),
          monitor_exit_code: runnerError.exitCode,
        },
      });
    }
  } catch {
    // Let the outer runtime mark failure from exit code.
  }

  process.exit(runnerError.exitCode);
});
