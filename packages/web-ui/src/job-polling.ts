export type MigrationJobStatus = "idle" | "running" | "succeeded" | "failed";
export type MigrationJobTask = "db" | "storage" | "export" | "download";
export type MigrationStorageCopyMode = "full" | "off" | "retry_skip_existing";

export type MigrationJobEvent = {
  at: string;
  level: "info" | "warn" | "error";
  phase: string;
  message: string;
  data?: Record<string, unknown>;
};

export type MigrationJobRecord = {
  status: MigrationJobStatus;
  run_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  events: MigrationJobEvent[];
  debug: {
    task?: MigrationJobTask | null;
    storage_copy_mode?: MigrationStorageCopyMode | null;
    storage_copy_concurrency?: number | null;
    hard_timeout_seconds?: number | null;
    failure_class?: string | null;
    failure_hint?: string | null;
    monitor_raw_error?: string | null;
    error_excerpt?: string | null;
    restore_error_excerpt?: string | null;
    monitor_exit_code?: number | null;
  } | null;
};

export const JOB_POLL_INTERVAL_MS = 1200;
export const JOB_POLL_RECONNECT_TIMEOUT_MS = 2 * 60 * 1000;
const JOB_POLL_MAX_RETRY_DELAY_MS = 5_000;

export const JOB_POLL_CONNECTION_INTERRUPTED_MESSAGE =
  "Connection to the exporter was interrupted. The export may still be running. Reconnecting...";
export const JOB_POLL_CONNECTION_TIMEOUT_MESSAGE =
  "Connection to the exporter was interrupted for more than 2 minutes. The export may still be running. Check your connection, then retry or contact support.";

type PollSleep = (ms: number) => Promise<void>;

type PollJobStatusOptions = {
  getStatus: () => Promise<MigrationJobRecord>;
  onUpdate: (record: MigrationJobRecord) => void;
  onConnectionInterrupted?: (message: string) => void;
  onConnectionRestored?: () => void;
  intervalMs?: number;
  reconnectTimeoutMs?: number;
  sleep?: PollSleep;
  now?: () => number;
};

export type PollDownloadJobStatusOptions = PollJobStatusOptions & {
  isArtifactReady: (record: MigrationJobRecord) => boolean;
  onArtifactReady: (record: MigrationJobRecord) => void;
};

type PollStartedJobStatusOptions = Omit<PollJobStatusOptions, "onUpdate"> & {
  onUpdate?: (record: MigrationJobRecord) => void;
};

const defaultSleep: PollSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });

const isTerminalJobRecord = (record: MigrationJobRecord) =>
  record.status === "succeeded" || record.status === "failed";

const isEmptyIdleJobRecord = (record: MigrationJobRecord) =>
  record.status === "idle" &&
  !record.run_id &&
  !record.started_at &&
  !record.finished_at &&
  !record.error &&
  record.events.length === 0;

const getStatusPollRetryDelayMs = (failureCount: number, intervalMs: number) =>
  Math.min(JOB_POLL_MAX_RETRY_DELAY_MS, intervalMs * 2 ** Math.min(failureCount - 1, 2));

export const isTransientFetchError = (error: unknown) => {
  if (!(error instanceof TypeError)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("failed to fetch") ||
    message.includes("fetch failed") ||
    message.includes("networkerror") ||
    message.includes("load failed")
  );
};

const handleStatusPollError = async (
  error: unknown,
  state: {
    firstFailureAtMs: number | null;
    failureCount: number;
    intervalMs: number;
    reconnectTimeoutMs: number;
    sleep: PollSleep;
    now: () => number;
    onConnectionInterrupted?: (message: string) => void;
  },
) => {
  if (!isTransientFetchError(error)) {
    throw error;
  }

  const nowMs = state.now();
  state.firstFailureAtMs ??= nowMs;
  state.failureCount += 1;
  state.onConnectionInterrupted?.(JOB_POLL_CONNECTION_INTERRUPTED_MESSAGE);

  if (nowMs - state.firstFailureAtMs >= state.reconnectTimeoutMs) {
    throw new Error(JOB_POLL_CONNECTION_TIMEOUT_MESSAGE);
  }

  await state.sleep(getStatusPollRetryDelayMs(state.failureCount, state.intervalMs));
};

