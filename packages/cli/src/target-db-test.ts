import {
  getDefaultPostgresSslMode,
  sanitizeStoredLogText,
  summarizeDbUrl,
  type JobRecord,
  withDefaultPostgresSslMode,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core";
import { asErrorMessage, nowIso, type TargetDbTestInput } from "./inputs.js";
import { appendJobEvent, buildDefaultDebug, readJob, startJob } from "./jobs.js";
import { runProcess } from "./utils.js";

export type TargetDbTestRunOptions = {
  dockerImage: string;
  containerContext: string;
  dockerfile: string;
  skipBuild: boolean;
  callbackUrl: string;
  callbackToken: string;
  runId: string;
};

const TARGET_DB_CONNECTION_MESSAGE = "Could not connect to the Supabase database.";
const TARGET_DB_CONNECTION_HINT =
  "Check the connection string and database password, then try again.";
const SUPABASE_DIRECT_IPV6_MESSAGE = "Supabase Direct connection requires IPv6.";
const SUPABASE_DIRECT_IPV6_HINT =
  "Use the Session pooler connection string from Supabase Connect, then try again.";

const isLikelySupabaseDirectIpv6Failure = (raw: string): boolean => {
  const lowered = raw.toLowerCase();
  return (
    lowered.includes("db.") &&
    lowered.includes("supabase.co") &&
    (lowered.includes("address not available") ||
      lowered.includes("could not translate host name") ||
      lowered.includes("nodename nor servname"))
  );
};

const getTargetDbConnectionFailure = (raw: string) =>
  isLikelySupabaseDirectIpv6Failure(raw)
    ? {
        message: SUPABASE_DIRECT_IPV6_MESSAGE,
        hint: SUPABASE_DIRECT_IPV6_HINT,
      }
    : {
        message: TARGET_DB_CONNECTION_MESSAGE,
        hint: TARGET_DB_CONNECTION_HINT,
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

const markTargetDbTestFailed = async ({
  jobId,
  runId,
  raw,
}: {
  jobId: string;
  runId: string;
  raw: string;
}): Promise<JobRecord> => {
  const failure = getTargetDbConnectionFailure(raw);
  return finalizeIfCurrentRun(jobId, runId, async (current) => {
    if (current.status === "failed") return current;

    let next: JobRecord = {
      ...current,
      status: "failed",
      finished_at: nowIso(),
      error: current.error ?? failure.message,
      debug: current.debug
        ? {
            ...current.debug,
            monitor_raw_error: sanitizeStoredLogText(raw),
            monitor_exit_code: 67,
            failure_class: current.debug.failure_class ?? "target_db_connection_failed",
            failure_hint: current.debug.failure_hint ?? failure.hint,
          }
        : current.debug,
    };
    next = await appendJobEvent(jobId, next, {
      level: "error",
      phase: "target_db_connection.failed",
      message: current.error ?? failure.message,
      data: {
        failure_class: "target_db_connection_failed",
        failure_hint: failure.hint,
        monitor_exit_code: 67,
      },
    });
    return next;
  });
};

export const runTargetDbTest = async (
  jobId: string,
  input: TargetDbTestInput,
  options: TargetDbTestRunOptions,
): Promise<JobRecord> => {
  const hardTimeout = input.hardTimeoutSeconds ?? 60;

  await startJob(
    jobId,
    buildDefaultDebug({
      task: "db",
      target: summarizeDbUrl(input.targetDbUrl),
      hard_timeout_seconds: hardTimeout,
      storage_copy_mode: "off",
      container_start_invoked: false,
    }),
    {
      level: "info",
      phase: "target_db_connection.started",
      message: "Testing Supabase database connection.",
      data: {
        statement: "SELECT 1",
        hard_timeout_seconds: hardTimeout,
      },
    },
    options.runId,
  );

  try {
    const targetDbUrl = withDefaultPostgresSslMode(input.targetDbUrl);
    const result = await runProcess(
      "psql",
      [targetDbUrl, "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-Atqc", "SELECT 1;"],
      hardTimeout,
      {
        env: {
          ...process.env,
          PGCONNECT_TIMEOUT: "10",
          PGSSLMODE: getDefaultPostgresSslMode(input.targetDbUrl),
        },
        streamOutput: true,
      },
    );

    if (result.code !== 0) {
      const raw = `${result.output}\nexit code: ${result.code}${
        result.timedOut ? "\nprocess timed out" : ""
      }`;
      return markTargetDbTestFailed({
        jobId,
        runId: options.runId,
        raw,
      });
    }

    if (!result.output.trim().split(/\s+/u).includes("1")) {
      return markTargetDbTestFailed({
        jobId,
        runId: options.runId,
        raw: result.output,
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
        phase: "target_db_connection.succeeded",
        message: "Connected to Supabase database.",
        data: {
          statement: "SELECT 1",
        },
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
        error: "Could not run the local database check.",
        debug: current.debug
          ? {
              ...current.debug,
              monitor_raw_error: sanitizeStoredLogText(message),
              failure_class: current.debug.failure_class ?? "local_runtime_error",
              failure_hint:
                current.debug.failure_hint ??
                "Check that psql is installed locally, then try again.",
            }
          : current.debug,
      };
      next = await appendJobEvent(jobId, next, {
        level: "error",
        phase: "target_db_connection.failed",
        message: "Supabase database connection test failed in local runtime.",
        data: {
          error: message,
        },
      });
      return next;
    });
  }
};
