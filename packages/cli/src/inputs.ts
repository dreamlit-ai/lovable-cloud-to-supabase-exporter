import { normalizePostgresUrl as normalizeSharedPostgresUrl } from "@dreamlit/lovable-cloud-to-supabase-exporter-core";
import {
  DEFAULT_STORAGE_COPY_CONCURRENCY,
  MAX_STORAGE_COPY_CONCURRENCY,
  MIN_STORAGE_COPY_CONCURRENCY,
} from "./utils.js";

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type DbCloneInput = {
  sourceEdgeFunctionUrl: string;
  sourceEdgeFunctionAccessKey: string;
  targetDbUrl: string;
  confirmTargetBlank: boolean;
  hardTimeoutSeconds: number | undefined;
};

export type StorageCopyInput = {
  sourceEdgeFunctionUrl: string;
  sourceEdgeFunctionAccessKey: string;
  sourceProjectUrl: string | null;
  targetProjectUrl: string;
  targetAdminKey: string;
  concurrency: number;
  skipExistingTargetObjects: boolean;
};

export type ExportInput = {
  sourceEdgeFunctionUrl: string;
  sourceEdgeFunctionAccessKey: string;
  targetDbUrl: string;
  sourceProjectUrl: string | null;
  targetProjectUrl: string;
  targetAdminKey: string;
  concurrency: number;
  hardTimeoutSeconds: number | undefined;
};

export type DownloadInput = {
  sourceEdgeFunctionUrl: string;
  sourceEdgeFunctionAccessKey: string;
  sourceProjectUrl: string | null;
  concurrency: number;
  hardTimeoutSeconds: number | undefined;
};

export const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

export const nowIso = (): string => new Date().toISOString();

export const asErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Unexpected error.";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const toBooleanFlag = (value: unknown): boolean => {
  if (value === true) return true;
  if (typeof value === "string") {
    return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
  }
  return false;
};

export const trimOrNull = (value: string | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const required = (value: string | null, message: string): string => {
  const cleaned = trimOrNull(value);
  if (!cleaned) return fail(message);
  return cleaned;
};

export const normalizeProjectUrl = (value: string): string => {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Project URL must start with http:// or https://.");
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    throw new Error("Project URL is invalid. Fix URL and try again.");
  }
};

const normalizeHttpUrl = (value: string): string => {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Source edge function URL must start with http:// or https://.");
    }
    return parsed.toString();
  } catch {
    throw new Error("Source edge function URL is invalid. Fix URL and try again.");
  }
};

const normalizeTargetDbUrl = (value: string): string => {
  const normalized = normalizeSharedPostgresUrl(value);
  if (!normalized) {
    throw new Error("Target DB URL is invalid. Fix URL and try again.");
  }
  return normalized;
};

export const parsePort = (value: string | null): number => {
  if (!value) return 8799;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("Invalid --port. Use a value between 1 and 65535.");
  }
  return parsed;
};

const parseHardTimeout = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(60, Math.trunc(value));
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(60, Math.trunc(parsed));
};

