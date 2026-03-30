import {
  classifyContainerFailure,
  sanitizeStoredLogText,
  summarizeDbUrl,
  type JobRecord,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core";
import { asErrorMessage, nowIso, type DbCloneInput } from "./inputs.js";
import { appendJobEvent, buildDefaultDebug, persistJob, startJob } from "./jobs.js";
import { resolveSourceFromEdgeFunction } from "./edge.js";
import { buildContainerImage, runProcess } from "./utils.js";

export type DbCloneRunOptions = {
  dockerImage: string;
  containerContext: string;
  dockerfile: string;
  skipBuild: boolean;
};

export const runDbClone = async (
  jobId: string,
  input: DbCloneInput,
  options: DbCloneRunOptions,
): Promise<JobRecord> => {
  const hardTimeout = input.hardTimeoutSeconds ?? null;
  const sourceEdgeFunctionUrl = input.sourceEdgeFunctionUrl;
  const sourceEdgeFunctionAccessKey = input.sourceEdgeFunctionAccessKey;
  const targetDbUrl = input.targetDbUrl;
  if (!input.confirmTargetBlank) {
    throw new Error(
      "Target DB must be blank before clone. Re-run with --confirm-target-blank after verifying target is empty.",
    );
  }

  let status = await startJob(
    jobId,
    buildDefaultDebug({
      task: "db",
      source: null,
      target: summarizeDbUrl(targetDbUrl),
      hard_timeout_seconds: hardTimeout,
      storage_copy_mode: "off",
      container_start_invoked: false,
    }),
    {
      level: "info",
      phase: "db_clone.started",
      message: "DB clone started.",
      data: {
        hard_timeout_seconds: hardTimeout,
        target_blank_required: true,
        source_mode: "edge_function",
      },
    },
  );

  try {
    const resolvedSource = await resolveSourceFromEdgeFunction({
      sourceEdgeFunctionUrl,
      sourceEdgeFunctionAccessKey,
    });
    const sourceDbUrl = resolvedSource.sourceDbUrl;

    status = {
      ...status,
      debug: status.debug
        ? {
            ...status.debug,
            source: summarizeDbUrl(sourceDbUrl),
          }
        : status.debug,
    };
    status = await persistJob(jobId, status);

    status = await appendJobEvent(jobId, status, {
      level: "info",
      phase: "source_edge_function.resolved",
      message: "Resolved source DB URL from source edge function.",
    });

    if (!options.skipBuild) {
      status = await appendJobEvent(jobId, status, {
        level: "info",
        phase: "container.build.started",
        message: "Building local clone runtime container.",
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
      "-e",
      `SOURCE_DB_URL=${sourceDbUrl}`,
      "-e",
      `TARGET_DB_URL=${targetDbUrl}`,
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

    const cloneResult = await runProcess("docker", dockerArgs, hardTimeout ?? undefined, {
      streamOutput: true,
    });
    if (cloneResult.code !== 0) {
      const raw = `${cloneResult.output}\nexit code: ${cloneResult.code}${
        cloneResult.timedOut ? "\nprocess timed out" : ""
      }`;
      const classified = classifyContainerFailure(raw);

      status = {
        ...status,
        status: "failed",
        finished_at: nowIso(),
        error: classified.message,
        debug: status.debug
          ? {
              ...status.debug,
              monitor_raw_error: sanitizeStoredLogText(raw),
              monitor_exit_code: classified.exitCode,
              failure_class: classified.failureClass,
              failure_hint: classified.hint,
            }
          : status.debug,
      };
      status = await appendJobEvent(jobId, status, {
        level: "error",
        phase: "db_clone.failed",
        message: classified.message,
        data: {
          failure_class: classified.failureClass,
          failure_hint: classified.hint,
          monitor_exit_code: classified.exitCode,
        },
      });
      return status;
    }

    status = {
      ...status,
      status: "succeeded",
      finished_at: nowIso(),
      error: null,
    };
    status = await appendJobEvent(jobId, status, {
      level: "info",
      phase: "db_clone.succeeded",
      message: "DB clone completed.",
    });
    return status;
  } catch (error) {
    const message = asErrorMessage(error);
    const sourceResolved = Boolean(status.debug?.source);
    const sourceEdgeResolutionFailure = !sourceResolved;
    const failureClass = sourceEdgeResolutionFailure
      ? "source_edge_function_resolve_failed"
      : "local_runtime_error";
    const failureHint = sourceEdgeResolutionFailure
      ? "Check source edge function URL/access key and function response shape."
      : "Check Docker build/runtime output and retry.";
    const failureEventMessage = sourceEdgeResolutionFailure
      ? "DB clone failed while resolving source edge function."
      : "DB clone failed in local runtime.";
    status = {
      ...status,
      status: "failed",
      finished_at: nowIso(),
      error: message || "DB clone failed.",
      debug: status.debug
        ? {
            ...status.debug,
            monitor_raw_error: sanitizeStoredLogText(message),
            failure_class: failureClass,
            failure_hint: failureHint,
          }
        : status.debug,
    };
    status = await appendJobEvent(jobId, status, {
      level: "error",
      phase: "db_clone.failed",
      message: failureEventMessage,
      data: {
        error: message,
      },
    });
    return status;
  }
};
