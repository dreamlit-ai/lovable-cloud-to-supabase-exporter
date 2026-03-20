import {
  classifyContainerFailure,
  summarizeDbUrl,
  type JobRecord,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core";
import { asErrorMessage, nowIso, type ExportInput } from "./inputs.js";
import { appendJobEvent, buildDefaultDebug, persistJob, readJob, startJob } from "./jobs.js";
import { buildContainerImage, runProcess } from "./utils.js";

export type ExportRunOptions = {
  dockerImage: string;
  containerContext: string;
  dockerfile: string;
  skipBuild: boolean;
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

export const runExport = async (
  jobId: string,
  input: ExportInput,
  options: ExportRunOptions,
): Promise<JobRecord> => {
  const hardTimeout = input.hardTimeoutSeconds ?? null;
  const boundedConcurrency = input.concurrency;

  let status = await startJob(
    jobId,
    buildDefaultDebug({
      task: "export",
      source: null,
      target: summarizeDbUrl(input.targetDbUrl),
      source_project_url: input.sourceProjectUrl,
      target_project_url: input.targetProjectUrl,
      hard_timeout_seconds: hardTimeout,
      storage_copy_mode: "full",
      storage_copy_concurrency: boundedConcurrency,
      container_start_invoked: false,
    }),
    {
      level: "info",
      phase: "export.started",
      message: "Combined DB + storage export started.",
      data: {
        hard_timeout_seconds: hardTimeout,
        storage_copy_concurrency: boundedConcurrency,
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
      "JOB_MODE=export",
      "-e",
      `JOB_ID=${jobId}`,
      "-e",
      `RUN_ID=${options.runId}`,
      "-e",
      `SOURCE_EDGE_FUNCTION_URL=${input.sourceEdgeFunctionUrl}`,
      "-e",
      `SOURCE_EDGE_FUNCTION_ACCESS_KEY=${input.sourceEdgeFunctionAccessKey}`,
      "-e",
      `TARGET_DB_URL=${input.targetDbUrl}`,
      "-e",
      `TARGET_PROJECT_URL=${input.targetProjectUrl}`,
      "-e",
      `TARGET_ADMIN_KEY=${input.targetAdminKey}`,
      "-e",
      `STORAGE_COPY_CONCURRENCY=${boundedConcurrency}`,
      "-e",
      `PROGRESS_CALLBACK_URL=${options.callbackUrl}`,
      "-e",
      `PROGRESS_CALLBACK_TOKEN=${options.callbackToken}`,
      "-e",
      "PGSSLMODE=require",
    ];

    if (input.sourceProjectUrl) {
      dockerArgs.push("-e", `SOURCE_PROJECT_URL=${input.sourceProjectUrl}`);
    }

    if (hardTimeout) {
      dockerArgs.push("-e", `HARD_TIMEOUT_SECONDS=${hardTimeout}`);
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

    const result = await runProcess("docker", dockerArgs, hardTimeout ?? undefined);

    if (result.code !== 0) {
      return finalizeIfCurrentRun(jobId, options.runId, async (current) => {
        if (current.status === "failed") return current;

        const raw = `${result.output}\nexit code: ${result.code}${
          result.timedOut ? "\nprocess timed out" : ""
        }`;
        const classified = classifyContainerFailure(raw);
        let next: JobRecord = {
          ...current,
          status: "failed",
          finished_at: nowIso(),
          error: current.error ?? classified.message,
          debug: current.debug
            ? {
                ...current.debug,
                monitor_raw_error: raw.trim(),
                monitor_exit_code: classified.exitCode,
                failure_class: current.debug.failure_class ?? classified.failureClass,
                failure_hint: current.debug.failure_hint ?? classified.hint,
              }
            : current.debug,
        };
        next = await appendJobEvent(jobId, next, {
          level: "error",
          phase: "export.failed",
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

      let next: JobRecord = {
        ...current,
        status: "succeeded",
        finished_at: nowIso(),
        error: null,
      };
      next = await appendJobEvent(jobId, next, {
        level: "info",
        phase: "export.succeeded",
        message: "DB clone and storage copy completed.",
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
        error: message || "Export failed.",
        debug: current.debug
          ? {
              ...current.debug,
              monitor_raw_error: message,
              failure_class: current.debug.failure_class ?? "local_runtime_error",
              failure_hint:
                current.debug.failure_hint ?? "Check Docker build/runtime output and retry.",
            }
          : current.debug,
      };
      next = await appendJobEvent(jobId, next, {
        level: "error",
        phase: "export.failed",
        message: "Combined export failed in local runtime.",
        data: {
          error: message,
        },
      });
      return next;
    });
  }
};