export const normalizeDbCloneInput = (raw: {
  source_edge_function_url?: unknown;
  source_edge_function_access_key?: unknown;
  source_edge_function_token?: unknown;
  target_db_url?: unknown;
  confirm_target_blank?: unknown;
  hard_timeout_seconds?: unknown;
}): ValidationResult<DbCloneInput> => {
  const sourceEdgeFunctionUrlRaw = trimOrNull(
    typeof raw.source_edge_function_url === "string" ? raw.source_edge_function_url : null,
  );
  const sourceEdgeFunctionAccessKey = trimOrNull(
    typeof raw.source_edge_function_access_key === "string"
      ? raw.source_edge_function_access_key
      : typeof raw.source_edge_function_token === "string"
        ? raw.source_edge_function_token
        : null,
  );
  const targetDbUrl = trimOrNull(typeof raw.target_db_url === "string" ? raw.target_db_url : null);

  if (!sourceEdgeFunctionUrlRaw || !sourceEdgeFunctionAccessKey || !targetDbUrl) {
    return {
      ok: false,
      error:
        "DB clone fields are required. Add source_edge_function_url, source_edge_function_access_key, and target_db_url and try again.",
    };
  }

  const confirmTargetBlank = toBooleanFlag(raw.confirm_target_blank);
  if (!confirmTargetBlank) {
    return {
      ok: false,
      error: "Target DB must be confirmed blank. Set confirm_target_blank=true and try again.",
    };
  }

  try {
    return {
      ok: true,
      value: {
        sourceEdgeFunctionUrl: normalizeHttpUrl(sourceEdgeFunctionUrlRaw),
        sourceEdgeFunctionAccessKey,
        targetDbUrl: normalizeTargetDbUrl(targetDbUrl),
        confirmTargetBlank,
        hardTimeoutSeconds: parseHardTimeout(raw.hard_timeout_seconds),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "DB clone input is invalid. Fix input and try again.",
    };
  }
};

export const normalizeStorageCopyInput = (raw: {
  source_edge_function_url?: unknown;
  source_edge_function_access_key?: unknown;
  source_edge_function_token?: unknown;
  source_project_url?: unknown;
  target_project_url?: unknown;
  target_admin_key?: unknown;
  storage_copy_concurrency?: unknown;
  skip_existing_target_objects?: unknown;
}): ValidationResult<StorageCopyInput> => {
  const sourceEdgeFunctionUrlRaw = trimOrNull(
    typeof raw.source_edge_function_url === "string" ? raw.source_edge_function_url : null,
  );
  const sourceEdgeFunctionAccessKey = trimOrNull(
    typeof raw.source_edge_function_access_key === "string"
      ? raw.source_edge_function_access_key
      : typeof raw.source_edge_function_token === "string"
        ? raw.source_edge_function_token
        : null,
  );
  const sourceProjectUrlRaw = trimOrNull(
    typeof raw.source_project_url === "string" ? raw.source_project_url : null,
  );
  const targetProjectUrlRaw = trimOrNull(
    typeof raw.target_project_url === "string" ? raw.target_project_url : null,
  );
  const targetAdminKey = trimOrNull(
    typeof raw.target_admin_key === "string" ? raw.target_admin_key : null,
  );

  if (
    !sourceEdgeFunctionUrlRaw ||
    !sourceEdgeFunctionAccessKey ||
    !targetProjectUrlRaw ||
    !targetAdminKey
  ) {
    return {
      ok: false,
      error:
        "Storage copy fields are required. Add source_edge_function_url, source_edge_function_access_key, target_project_url, and target_admin_key.",
    };
  }

  let concurrency = DEFAULT_STORAGE_COPY_CONCURRENCY;
  if (
    typeof raw.storage_copy_concurrency === "number" &&
    Number.isFinite(raw.storage_copy_concurrency)
  ) {
    concurrency = Math.min(
      MAX_STORAGE_COPY_CONCURRENCY,
      Math.max(MIN_STORAGE_COPY_CONCURRENCY, Math.trunc(raw.storage_copy_concurrency)),
    );
  } else if (typeof raw.storage_copy_concurrency === "string") {
    const parsed = Number.parseInt(raw.storage_copy_concurrency, 10);
    if (Number.isFinite(parsed)) {
      concurrency = Math.min(
        MAX_STORAGE_COPY_CONCURRENCY,
        Math.max(MIN_STORAGE_COPY_CONCURRENCY, Math.trunc(parsed)),
      );
    }
  }

  try {
    return {
      ok: true,
      value: {
        sourceEdgeFunctionUrl: normalizeHttpUrl(sourceEdgeFunctionUrlRaw),
        sourceEdgeFunctionAccessKey,
        sourceProjectUrl: sourceProjectUrlRaw ? normalizeProjectUrl(sourceProjectUrlRaw) : null,
        targetProjectUrl: normalizeProjectUrl(targetProjectUrlRaw),
        targetAdminKey,
        concurrency,
        skipExistingTargetObjects: toBooleanFlag(raw.skip_existing_target_objects),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Storage copy input is invalid. Fix input and try again.",
    };
  }
};

export const normalizeDownloadInput = (raw: {
  source_edge_function_url?: unknown;
  source_edge_function_access_key?: unknown;
  source_edge_function_token?: unknown;
  source_project_url?: unknown;
  storage_copy_concurrency?: unknown;
  hard_timeout_seconds?: unknown;
}): ValidationResult<DownloadInput> => {
  const sourceEdgeFunctionUrlRaw = trimOrNull(
    typeof raw.source_edge_function_url === "string" ? raw.source_edge_function_url : null,
  );
  const sourceEdgeFunctionAccessKey = trimOrNull(
    typeof raw.source_edge_function_access_key === "string"
      ? raw.source_edge_function_access_key
      : typeof raw.source_edge_function_token === "string"
        ? raw.source_edge_function_token
        : null,
  );
  const sourceProjectUrlRaw = trimOrNull(
    typeof raw.source_project_url === "string" ? raw.source_project_url : null,
  );

  if (!sourceEdgeFunctionUrlRaw || !sourceEdgeFunctionAccessKey) {
    return {
      ok: false,
      error:
        "ZIP export fields are required. Add source_edge_function_url and source_edge_function_access_key and try again.",
    };
  }

  let concurrency = DEFAULT_STORAGE_COPY_CONCURRENCY;
  if (
    typeof raw.storage_copy_concurrency === "number" &&
    Number.isFinite(raw.storage_copy_concurrency)
  ) {
    concurrency = Math.trunc(raw.storage_copy_concurrency);
  } else if (typeof raw.storage_copy_concurrency === "string") {
    const parsed = Number.parseInt(raw.storage_copy_concurrency, 10);
    if (Number.isFinite(parsed)) {
      concurrency = parsed;
    }
  }
  concurrency = Math.max(
    MIN_STORAGE_COPY_CONCURRENCY,
    Math.min(MAX_STORAGE_COPY_CONCURRENCY, concurrency),
  );

  try {
    return {
      ok: true,
      value: {
        sourceEdgeFunctionUrl: normalizeHttpUrl(sourceEdgeFunctionUrlRaw),
        sourceEdgeFunctionAccessKey,
        sourceProjectUrl: sourceProjectUrlRaw ? normalizeProjectUrl(sourceProjectUrlRaw) : null,
        concurrency,
        hardTimeoutSeconds: parseHardTimeout(raw.hard_timeout_seconds),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "ZIP export input is invalid. Fix input and try again.",
    };
  }
};

export const normalizeExportInput = (raw: {
  source_edge_function_url?: unknown;
  source_edge_function_access_key?: unknown;
  source_edge_function_token?: unknown;
  target_db_url?: unknown;
  confirm_target_blank?: unknown;
  source_project_url?: unknown;
  target_project_url?: unknown;
  target_admin_key?: unknown;
  storage_copy_concurrency?: unknown;
  hard_timeout_seconds?: unknown;
}): ValidationResult<ExportInput> => {
  const sourceEdgeFunctionUrlRaw = trimOrNull(
    typeof raw.source_edge_function_url === "string" ? raw.source_edge_function_url : null,
  );
  const sourceEdgeFunctionAccessKey = trimOrNull(
    typeof raw.source_edge_function_access_key === "string"
      ? raw.source_edge_function_access_key
      : typeof raw.source_edge_function_token === "string"
        ? raw.source_edge_function_token
        : null,
  );
  const targetDbUrl = trimOrNull(typeof raw.target_db_url === "string" ? raw.target_db_url : null);

  if (!sourceEdgeFunctionUrlRaw || !sourceEdgeFunctionAccessKey || !targetDbUrl) {
    return {
      ok: false,
      error:
        "Export fields are required. Add source_edge_function_url, source_edge_function_access_key, and target_db_url and try again.",
    };
  }

  const confirmTargetBlank = toBooleanFlag(raw.confirm_target_blank);
  if (!confirmTargetBlank) {
    return {
      ok: false,
      error:
        "Combined export requires a blank target DB confirmation. Set confirm_target_blank=true and try again.",
    };
  }

  const storageCopy = normalizeStorageCopyInput({
    source_edge_function_url: raw.source_edge_function_url,
    source_edge_function_access_key: raw.source_edge_function_access_key,
    source_project_url: raw.source_project_url,
    target_project_url: raw.target_project_url,
    target_admin_key: raw.target_admin_key,
    storage_copy_concurrency: raw.storage_copy_concurrency,
  });
  if (!storageCopy.ok) return storageCopy;

  return {
    ok: true,
    value: {
      sourceEdgeFunctionUrl: normalizeHttpUrl(sourceEdgeFunctionUrlRaw),
      sourceEdgeFunctionAccessKey,
      targetDbUrl: normalizeTargetDbUrl(targetDbUrl),
      hardTimeoutSeconds: parseHardTimeout(raw.hard_timeout_seconds),
      sourceProjectUrl: storageCopy.value.sourceProjectUrl,
      targetProjectUrl: storageCopy.value.targetProjectUrl,
      targetAdminKey: storageCopy.value.targetAdminKey,
      concurrency: storageCopy.value.concurrency,
    },
  };
};
