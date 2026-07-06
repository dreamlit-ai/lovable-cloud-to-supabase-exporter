import {
  buildMigrationSummary,
  type JobRecord,
  type MigrationSummary,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core";
import { runDbClone } from "./db-clone.js";
import {
  type DbCloneInput,
  type DownloadInput,
  type ExportInput,
  normalizeDbCloneInput,
  normalizeDownloadInput,
  normalizeExportInput,
  normalizeSourceInspectInput,
  normalizeStorageCopyInput,
  normalizeTargetDbTestInput,
  type SourceInspectInput,
  type StorageCopyInput,
  type TargetDbTestInput,
  type ValidationResult,
} from "./inputs.js";
import { readJob } from "./jobs.js";
import { runDownload, type DownloadRunOptions } from "./download.js";
import { runExport, type ExportRunOptions } from "./export.js";
import type { DockerRuntimeOptions } from "./runtime-options.js";
import { runStorageCopy } from "./storage-copy.js";
import { runSourceInspect, type SourceInspectRunOptions } from "./source-inspect.js";
import { runTargetDbTest, type TargetDbTestRunOptions } from "./target-db-test.js";

type RawDbStart = {
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
};

type RawStorageStart = {
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
};

type RawExportStart = {
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
};

type RawDownloadStart = {
  source_type?: unknown;
  source_edge_function_url?: unknown;
  source_edge_function_access_key?: unknown;
  source_edge_function_token?: unknown;
  source_db_url?: unknown;
  source_project_url?: unknown;
  storage_copy_concurrency?: unknown;
  hard_timeout_seconds?: unknown;
  exclude_data_tables?: unknown;
};

type RawTargetDbTestStart = {
  target_db_url?: unknown;
  hard_timeout_seconds?: unknown;
};

type RawSourceInspectStart = {
  source_edge_function_url?: unknown;
  source_edge_function_access_key?: unknown;
  source_edge_function_token?: unknown;
  hard_timeout_seconds?: unknown;
};

export const startDbMigration = async (
  jobId: string,
  raw: RawDbStart,
  options: DockerRuntimeOptions,
): Promise<ValidationResult<JobRecord>> => {
  const prepared = prepareDbMigrationInput(raw);
  if (!prepared.ok) return prepared;
  return {
    ok: true,
    value: await runPreparedDbMigration(jobId, prepared.value, options),
  };
};

export const startStorageMigration = async (
  jobId: string,
  raw: RawStorageStart,
): Promise<ValidationResult<JobRecord>> => {
  const prepared = prepareStorageMigrationInput(raw);
  if (!prepared.ok) return prepared;
  return {
    ok: true,
    value: await runPreparedStorageMigration(jobId, prepared.value),
  };
};

export const startExportMigration = async (
  jobId: string,
  raw: RawExportStart,
  options: ExportRunOptions,
): Promise<ValidationResult<JobRecord>> => {
  const prepared = prepareExportMigrationInput(raw);
  if (!prepared.ok) return prepared;
  return {
    ok: true,
    value: await runPreparedExportMigration(jobId, prepared.value, options),
  };
};

export const startDownloadMigration = async (
  jobId: string,
  raw: RawDownloadStart,
  options: DownloadRunOptions,
): Promise<ValidationResult<JobRecord>> => {
  const prepared = prepareDownloadMigrationInput(raw);
  if (!prepared.ok) return prepared;
  return {
    ok: true,
    value: await runPreparedDownloadMigration(jobId, prepared.value, options),
  };
};

export const startTargetDbTestMigration = async (
  jobId: string,
  raw: RawTargetDbTestStart,
  options: TargetDbTestRunOptions,
): Promise<ValidationResult<JobRecord>> => {
  const prepared = prepareTargetDbTestInput(raw);
  if (!prepared.ok) return prepared;
  return {
    ok: true,
    value: await runPreparedTargetDbTest(jobId, prepared.value, options),
  };
};

export const prepareDbMigrationInput = (raw: RawDbStart): ValidationResult<DbCloneInput> => {
  return normalizeDbCloneInput(raw);
};

export const prepareStorageMigrationInput = (
  raw: RawStorageStart,
): ValidationResult<StorageCopyInput> => {
  return normalizeStorageCopyInput(raw);
};

export const prepareExportMigrationInput = (raw: RawExportStart): ValidationResult<ExportInput> => {
  return normalizeExportInput(raw);
};

export const prepareDownloadMigrationInput = (
  raw: RawDownloadStart,
): ValidationResult<DownloadInput> => {
  return normalizeDownloadInput(raw);
};

export const prepareTargetDbTestInput = (
  raw: RawTargetDbTestStart,
): ValidationResult<TargetDbTestInput> => {
  return normalizeTargetDbTestInput(raw);
};

export const prepareSourceInspectInput = (
  raw: RawSourceInspectStart,
): ValidationResult<SourceInspectInput> => {
  return normalizeSourceInspectInput(raw);
};

export const runPreparedDbMigration = async (
  jobId: string,
  input: DbCloneInput,
  options: DockerRuntimeOptions,
): Promise<JobRecord> => {
  return runDbClone(jobId, input, options);
};

export const runPreparedStorageMigration = async (
  jobId: string,
  input: StorageCopyInput,
): Promise<JobRecord> => {
  return runStorageCopy(jobId, input);
};

export const runPreparedExportMigration = async (
  jobId: string,
  input: ExportInput,
  options: ExportRunOptions,
): Promise<JobRecord> => {
  return runExport(jobId, input, options);
};

export const runPreparedDownloadMigration = async (
  jobId: string,
  input: DownloadInput,
  options: DownloadRunOptions,
): Promise<JobRecord> => {
  return runDownload(jobId, input, options);
};

export const runPreparedTargetDbTest = async (
  jobId: string,
  input: TargetDbTestInput,
  options: TargetDbTestRunOptions,
): Promise<JobRecord> => {
  return runTargetDbTest(jobId, input, options);
};

export const runPreparedSourceInspect = async (
  jobId: string,
  input: SourceInspectInput,
  options: SourceInspectRunOptions,
): Promise<JobRecord> => {
  return runSourceInspect(jobId, input, options);
};

export const getMigrationStatus = async (jobId: string): Promise<JobRecord> => {
  return readJob(jobId);
};

export const getMigrationSummary = async (jobId: string): Promise<MigrationSummary> => {
  return buildMigrationSummary(await readJob(jobId));
};