export async function pollJobStatusUntilComplete({
  getStatus,
  onUpdate,
  onConnectionInterrupted,
  onConnectionRestored,
  intervalMs = JOB_POLL_INTERVAL_MS,
  reconnectTimeoutMs = JOB_POLL_RECONNECT_TIMEOUT_MS,
  sleep = defaultSleep,
  now = () => Date.now(),
}: PollJobStatusOptions) {
  const retryState = {
    firstFailureAtMs: null as number | null,
    failureCount: 0,
    intervalMs,
    reconnectTimeoutMs,
    sleep,
    now,
    onConnectionInterrupted,
  };

  for (;;) {
    let record: MigrationJobRecord;
    try {
      record = await getStatus();
    } catch (error) {
      await handleStatusPollError(error, retryState);
      continue;
    }

    if (retryState.firstFailureAtMs !== null) {
      onConnectionRestored?.();
      retryState.firstFailureAtMs = null;
      retryState.failureCount = 0;
    }

    onUpdate(record);

    if (isTerminalJobRecord(record)) {
      return record;
    }

    await sleep(intervalMs);
  }
}

export async function pollStartedJobStatus({
  getStatus,
  onUpdate,
  onConnectionInterrupted,
  onConnectionRestored,
  intervalMs = JOB_POLL_INTERVAL_MS,
  reconnectTimeoutMs = JOB_POLL_RECONNECT_TIMEOUT_MS,
  sleep = defaultSleep,
  now = () => Date.now(),
}: PollStartedJobStatusOptions) {
  const retryState = {
    firstFailureAtMs: null as number | null,
    failureCount: 0,
    intervalMs,
    reconnectTimeoutMs,
    sleep,
    now,
    onConnectionInterrupted,
  };

  for (;;) {
    let record: MigrationJobRecord;
    try {
      record = await getStatus();
    } catch (error) {
      await handleStatusPollError(error, retryState);
      continue;
    }

    if (retryState.firstFailureAtMs !== null) {
      onConnectionRestored?.();
    }

    if (isEmptyIdleJobRecord(record)) {
      return null;
    }

    onUpdate?.(record);
    return record;
  }
}

export async function pollDownloadJobStatusUntilComplete({
  getStatus,
  onUpdate,
  onArtifactReady,
  isArtifactReady,
  onConnectionInterrupted,
  onConnectionRestored,
  intervalMs = JOB_POLL_INTERVAL_MS,
  reconnectTimeoutMs = JOB_POLL_RECONNECT_TIMEOUT_MS,
  sleep = defaultSleep,
  now = () => Date.now(),
}: PollDownloadJobStatusOptions) {
  let artifactReadyHandled = false;
  let lastRecord: MigrationJobRecord | null = null;
  const retryState = {
    firstFailureAtMs: null as number | null,
    failureCount: 0,
    intervalMs,
    reconnectTimeoutMs,
    sleep,
    now,
    onConnectionInterrupted,
  };

  for (;;) {
    let record: MigrationJobRecord;
    try {
      record = await getStatus();
    } catch (error) {
      if (lastRecord) {
        onUpdate(lastRecord);
      }
      await handleStatusPollError(error, retryState);
      continue;
    }

    if (retryState.firstFailureAtMs !== null) {
      onConnectionRestored?.();
      retryState.firstFailureAtMs = null;
      retryState.failureCount = 0;
    }

    lastRecord = record;
    onUpdate(record);

    if (!artifactReadyHandled && isArtifactReady(record)) {
      artifactReadyHandled = true;
      onArtifactReady(record);
    }

    if (isTerminalJobRecord(record)) {
      return record;
    }

    await sleep(intervalMs);
  }
}
