import {
  normalizePostgresUrl as normalizeSharedPostgresUrl,
  type SourceType,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core";
import {
  DEFAULT_STORAGE_COPY_CONCURRENCY,
  MAX_STORAGE_COPY_CONCURRENCY,
  MIN_STORAGE_COPY_CONCURRENCY,
} from "./utils.js";

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type AuthUserMigrationInput = {
  enabled: boolean;
  usersTable: string;
  idColumn: string;
  emailColumn: string;
  firstNameColumn: string;
  lastNameColumn: string;
  avatarColumn: string;
};

export type DbCloneInput = {
  sourceType: SourceType;
  sourceEdgeFunctionUrl: string | null;
  sourceEdgeFunctionAccessKey: string | null;
  sourceDbUrl: string | null;
  targetDbUrl: string;
  confirmTargetBlank: boolean;
  hardTimeoutSeconds: number | undefined;
  excludeDataTables: string[];
  enableRlsOnRestoredTables: boolean;
  authUserMigration: AuthUserMigrationInput | null;
  verification: boolean;
};

export type StorageCopyInput = {
  sourceType: "lovable_edge_function";
  sourceEdgeFunctionUrl: string;
  sourceEdgeFunctionAccessKey: string;
  sourceProjectUrl: string | null;
  targetProjectUrl: string;
  targetAdminKey: string;
  concurrency: number;
  skipExistingTargetObjects: boolean;
};

export type ExportInput = {
  sourceType: SourceType;
  sourceEdgeFunctionUrl: string | null;
  sourceEdgeFunctionAccessKey: string | null;
  sourceDbUrl: string | null;
  targetDbUrl: string;
  sourceProjectUrl: string | null;
  targetProjectUrl: string | null;
  targetAdminKey: string | null;
  concurrency: number;
  hardTimeoutSeconds: number | undefined;
  excludeDataTables: string[];
  enableRlsOnRestoredTables: boolean;
  authUserMigration: AuthUserMigrationInput | null;
  verification: boolean;
};

export type DownloadInput = {
  sourceType: SourceType;
  sourceEdgeFunctionUrl: string | null;
  sourceEdgeFunctionAccessKey: string | null;
  sourceDbUrl: string | null;
  sourceProjectUrl: string | null;
  concurrency: number;
  hardTimeoutSeconds: number | undefined;
  excludeDataTables: string[];
};

export type TargetDbTestInput = {
  targetDbUrl: string;
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

const normalizeSourceDbUrl = (value: string): string => {
  const normalized = normalizeSharedPostgresUrl(value);
  if (!normalized) {
    throw new Error("source_db_url is invalid. Fix URL and try again.");
  }
  return normalized;
};

type SourceConfig =
  | {
      sourceType: "lovable_edge_function";
      sourceEdgeFunctionUrl: string;
      sourceEdgeFunctionAccessKey: string;
      sourceDbUrl: null;
    }
  | {
      sourceType: "postgres_url";
      sourceEdgeFunctionUrl: null;
      sourceEdgeFunctionAccessKey: null;
      sourceDbUrl: string;
    };

const parseSourceType = (value: unknown): SourceType | null => {
  const raw = trimOrNull(typeof value === "string" ? value : null);
  if (!raw) return "lovable_edge_function";
  if (raw === "lovable_edge_function" || raw === "postgres_url") return raw;
  return null;
};

const normalizeSourceConfig = (
  raw: {
    source_type?: unknown;
    source_edge_function_url?: unknown;
    source_edge_function_access_key?: unknown;
    source_edge_function_token?: unknown;
    source_db_url?: unknown;
  },
  lovableRequiredMessage: string,
): ValidationResult<SourceConfig> => {
  const sourceType = parseSourceType(raw.source_type);
  if (!sourceType) {
    return {
      ok: false,
      error:
        "source_type must be either lovable_edge_function or postgres_url. Fix input and try again.",
    };
  }

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
  const sourceDbUrlRaw = trimOrNull(
    typeof raw.source_db_url === "string" ? raw.source_db_url : null,
  );

  if (sourceType === "postgres_url") {
    if (!sourceDbUrlRaw || sourceEdgeFunctionUrlRaw || sourceEdgeFunctionAccessKey) {
      return {
        ok: false,
        error:
          "Postgres URL source requires source_db_url and must not include source_edge_function_url or source_edge_function_access_key.",
      };
    }

    try {
      return {
        ok: true,
        value: {
          sourceType,
          sourceEdgeFunctionUrl: null,
          sourceEdgeFunctionAccessKey: null,
          sourceDbUrl: normalizeSourceDbUrl(sourceDbUrlRaw),
        },
      };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "source_db_url is invalid. Fix URL and try again.",
      };
    }
  }

  if (sourceDbUrlRaw) {
    return {
      ok: false,
      error: "source_db_url requires source_type=postgres_url. Fix input and try again.",
    };
  }

  if (!sourceEdgeFunctionUrlRaw || !sourceEdgeFunctionAccessKey) {
    return {
      ok: false,
      error: lovableRequiredMessage,
    };
  }

  try {
    return {
      ok: true,
      value: {
        sourceType,
        sourceEdgeFunctionUrl: normalizeHttpUrl(sourceEdgeFunctionUrlRaw),
        sourceEdgeFunctionAccessKey,
        sourceDbUrl: null,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Source edge function input is invalid. Fix input and try again.",
    };
  }
};

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/u;
const RELATION_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?$/u;
const QUALIFIED_TABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*\.[A-Za-z_][A-Za-z0-9_$]*$/u;

const normalizeExcludeDataTables = (value: unknown): string[] => {
  const rawItems =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value)
        ? value.flatMap((item) => (typeof item === "string" ? item.split(",") : []))
        : [];
  const tables = new Set<string>();

  for (const rawItem of rawItems) {
    const table = rawItem.trim();
    if (!table) continue;
    if (!QUALIFIED_TABLE_PATTERN.test(table)) {
      throw new Error(
        "exclude_data_tables entries must be schema-qualified table names like public.sessions.",
      );
    }
    tables.add(table);
  }

  return [...tables].sort((left, right) => left.localeCompare(right));
};

const normalizeIdentifier = (value: unknown, fallback: string, label: string): string => {
  const raw = trimOrNull(typeof value === "string" ? value : null) ?? fallback;
  if (!IDENTIFIER_PATTERN.test(raw)) {
    throw new Error(`${label} must be a valid unquoted Postgres identifier.`);
  }
  return raw;
};

const normalizeRelationName = (value: unknown, fallback: string, label: string): string => {
  const raw = trimOrNull(typeof value === "string" ? value : null) ?? fallback;
  if (!RELATION_PATTERN.test(raw)) {
    throw new Error(`${label} must be a valid table name or schema-qualified table name.`);
  }
  return raw;
};

const normalizeAuthUserMigration = (value: unknown): AuthUserMigrationInput | null => {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new Error("auth_user_migration must be an object when provided.");
  }

  return {
    enabled: toBooleanFlag(value.enabled),
    usersTable: normalizeRelationName(
      value.users_table,
      "users",
      "auth_user_migration.users_table",
    ),
    idColumn: normalizeIdentifier(value.id_column, "id", "auth_user_migration.id_column"),
    emailColumn: normalizeIdentifier(
      value.email_column,
      "email",
      "auth_user_migration.email_column",
    ),
    firstNameColumn: normalizeIdentifier(
      value.first_name_column,
      "first_name",
      "auth_user_migration.first_name_column",
    ),
    lastNameColumn: normalizeIdentifier(
      value.last_name_column,
      "last_name",
      "auth_user_migration.last_name_column",
    ),
    avatarColumn: normalizeIdentifier(
      value.avatar_column,
      "profile_image_url",
      "auth_user_migration.avatar_column",
    ),
  };
};

