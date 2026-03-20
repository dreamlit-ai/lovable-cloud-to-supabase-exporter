export const DEFAULT_STORAGE_COPY_CONCURRENCY = 8;
export const MIN_STORAGE_COPY_CONCURRENCY = 1;
export const MAX_STORAGE_COPY_CONCURRENCY = 8;
export const DEFAULT_HARD_TIMEOUT_SECONDS = 45 * 60;

export type JobAction =
  | "start-export"
  | "start-download"
  | "status"
  | "summary"
  | "artifact"
  | "container-callback";

export type ParsedJobAction = {
  jobId: string;
  action: JobAction;
};

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

export const cleanHardTimeout = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(60, Math.min(60 * 60, Math.trunc(value)));
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(60, Math.min(60 * 60, Math.trunc(parsed)));
    }
  }
  return DEFAULT_HARD_TIMEOUT_SECONDS;
};

export const parseJobAction = (pathname: string): ParsedJobAction | null => {
  const match = pathname.match(
    /^\/jobs\/([^/]+)\/(start-export|start-download|status|summary|artifact|container-callback)$/,
  );
  if (!match) return null;
  return {
    jobId: decodeURIComponent(match[1] ?? ""),
    action: (match[2] ?? "") as JobAction,
  };
};
