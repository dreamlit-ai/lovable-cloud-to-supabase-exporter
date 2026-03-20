import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { classifyContainerFailure } from "@dreamlit/lovable-cloud-to-supabase-exporter-core";
import {
  runStorageCopyEngine,
  type StorageCopyProgress,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core/storage-copy";
import {
  runStorageExportEngine,
  type StorageExportProgress,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core/storage-export";

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
};

class RunnerError extends Error {
  exitCode: number;
  phase: string;
  failureClass: string;
  failureHint: string;
  eventData?: Record<string, unknown>;

  constructor(message: string, options: RunnerErrorOptions) {
    super(message);
    this.exitCode = options.exitCode;
    this.phase = options.phase;
    this.failureClass = options.failureClass;
    this.failureHint = options.failureHint;
    this.eventData = options.eventData;
  }
}

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

const runCommand = async (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<void> => {
  await runCommandCapture(command, args, env, cwd);
};

const runCommandCapture = async (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<string> => {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      cwd,
    });

    let output = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      process.stderr.write(text);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if ((code ?? 1) === 0) {
        resolve(output.trim());
        return;
      }
      reject(new Error(`${output}\nexit code: ${code ?? 1}`.trim()));
    });
  });
};

const dumpSourceSchemaAndData = async (sourceDbUrl: string, exportRoot: string): Promise<void> => {
  const dbDir = path.join(exportRoot, "db");
  const rawSchemaPath = path.join(dbDir, "schema.raw.sql");
  const schemaPath = path.join(dbDir, "schema.sql");
  const dataPath = path.join(dbDir, "data.sql");
  await mkdir(dbDir, { recursive: true });

  await runCommand(
    "pg_dump",
    [
      sourceDbUrl,
      "--format=plain",
      "--schema-only",
      `--schema=${APP_SCHEMA}`,
      "--no-owner",
      "--no-acl",
      `--file=${rawSchemaPath}`,
    ],
    process.env,
  ).catch((error) => {
    throw new RunnerError(error instanceof Error ? error.message : "Schema dump failed.", {
      exitCode: 41,
      phase: "db_clone.failed",
      failureClass: "source_schema_dump_failed",
      failureHint: "Verify source DB reachability and pg_dump permissions.",
    });
  });

  const rawSchema = await readFile(rawSchemaPath, "utf8");
  const filteredSchema = rawSchema
    .split("\n")
    .filter(
      (line) =>
        line !== "CREATE SCHEMA public;" && !line.startsWith("COMMENT ON SCHEMA public IS "),
    )
    .join("\n");
  await writeFile(schemaPath, filteredSchema, "utf8");

  const dataArgs = [
    sourceDbUrl,
    "--format=plain",
    "--data-only",
    ...DATA_SCHEMAS.map((schema) => `--schema=${schema}`),
    ...EXCLUDED_TABLES.map((table) => `--exclude-table=${table}`),
    "--no-owner",
    "--no-acl",
    `--file=${dataPath}`,
  ];

  await runCommand("pg_dump", dataArgs, process.env).catch((error) => {
    throw new RunnerError(error instanceof Error ? error.message : "Data dump failed.", {
      exitCode: 42,
      phase: "db_clone.failed",
      failureClass: "source_data_dump_failed",
      failureHint: "Verify source DB permissions and pg_dump connectivity.",
    });
  });

  await writeFile(
    path.join(exportRoot, "manifest.json"),
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
    )}\n`,
    "utf8",
  );
};

const createZipArchive = async (exportRoot: string, artifactOutputPath: string): Promise<void> => {
  await mkdir(path.dirname(artifactOutputPath), { recursive: true });
  await runCommand("zip", ["-rq", artifactOutputPath, "."], process.env, exportRoot).catch(
    (error) => {
      throw new RunnerError(
        error instanceof Error ? error.message : "ZIP archive creation failed.",
        {
          exitCode: 66,
          phase: "download.failed",
          failureClass: "artifact_archive_failed",
          failureHint: "Retry the ZIP export. If it persists, inspect runtime logs.",
        },
      );
    },
  );
};

const parseIntegerEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(optionalEnv(name) ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
};

const serveArtifactLive = async (
  artifactPath: string,
  postProgress: ReturnType<typeof buildCallbackPoster>,
): Promise<void> => {
  const port = parseIntegerEnv("ARTIFACT_LIVE_PORT", 0);
  if (port <= 0) {
    await postProgress({
      level: "info",
      phase: "download.succeeded",
      message: "ZIP export completed.",
      status: "succeeded",
      finished_at: nowIso(),
      error: null,
    });
    return;
  }

  const timeoutSeconds = parseIntegerEnv(
    "ARTIFACT_LIVE_TIMEOUT_SECONDS",
    DEFAULT_ARTIFACT_LIVE_TIMEOUT_SECONDS,
  );
  const artifactInfo = await stat(artifactPath);
  const fileName = path.basename(artifactPath);

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
      void postProgress({
        level: "info",
        phase: "download.succeeded",
        message: "ZIP export completed.",
        status: "succeeded",
        finished_at: nowIso(),
        error: null,
        data: {
          artifact_file_name: fileName,
          artifact_total_size: artifactInfo.size,
          artifact_delivery: "live",
        },
      }).catch((error) => {
        clearTimeout(timeoutId);
        server.close(() => {
          reject(error instanceof Error ? error : new Error("Progress callback failed."));
        });
      });
    });
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
          "Check the target connection string, postgres password, and network reachability, then retry.",
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

  return inspection;
};

const quoteSqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

const inspectSourceCloneTableCount = async (sourceDbUrl: string): Promise<number | null> => {
  const psqlEnv = {
    ...process.env,
    PGCONNECT_TIMEOUT: "10",
  };

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
    psqlEnv,
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

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      process.stdout.write(text);
      handleStageText(text);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      process.stderr.write(text);
      handleStageText(text);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
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
  const concurrency = Math.max(
    1,
    Math.trunc(Number.parseInt(optionalEnv("STORAGE_COPY_CONCURRENCY") ?? "8", 10) || 8),
  );
  const exportRoot = "/tmp/source-export";

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
      target_project_url: null,
      storage_copy_mode: "full",
      storage_copy_concurrency: concurrency,
    },
    status: "running",
  });

  await postProgress({
    level: "info",
    phase: "db_clone.started",
    message: "Database export started.",
    status: "running",
  });
  await dumpSourceSchemaAndData(resolvedSource.sourceDbUrl, exportRoot);
  await postProgress({
    level: "info",
    phase: "db_clone.succeeded",
    message: "Database export completed.",
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
    message: "Storage export started.",
    status: "running",
    data: {
      source_project_url: sourceProjectUrl,
      concurrency,
    },
  });

  const summary = await runStorageExportEngine({
    sourceProjectUrl,
    sourceAdminKey: resolvedSource.sourceAdminKey,
    exportDir: exportRoot,
    concurrency,
    onStage: async (stage) => {
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
    onProgress: async (progress: StorageExportProgress) => {
      await postProgress({
        level: "info",
        phase: "storage_copy.progress",
        message: "Storage export in progress.",
        status: "running",
        data: {
          bucket_id: progress.bucketId,
          prefix: progress.prefix,
          buckets_processed: progress.bucketsProcessed,
          buckets_total: progress.bucketsTotal,
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

  await postProgress({
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
      concurrency,
    },
  });

  await createZipArchive(exportRoot, artifactOutputPath);
  await serveArtifactLive(artifactOutputPath, postProgress);
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
      if (response.ok) return;

      const text = await response.text().catch(() => "");
      lastError = new Error(text || `Callback failed with status ${response.status}`);
    } catch (error) {
      lastError = error;
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
    await postCallback(callbackUrl, {
      callback_token: callbackToken,
      run_id: runId,
      ...body,
    });
  };
};

const main = async (): Promise<void> => {
  const jobMode = requiredEnv("JOB_MODE");
  if (jobMode === "download") {
    await runDownloadFlow();
    return;
  }

  if (jobMode !== "export") {
    throw new RunnerError(`Unsupported JOB_MODE: ${jobMode}`, {
      exitCode: 65,
      phase: "export.failed",
      failureClass: "runtime_config_invalid",
      failureHint: "Set JOB_MODE=export or JOB_MODE=download and retry.",
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
    Math.trunc(Number.parseInt(optionalEnv("STORAGE_COPY_CONCURRENCY") ?? "8", 10) || 8),
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

  const summary = await runStorageCopyEngine({
    sourceProjectUrl,
    targetProjectUrl,
    sourceAdminKey: resolvedSource.sourceAdminKey,
    targetAdminKey,
    concurrency,
    onStage: async (stage) => {
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
          objects_total: progress.objectsTotal,
          objects_copied: progress.objectsCopied,
          objects_skipped_missing: progress.objectsSkippedMissing,
        },
      });
    },
  }).catch((error) => {
    throw new RunnerError(asNonEmptyString((error as Error)?.message) ?? "Storage copy failed.", {
      exitCode: 63,
      phase: "storage_copy.failed",
      failureClass: "storage_copy_failed",
      failureHint: "Check source admin key, target admin key, and bucket/object permissions.",
    });
  });

  await postProgress({
    level: "info",
    phase: summary.objectsSkippedMissing > 0 ? "storage_copy.partial" : "storage_copy.succeeded",
    message:
      summary.objectsSkippedMissing > 0
        ? "Storage copy completed with missing objects skipped."
        : "Storage copy completed.",
    status: "running",
    data: {
      bucket_ids: summary.bucketIds,
      buckets_total: summary.bucketsTotal,
      buckets_created: summary.bucketsCreated,
      objects_total: summary.objectsTotal,
      objects_copied: summary.objectsCopied,
      objects_skipped_missing: summary.objectsSkippedMissing,
      concurrency,
    },
  });

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

  process.stderr.write(`${runnerError.message}\n`);

  try {
    const postProgress = buildCallbackPoster();
    await postProgress({
      level: "error",
      phase: runnerError.phase,
      message: runnerError.message,
      status: "failed",
      error: runnerError.message,
      finished_at: nowIso(),
      data: runnerError.eventData,
      debug_patch: {
        failure_class: runnerError.failureClass,
        failure_hint: runnerError.failureHint,
        monitor_raw_error: runnerError.message,
        monitor_exit_code: runnerError.exitCode,
      },
    });
  } catch {
    // Let the outer runtime mark failure from exit code.
  }

  process.exit(runnerError.exitCode);
});