const parseVerification = (value: unknown, sourceType: SourceType): boolean => {
  if (value === undefined) return sourceType === "postgres_url";
  return toBooleanFlag(value);
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
  source_type?: unknown;
  source_edge_function_url?: unknown;
  source_edge_function_access_key?: unknown;
  source_edge_function_token?: unknown;
  source_db_url?: unknown;
  target_db_url?: unknown;
  confirm_target_blank?: unknown;
  hard_timeout_seconds?: unknown;
  exclude_data_tables?: unknown;
  enable_rls_on_restored_tables?: unknown;
  auth_user_migration?: unknown;
  verification?: unknown;
}): ValidationResult<DbCloneInput> => {
  const source = normalizeSourceConfig(
    raw,
    "DB clone fields are required. Add source_edge_function_url, source_edge_function_access_key, and target_db_url and try again.",
  );
  if (!source.ok) return source;

  const targetDbUrl = trimOrNull(typeof raw.target_db_url === "string" ? raw.target_db_url : null);

  if (!targetDbUrl) {
    return {
      ok: false,
      error:
        source.value.sourceType === "postgres_url"
          ? "DB clone fields are required. Add source_db_url and target_db_url and try again."
          : "DB clone fields are required. Add source_edge_function_url, source_edge_function_access_key, and target_db_url and try again.",
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
        sourceType: source.value.sourceType,
        sourceEdgeFunctionUrl: source.value.sourceEdgeFunctionUrl,
        sourceEdgeFunctionAccessKey: source.value.sourceEdgeFunctionAccessKey,
        sourceDbUrl: source.value.sourceDbUrl,
        targetDbUrl: normalizeTargetDbUrl(targetDbUrl),
        confirmTargetBlank,
        hardTimeoutSeconds: parseHardTimeout(raw.hard_timeout_seconds),
        excludeDataTables: normalizeExcludeDataTables(raw.exclude_data_tables),
        enableRlsOnRestoredTables: toBooleanFlag(raw.enable_rls_on_restored_tables),
        authUserMigration: normalizeAuthUserMigration(raw.auth_user_migration),
        verification: parseVerification(raw.verification, source.value.sourceType),
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
  source_type?: unknown;
  source_edge_function_url?: unknown;
  source_edge_function_access_key?: unknown;
  source_edge_function_token?: unknown;
  source_db_url?: unknown;
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
  const sourceType = parseSourceType(raw.source_type);
  const sourceDbUrlRaw = trimOrNull(
    typeof raw.source_db_url === "string" ? raw.source_db_url : null,
  );

  if (!sourceType) {
    return {
      ok: false,
      error:
        "source_type must be either lovable_edge_function or postgres_url. Fix input and try again.",
    };
  }

  if (sourceType === "postgres_url" || sourceDbUrlRaw) {
    return {
      ok: false,
      error: "Postgres URL sources do not have Supabase storage; start-storage is not supported.",
    };
  }

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
        sourceType,
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
  source_type?: unknown;
  source_edge_function_url?: unknown;
  source_edge_function_access_key?: unknown;
  source_edge_function_token?: unknown;
  source_db_url?: unknown;
  source_project_url?: unknown;
  storage_copy_concurrency?: unknown;
  hard_timeout_seconds?: unknown;
  exclude_data_tables?: unknown;
}): ValidationResult<DownloadInput> => {
  const source = normalizeSourceConfig(
    raw,
    "ZIP export fields are required. Add source_edge_function_url and source_edge_function_access_key and try again.",
  );
  if (!source.ok) return source;

  const sourceProjectUrlRaw = trimOrNull(
    typeof raw.source_project_url === "string" ? raw.source_project_url : null,
  );

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
        sourceType: source.value.sourceType,
        sourceEdgeFunctionUrl: source.value.sourceEdgeFunctionUrl,
        sourceEdgeFunctionAccessKey: source.value.sourceEdgeFunctionAccessKey,
        sourceDbUrl: source.value.sourceDbUrl,
        sourceProjectUrl: sourceProjectUrlRaw ? normalizeProjectUrl(sourceProjectUrlRaw) : null,
        concurrency,
        hardTimeoutSeconds: parseHardTimeout(raw.hard_timeout_seconds),
        excludeDataTables: normalizeExcludeDataTables(raw.exclude_data_tables),
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

export const normalizeTargetDbTestInput = (raw: {
  target_db_url?: unknown;
  hard_timeout_seconds?: unknown;
}): ValidationResult<TargetDbTestInput> => {
  const targetDbUrl = trimOrNull(typeof raw.target_db_url === "string" ? raw.target_db_url : null);

  if (!targetDbUrl) {
    return {
      ok: false,
      error: "Supabase connection string is required. Paste it and try again.",
    };
  }

  try {
    return {
      ok: true,
      value: {
        targetDbUrl: normalizeTargetDbUrl(targetDbUrl),
        hardTimeoutSeconds: parseHardTimeout(raw.hard_timeout_seconds),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Supabase connection string is invalid. Fix it and try again.",
    };
  }
};

export const normalizeExportInput = (raw: {
  source_type?: unknown;
  source_edge_function_url?: unknown;
  source_edge_function_access_key?: unknown;
  source_edge_function_token?: unknown;
  source_db_url?: unknown;
  target_db_url?: unknown;
  confirm_target_blank?: unknown;
  source_project_url?: unknown;
  target_project_url?: unknown;
  target_admin_key?: unknown;
  storage_copy_concurrency?: unknown;
  hard_timeout_seconds?: unknown;
  exclude_data_tables?: unknown;
  enable_rls_on_restored_tables?: unknown;
  auth_user_migration?: unknown;
  verification?: unknown;
}): ValidationResult<ExportInput> => {
  const source = normalizeSourceConfig(
    raw,
    "Export fields are required. Add source_edge_function_url, source_edge_function_access_key, and target_db_url and try again.",
  );
  if (!source.ok) return source;

  const targetDbUrl = trimOrNull(typeof raw.target_db_url === "string" ? raw.target_db_url : null);

  if (!targetDbUrl) {
    return {
      ok: false,
      error:
        source.value.sourceType === "postgres_url"
          ? "Export fields are required. Add source_db_url and target_db_url and try again."
          : "Export fields are required. Add source_edge_function_url, source_edge_function_access_key, and target_db_url and try again.",
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
    source_type: raw.source_type,
    source_edge_function_url: raw.source_edge_function_url,
    source_edge_function_access_key: raw.source_edge_function_access_key,
    source_project_url: raw.source_project_url,
    target_project_url: raw.target_project_url,
    target_admin_key: raw.target_admin_key,
    storage_copy_concurrency: raw.storage_copy_concurrency,
  });
  if (source.value.sourceType === "lovable_edge_function" && !storageCopy.ok) return storageCopy;

  try {
    return {
      ok: true,
      value: {
        sourceType: source.value.sourceType,
        sourceEdgeFunctionUrl: source.value.sourceEdgeFunctionUrl,
        sourceEdgeFunctionAccessKey: source.value.sourceEdgeFunctionAccessKey,
        sourceDbUrl: source.value.sourceDbUrl,
        targetDbUrl: normalizeTargetDbUrl(targetDbUrl),
        hardTimeoutSeconds: parseHardTimeout(raw.hard_timeout_seconds),
        sourceProjectUrl:
          source.value.sourceType === "lovable_edge_function" && storageCopy.ok
            ? storageCopy.value.sourceProjectUrl
            : null,
        targetProjectUrl:
          source.value.sourceType === "lovable_edge_function" && storageCopy.ok
            ? storageCopy.value.targetProjectUrl
            : null,
        targetAdminKey:
          source.value.sourceType === "lovable_edge_function" && storageCopy.ok
            ? storageCopy.value.targetAdminKey
            : null,
        concurrency: storageCopy.ok
          ? storageCopy.value.concurrency
          : DEFAULT_STORAGE_COPY_CONCURRENCY,
        excludeDataTables: normalizeExcludeDataTables(raw.exclude_data_tables),
        enableRlsOnRestoredTables: toBooleanFlag(raw.enable_rls_on_restored_tables),
        authUserMigration: normalizeAuthUserMigration(raw.auth_user_migration),
        verification: parseVerification(raw.verification, source.value.sourceType),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Export input is invalid. Fix input and try again.",
    };
  }
};
