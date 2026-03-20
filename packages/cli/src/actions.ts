import {
  buildMigrationSummary,
  type JobRecord,
  type MigrationSummary,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core";
import { runDbClone, type DbCloneRunOptions } from "./db-clone.js";
import {
  type DbCloneInput,
  type DownloadInput,
  type ExportInput,
  normalizeDbCloneInput,
  normalizeDownloadInput,
  normalizeExportInput,
  normalizeStorageCopyInput,
  type StorageCopyInput,
  type ValidationResult,
} from "./inputs.js";
import { readJob } from "./jobs.js";
import { runDownload, type DownloadRunOptions } from "./download.js";
import { runExport, type ExportRunOptions } from "./export.js";
import { runStorageCopy } from "./storage-copy.js";

type RawDbStart = {
  source_edge_function_url?: unknown;
  source_edge_function_access_key?: unknown;
  source_edge_function_token?: unknown;
  target_db_url?: unknown;
  confirm_target_blank?: unknown;
  hard_timeout_seconds?: unknown;
};

type RawStorageStart = {
  source_edge_function_url?: unknown;
  source_edge_function_access_key?: unknown;
  source_edge_function_token?: unknown;
  source_project_url?: unknown;
  target_project_url?: unknown;
  target_admin_key?: unknown;
  storage_copy_concurrency?: unknown;
};

type RawExportStart = {
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
};

type RawDownloadStart = {
  source_edge_function_url?: unknown;
  source_edge_function_access_key?: unknown;
  source_edge_function_token?: unknown;
  source_project_url?: unknown;
  storage_copy_concurrency?: unknown;
  hard_timeout_seconds?: unknown;
};

export const startDbMigration = async (
  jobId: string,
  raw: RawDbStart,
  options: DbCloneRunOptions,
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

export const runPreparedDbMigration = async (
  jobId: string,
  input: DbCloneInput,
  options: DbCloneRunOptions,
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

export const getMigrationStatus = async (jobId: string): Promise<JobRecord> => {
  return readJob(jobId);
};

export const getMigrationSummary = async (jobId: string): Promise<MigrationSummary> => {
  return buildMigrationSummary(await readJob(jobId));
};
