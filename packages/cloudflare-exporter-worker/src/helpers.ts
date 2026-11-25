import {
  normalizePostgresUrl,
  parseJobActionPath,
  WORKER_JOB_ROUTE_ACTIONS,
  type JobEvent,
  type ParsedJobAction,
  type WorkerJobRouteAction,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core";

export const DEFAULT_STORAGE_COPY_CONCURRENCY = 32;
export const MIN_STORAGE_COPY_CONCURRENCY = 1;
export const MAX_STORAGE_COPY_CONCURRENCY = 64;
export const DEFAULT_HARD_TIMEOUT_SECONDS = 45 * 60;

export type JobAction = WorkerJobRouteAction;

export const cleanString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const cleanBooleanFlag = (value: unknown): boolean => {
  if (value === true) return true;
  if (typeof value === "string") {
    return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
  }
  return false;
};

export const cleanHttpUrl = (value: unknown): string | null => {
  const raw = cleanString(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
};

export const cleanProjectUrl = (value: unknown): string | null => {
  const raw = cleanString(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
};

export const cleanPostgresUrl = (value: unknown): string | null => {
  const raw = cleanString(value);
  if (!raw) return null;
  return normalizePostgresUrl(raw);
};

export const cleanStorageCopyConcurrency = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(
      MAX_STORAGE_COPY_CONCURRENCY,
      Math.max(MIN_STORAGE_COPY_CONCURRENCY, Math.trunc(value)),
    );
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.min(
        MAX_STORAGE_COPY_CONCURRENCY,
        Math.max(MIN_STORAGE_COPY_CONCURRENCY, Math.trunc(parsed)),
      );
    }
  }

  return DEFAULT_STORAGE_COPY_CONCURRENCY;
};

// Two hours: large migrations on the bigger runner classes legitimately need
// more than one hour, and callers scale the requested timeout with the
// runner size.
const MAX_HARD_TIMEOUT_SECONDS = 2 * 60 * 60;

export const cleanHardTimeout = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(60, Math.min(MAX_HARD_TIMEOUT_SECONDS, Math.trunc(value)));
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(60, Math.min(MAX_HARD_TIMEOUT_SECONDS, Math.trunc(parsed)));
    }
  }
  return DEFAULT_HARD_TIMEOUT_SECONDS;
};

export const parseJobAction = (pathname: string): ParsedJobAction | null =>
  parseJobActionPath(pathname, WORKER_JOB_ROUTE_ACTIONS);

export const MAX_JOB_EVENTS = 200;
// Repeating status events, newest kept. Everything else is a milestone the
// web app reads to decide what a failed run can retry (for example
// db_clone.succeeded), so status events must never push one out.
const REPEATING_EVENT_LIMITS: ReadonlyArray<{ suffix: string; limit: number }> = [
  { suffix: ".progress", limit: 100 },
  { suffix: ".debug", limit: 50 },
];

export const pruneJobEvents = (events: JobEvent[]): JobEvent[] => {
  if (events.length <= MAX_JOB_EVENTS) return events;

  const dropped = new Set<number>();
  for (const { suffix, limit } of REPEATING_EVENT_LIMITS) {
    const indices = events
      .map((event, index) => (event.phase.endsWith(suffix) ? index : -1))
      .filter((index) => index >= 0);
    for (const index of indices.slice(0, Math.max(0, indices.length - limit))) dropped.add(index);
  }

  const filtered = events.filter((_event, index) => !dropped.has(index));
  return filtered.length <= MAX_JOB_EVENTS ? filtered : filtered.slice(-MAX_JOB_EVENTS);
};
