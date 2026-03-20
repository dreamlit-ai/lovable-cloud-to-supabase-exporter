export type JobStatus = "idle" | "running" | "succeeded" | "failed";
export type JobEventLevel = "info" | "warn" | "error";
export type StorageCopyMode = "full" | "off";
export type JobTask = "db" | "storage" | "export" | "download";

export type JobEvent = {
  at: string;
  level: JobEventLevel;
  phase: string;
  message: string;
  data?: Record<string, unknown>;
};

export type DbUrlSummary = {
  parse_ok: boolean;
  scheme: string | null;
  host: string | null;
  port: string | null;
  database: string | null;
  username: string | null;
  sslmode: string | null;
  authority_at_count: number;
  looks_malformed_authority: boolean;
  query_keys: string[];
};

export type JobDebug = {
  task: JobTask | null;
  source: DbUrlSummary | null;
  target: DbUrlSummary | null;
  source_project_url: string | null;
  target_project_url: string | null;
  storage_copy_concurrency: number;
  data_restore_mode: "replace";
  storage_copy_mode: StorageCopyMode;
  hard_timeout_seconds: number | null;
  pgsslmode: string;
  container_start_invoked: boolean;
  monitor_raw_error: string | null;
  monitor_exit_code: number | null;
  failure_class: string | null;
  failure_hint: string | null;
};

export type JobRecord = {
  status: JobStatus;
  run_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  events: JobEvent[];
  debug: JobDebug | null;
};

export type StartBody = {
  source_edge_function_url?: string;
  source_edge_function_access_key?: string;
  target_db_url?: string;
  confirm_target_blank?: boolean;
  source_project_url?: string;
  target_project_url?: string;
  target_admin_key?: string;
  storage_copy_concurrency?: number;
  hard_timeout_seconds?: number;
};

export type MigrationSummary = {
  status: JobStatus;
  task: JobTask | null;
  moved: {
    schemas: string[];
    buckets: string[];
    tableRowHints: Array<{ table: string; rows: number | null }>;
    objectsCopied: number | null;
  };
  skipped: Array<{ item: string; reason: string }>;
  manualActions: string[];
  errors: {
    message: string | null;
    hint: string | null;
    class: string | null;
  };
};

export type ApiRequestOptions = {
  baseUrl: string;
  bearerToken?: string;
  jobId: string;
};
