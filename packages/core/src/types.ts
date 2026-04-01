export type JobStatus = "idle" | "running" | "succeeded" | "failed";
export type JobEventLevel = "info" | "warn" | "error";
export type StorageCopyMode = "full" | "off" | "retry_skip_existing";
export type JobTask = "db" | "storage" | "export" | "download";
export type StorageFailureAction =
  | "list_source_buckets"
  | "list_target_buckets"
  | "create_target_bucket"
  | "download_object"
  | "upload_object";

export type StorageFailureEventData = {
  storage_action: StorageFailureAction;
  bucket_id: string | null;
  object_path: string | null;
  prefix: string | null;
  project_host: string;
  project_role: "source" | "target";
  status_code: number | null;
  attempts: number;
  retryable: boolean;
};

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
  skip_existing_target_objects?: boolean;
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
    details: StorageFailureEventData | null;
  };
};

export type ApiRequestOptions = {
  baseUrl: string;
  bearerToken?: string;
  jobId: string;
};
