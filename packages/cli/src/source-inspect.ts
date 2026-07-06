import {
  buildFailureDiagnostics,
  classifyContainerFailure,
  sanitizeStoredLogText,
  type JobRecord,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core";
import { asErrorMessage, nowIso, type SourceInspectInput } from "./inputs.js";
import { appendJobEvent, buildDefaultDebug, persistJob, readJob, startJob } from "./jobs.js";
import type { DockerRuntimeOptions } from "./runtime-options.js";
import { buildContainerImage, runProcess } from "./utils.js";

export type SourceInspectRunOptions = DockerRuntimeOptions & {
  callbackUrl: string;
  callbackToken: string;
  runId: string;
};

const DEFAULT_SOURCE_INSPECT_TIMEOUT_SECONDS = 300;

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

// Runs the container runtime in inspect-only mode: measures the source
// project (app table count, storage object count) without touching any
// target. The container posts the counts through the progress callback as a
// source_inspect.succeeded event.
export const runSourceInspect = async (
  jobId: string,
  input: SourceInspectInput,
  options: SourceInspectRunOptions,
): Promise<JobRecord> => {
  const hardTimeout = input.hardTimeoutSeconds ?? DEFAULT_SOURCE_INSPECT_TIMEOUT_SECONDS;

  let status = await startJob(
    jobId,
    buildDefaultDebug({
      task: "db",
      hard_timeout_seconds: hardTimeout,
      storage_copy_mode: "off",
      container_start_invoked: false,
    }),
    {
      level: "info",
      phase: "source_inspect.started",
      message: "Measuring the Lovable Cloud project.",
      data: {
        hard_timeout_seconds: hardTimeout,
      },
    },
    options.runId,
  );

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

    const dockerArgs = [
      "run",
      "--rm",
      "--add-host",
      "host.docker.internal:host-gateway",
      "-e",
      "JOB_MODE=source-inspect",
      "-e",
      `JOB_ID=${jobId}`,
      "-e",
      `RUN_ID=${options.runId}`,
      "-e",
      `SOURCE_EDGE_FUNCTION_URL=${input.sourceEdgeFunctionUrl}`,
      "-e",
      `SOURCE_EDGE_FUNCTION_ACCESS_KEY=${input.sourceEdgeFunctionAccessKey}`,
      "-e",
      `PROGRESS_CALLBACK_URL=${options.callbackUrl}`,
      "-e",
      `PROGRESS_CALLBACK_TOKEN=${options.callbackToken}`,
      "-e",
      "PGSSLMODE=require",
    ];

    if (process.env.LOG_VERBOSITY?.trim()) {
      dockerArgs.push("-e", `LOG_VERBOSITY=${process.env.LOG_VERBOSITY.trim()}`);
    }

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

    const result = await runProcess("docker", dockerArgs, hardTimeout, {
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
          phase: "source_inspect.failed",
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

    return finalizeIfCurrentRun(jobId, options.runId, async (current) => {
      if (current.status === "succeeded") return current;
      if (current.status === "failed") return current;

      // The container already appended source_inspect.succeeded with the
      // measured counts through the callback; only the status needs closing.
      return persistJob(jobId, {
        ...current,
        status: "succeeded",
        finished_at: nowIso(),
        error: null,
      });
    });
  } catch (error) {
    const message = asErrorMessage(error);
    return finalizeIfCurrentRun(jobId, options.runId, async (current) => {
      if (current.status === "failed") return current;

      let next: JobRecord = {
        ...current,
        status: "failed",
        finished_at: nowIso(),
        error: message || "Source inspection failed.",
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
        phase: "source_inspect.failed",
        message: "Source inspection failed in local runtime.",
        data: {
          error: message,
        },
      });
      return next;
    });
  }
};
