import {
  buildFailureDiagnostics,
  classifyContainerFailure,
  sanitizeStoredLogText,
  type JobRecord,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core";
import { asErrorMessage, nowIso, type DownloadInput } from "./inputs.js";
import { appendJobEvent, buildDefaultDebug, persistJob, readJob, startJob } from "./jobs.js";
import { artifactFileName, ensureCleanArtifactDir, artifactExists } from "./artifacts.js";
import type { DockerRuntimeOptions } from "./runtime-options.js";
import {
  appendDockerEnvIfSet,
  buildContainerImage,
  ensureDualStackDockerNetwork,
  runProcess,
} from "./utils.js";

export type DownloadRunOptions = DockerRuntimeOptions & {
  callbackUrl: string;
  callbackToken: string;
  runId: string;
};

const finalizeIfCurrentRun = async (
  jobId: string,
  runId: string,
  updater: (current: JobRecord) => Promise<JobRecord> | JobRecord,
): Promise<JobRecord> => {
  const current = await readJob(jobId);
  if (current.run_id !== runId) {
    return current;
  }
  return updater(current);
};

export const runDownload = async (
  jobId: string,
  input: DownloadInput,
  options: DownloadRunOptions,
): Promise<JobRecord> => {
  const hardTimeout = input.hardTimeoutSeconds ?? null;
  const boundedConcurrency = input.concurrency;
  const isPostgresUrlSource = input.sourceType === "postgres_url";

  let status = await startJob(
    jobId,
    buildDefaultDebug({
      task: "download",
      source: null,
      target: null,
      source_project_url: input.sourceProjectUrl,
      target_project_url: null,
      hard_timeout_seconds: hardTimeout,
      storage_copy_mode: isPostgresUrlSource ? "off" : "full",
      storage_copy_concurrency: boundedConcurrency,
      container_start_invoked: false,
    }),
    {
      level: "info",
      phase: "download.started",
      message: isPostgresUrlSource ? "Postgres ZIP export started." : "ZIP export started.",
      data: {
        hard_timeout_seconds: hardTimeout,
        storage_copy_concurrency: boundedConcurrency,
        source_type: input.sourceType,
      },
    },
    options.runId,
  );

  const artifactDir = await ensureCleanArtifactDir(jobId);

  try {
    if (!options.skipBuild) {
      status = await appendJobEvent(jobId, status, {
        level: "info",
        phase: "container.build.started",
        message: "Building local export runtime container.",
        data: {
          image: options.dockerImage,
          context: options.containerContext,
          dockerfile: options.dockerfile,
        },
      });
      await buildContainerImage(options.dockerImage, options.containerContext, options.dockerfile);
      status = await appendJobEvent(jobId, status, {
        level: "info",
        phase: "container.build.succeeded",
        message: "Container build completed.",
      });
    }

    const dockerNetwork = await ensureDualStackDockerNetwork();
    const dockerArgs = [
      "run",
      "--rm",
      ...(dockerNetwork ? ["--network", dockerNetwork] : []),
      "--add-host",
      "host.docker.internal:host-gateway",
      "-v",
      `${artifactDir}:/artifacts`,
      "-e",
      "JOB_MODE=download",
      "-e",
      `JOB_ID=${jobId}`,
      "-e",
      `RUN_ID=${options.runId}`,
      "-e",
      `STORAGE_COPY_CONCURRENCY=${boundedConcurrency}`,
      "-e",
      `PROGRESS_CALLBACK_URL=${options.callbackUrl}`,
      "-e",
      `PROGRESS_CALLBACK_TOKEN=${options.callbackToken}`,
      "-e",
      `ARTIFACT_OUTPUT_PATH=/artifacts/${artifactFileName(jobId)}`,
      "-e",
      "PGSSLMODE=require",
    ];

    if (isPostgresUrlSource) {
      if (!input.sourceDbUrl) {
        throw new Error("source_db_url is required for source_type=postgres_url.");
      }
      dockerArgs.push("-e", "SOURCE_TYPE=postgres_url", "-e", `SOURCE_DB_URL=${input.sourceDbUrl}`);
    } else {
      if (!input.sourceEdgeFunctionUrl || !input.sourceEdgeFunctionAccessKey) {
        throw new Error("Lovable ZIP export fields are missing after validation.");
      }
      dockerArgs.push(
        "-e",
        "SOURCE_TYPE=lovable_edge_function",
        "-e",
        `SOURCE_EDGE_FUNCTION_URL=${input.sourceEdgeFunctionUrl}`,
        "-e",
        `SOURCE_EDGE_FUNCTION_ACCESS_KEY=${input.sourceEdgeFunctionAccessKey}`,
      );
    }

    if (input.sourceProjectUrl) {
      dockerArgs.push("-e", `SOURCE_PROJECT_URL=${input.sourceProjectUrl}`);
    }

    if (input.excludeDataTables.length > 0) {
      dockerArgs.push("-e", `EXCLUDE_DATA_TABLES=${input.excludeDataTables.join(",")}`);
    }

    if (hardTimeout) {
      dockerArgs.push("-e", `HARD_TIMEOUT_SECONDS=${hardTimeout}`);
    }
    if (process.env.LOG_VERBOSITY?.trim()) {
      dockerArgs.push("-e", `LOG_VERBOSITY=${process.env.LOG_VERBOSITY.trim()}`);
    }
    appendDockerEnvIfSet(dockerArgs, "SUPABASE_SESSION_POOLER_HOSTS");

    dockerArgs.push(options.dockerImage);

    status = {
      ...status,
      debug: status.debug
        ? {
            ...status.debug,
            container_start_invoked: true,
          }
        : status.debug,
    };
    status = await persistJob(jobId, status);

    const result = await runProcess("docker", dockerArgs, hardTimeout ?? undefined, {
      streamOutput: true,
    });

    if (result.code !== 0) {
      return finalizeIfCurrentRun(jobId, options.runId, async (current) => {
        if (current.status === "failed") return current;

        const raw = `${result.output}\nexit code: ${result.code}${
          result.timedOut ? "\nprocess timed out" : ""
        }`;
        const classified = classifyContainerFailure(raw);
        const diagnostics = buildFailureDiagnostics(raw, { exitCode: classified.exitCode });
        let next: JobRecord = {
          ...current,
          status: "failed",
          finished_at: nowIso(),
          error: current.error ?? classified.message,
          debug: current.debug
            ? {
                ...current.debug,
                ...diagnostics,
                failure_class: current.debug.failure_class ?? classified.failureClass,
                failure_hint: current.debug.failure_hint ?? classified.hint,
              }
            : current.debug,
        };
        next = await appendJobEvent(jobId, next, {
          level: "error",
          phase: "download.failed",
          message: current.error ?? classified.message,
          data: {
            failure_class: classified.failureClass,
            failure_hint: classified.hint,
            monitor_exit_code: classified.exitCode,
          },
        });
        return next;
      });
    }

    if (!(await artifactExists(jobId))) {
      return finalizeIfCurrentRun(jobId, options.runId, async (current) => {
        let next: JobRecord = {
          ...current,
          status: "failed",
          finished_at: nowIso(),
          error: "ZIP export finished without producing an artifact.",
          debug: current.debug
            ? {
                ...current.debug,
                failure_class: current.debug.failure_class ?? "artifact_missing",
                failure_hint:
                  current.debug.failure_hint ??
                  "Retry the ZIP export. If it persists, inspect container logs.",
              }
            : current.debug,
        };
        next = await appendJobEvent(jobId, next, {
          level: "error",
          phase: "download.failed",
          message: "ZIP export finished without producing an artifact.",
        });
        return next;
      });
    }

    return finalizeIfCurrentRun(jobId, options.runId, async (current) => {
      if (current.status === "succeeded") return current;
      if (current.status === "failed") return current;

      let next: JobRecord = {
        ...current,
        status: "succeeded",
        finished_at: nowIso(),
        error: null,
      };
      next = await appendJobEvent(jobId, next, {
        level: "info",
        phase: "download.succeeded",
        message: "ZIP export completed.",
      });
      return next;
    });
  } catch (error) {
    const message = asErrorMessage(error);
    return finalizeIfCurrentRun(jobId, options.runId, async (current) => {
      if (current.status === "failed") return current;

      let next: JobRecord = {
        ...current,
        status: "failed",
        finished_at: nowIso(),
        error: message || "ZIP export failed.",
        debug: current.debug
          ? {
              ...current.debug,
              monitor_raw_error: sanitizeStoredLogText(message),
              failure_class: current.debug.failure_class ?? "local_runtime_error",
              failure_hint:
                current.debug.failure_hint ?? "Check Docker build/runtime output and retry.",
            }
          : current.debug,
      };
      next = await appendJobEvent(jobId, next, {
        level: "error",
        phase: "download.failed",
        message: "ZIP export failed in local runtime.",
        data: {
          error: message,
        },
      });
      return next;
    });
  }
};
