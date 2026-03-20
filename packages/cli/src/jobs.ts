import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  JobDebug,
  JobEvent,
  JobRecord,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core";
import { nowIso } from "./inputs.js";
import { DEFAULT_STORAGE_COPY_CONCURRENCY, MAX_EVENTS } from "./utils.js";

const JOBS_ROOT = path.join(os.homedir(), ".lovable-cloud-to-supabase-exporter", "jobs");
const JOB_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;
const jobWriteQueues = new Map<string, Promise<void>>();

export const isValidJobId = (jobId: string): boolean => JOB_ID_PATTERN.test(jobId);

const assertValidJobId = (jobId: string): string => {
  if (isValidJobId(jobId)) return jobId;
  throw new Error("invalid_job_id");
};

export const defaultJobRecord = (): JobRecord => ({
  status: "idle",
  run_id: null,
  started_at: null,
  finished_at: null,
  error: null,
  events: [],
  debug: null,
});

export const buildDefaultDebug = (overrides: Partial<JobDebug> = {}): JobDebug => ({
  task: null,
  source: null,
  target: null,
  source_project_url: null,
  target_project_url: null,
  storage_copy_concurrency: DEFAULT_STORAGE_COPY_CONCURRENCY,
  data_restore_mode: "replace",
  storage_copy_mode: "off",
  hard_timeout_seconds: null,
  pgsslmode: "require",
  container_start_invoked: false,
  monitor_raw_error: null,
  monitor_exit_code: null,
  failure_class: null,
  failure_hint: null,
  ...overrides,
});

const pruneJobEvents = (events: JobEvent[]): JobEvent[] => {
  if (events.length <= MAX_EVENTS) return events;

  const maxProgressEvents = Math.floor(MAX_EVENTS / 2);
  const retainedProgressIndices = new Set(
    events
      .map((event, index) => (event.phase.endsWith(".progress") ? index : -1))
      .filter((index) => index >= 0)
      .slice(-maxProgressEvents),
  );

  const filtered = events.filter(
    (event, index) => !event.phase.endsWith(".progress") || retainedProgressIndices.has(index),
  );

  return filtered.length <= MAX_EVENTS ? filtered : filtered.slice(-MAX_EVENTS);
};

export const pushEvent = (
  record: JobRecord,
  event: Omit<JobEvent, "at"> & { at?: string },
): JobRecord => ({
  ...record,
  events: pruneJobEvents([...record.events, { at: event.at ?? nowIso(), ...event }]),
});

export const persistJob = async (jobId: string, record: JobRecord): Promise<JobRecord> => {
  await writeJob(jobId, record);
  return record;
};

export const appendJobEvent = async (
  jobId: string,
  record: JobRecord,
  event: Omit<JobEvent, "at"> & { at?: string },
): Promise<JobRecord> => {
  return persistJob(jobId, pushEvent(record, event));
};

export const startJob = async (
  jobId: string,
  debug: JobDebug,
  event: Omit<JobEvent, "at"> & { at?: string },
  runId?: string,
): Promise<JobRecord> => {
  return appendJobEvent(
    jobId,
    {
      status: "running",
      run_id: runId ?? `run-${Date.now()}`,
      started_at: nowIso(),
      finished_at: null,
      error: null,
      events: [],
      debug,
    },
    event,
  );
};

const jobFilePath = (jobId: string): string => {
  const safeJobId = assertValidJobId(jobId);
  return path.join(JOBS_ROOT, `${safeJobId}.json`);
};

const ensureJobsRoot = async (): Promise<void> => {
  await mkdir(JOBS_ROOT, { recursive: true });
};

const writeJobUnlocked = async (jobId: string, record: JobRecord): Promise<void> => {
  await ensureJobsRoot();
  const filePath = jobFilePath(jobId);
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
};

const withJobWriteLock = async <T>(jobId: string, operation: () => Promise<T>): Promise<T> => {
  const prior = jobWriteQueues.get(jobId) ?? Promise.resolve();
  let release = () => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prior.then(() => next);
  jobWriteQueues.set(jobId, tail);

  await prior;
  try {
    return await operation();
  } finally {
    release();
    if (jobWriteQueues.get(jobId) === tail) {
      jobWriteQueues.delete(jobId);
    }
  }
};

export const readJob = async (jobId: string): Promise<JobRecord> => {
  await ensureJobsRoot();
  const filePath = jobFilePath(jobId);
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as JobRecord;
    return {
      ...defaultJobRecord(),
      ...parsed,
      events: Array.isArray(parsed.events) ? parsed.events : [],
      debug: parsed.debug ?? null,
    };
  } catch {
    return defaultJobRecord();
  }
};

export const updateJob = async (
  jobId: string,
  updater: (current: JobRecord) => JobRecord | Promise<JobRecord>,
): Promise<JobRecord> => {
  return withJobWriteLock(jobId, async () => {
    const current = await readJob(jobId);
    const next = await updater(current);
    await writeJobUnlocked(jobId, next);
    return next;
  });
};

export const writeJob = async (jobId: string, record: JobRecord): Promise<void> => {
  await withJobWriteLock(jobId, async () => {
    await writeJobUnlocked(jobId, record);
  });
};
