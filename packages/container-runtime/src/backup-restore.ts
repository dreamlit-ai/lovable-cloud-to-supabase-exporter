// Restores a Lovable backup archive into the destination Supabase database
// using the plan from backup-plan.ts. Everything runs through the image's
// pg_restore and psql; nothing here talks to the source project.

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  buildRestoreList,
  CopyRowCounter,
  ManagedTableAdapter,
  StorageOwnerRowExtractor,
  parseExtensionStatements,
  SKIPPABLE_TOC_DESCS,
  triggerCallsAppFunction,
  type BackupRestorePlan,
  type DestinationTableColumns,
  type ManagedTableAdjustment,
  type TocEntry,
} from "./backup-plan.js";

const SCHEMA_SKIP_LIMIT = 25;

export type BackupRestoreStage =
  | "check_auth_data"
  | "restore_owners"
  | "prepare_schemas"
  | "prepare_extensions"
  | "restore_schema"
  | "restore_data"
  | "restore_managed_objects"
  | "verify";

export type RestoredTableCount = { table: string; archiveRows: number; targetRows: number | null };

export type SelectiveRestoreResult = {
  restored: string[];
  failed: Array<{ name: string; error: string }>;
};

export type BackupRestoreResult = {
  appSchemas: string[];
  extensionWarnings: string[];
  schemaSkips: string[];
  tables: RestoredTableCount[];
  verificationOk: boolean;
  // Auth tables or columns the destination doesn't have. Entries with rows
  // (or lost values) are data that didn't move.
  managedTableAdjustments: ManagedTableAdjustment[];
  storagePolicies: SelectiveRestoreResult;
  authTriggers: SelectiveRestoreResult;
  materializedViews: SelectiveRestoreResult;
  authUsers: { restored: number; withPassword: number };
  archiveCounts: {
    storageObjects: number | null;
    cronJobs: number | null;
    vaultSecrets: number | null;
  };
  skippedDataTables: string[];
};

// What reading the archive and writing to the destination need.
export type BackupArchiveConnection = {
  archivePath: string;
  workDir: string;
  targetDbUrl: string;
  env: NodeJS.ProcessEnv;
};

export type BackupRestoreEnvironment = BackupArchiveConnection & {
  onStage: (stage: BackupRestoreStage) => Promise<void>;
  log: (level: "info" | "warn", event: string, data: Record<string, unknown>) => void;
};

export class BackupRestoreError extends Error {
  stage: BackupRestoreStage;
  detail: string;

  constructor(stage: BackupRestoreStage, message: string, detail: string) {
    super(message);
    this.name = "BackupRestoreError";
    this.stage = stage;
    this.detail = detail;
  }
}

type CommandResult = { code: number; stdout: string; stderr: string };

const runCommand = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin?: string,
): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });

const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

const psql = async (input: BackupArchiveConnection, sql: string): Promise<CommandResult> =>
  runCommand(
    "psql",
    [input.targetDbUrl, "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", sql],
    input.env,
  );

const writeList = async (
  input: BackupArchiveConnection,
  name: string,
  entries: TocEntry[],
): Promise<string> => {
  const listPath = path.join(input.workDir, name);
  await writeFile(listPath, buildRestoreList(entries));
  return listPath;
};

// Renders archive entries as SQL without touching any database.
const renderEntriesSql = async (
  input: BackupRestoreEnvironment,
  name: string,
  entries: TocEntry[],
): Promise<string> => {
  if (entries.length === 0) return "";
  const listPath = await writeList(input, name, entries);
  const result = await runCommand(
    "pg_restore",
    ["--use-list", listPath, "--file", "-", input.archivePath],
    input.env,
  );
  if (result.code !== 0) {
    throw new BackupRestoreError(
      "restore_schema",
      "Could not read the backup file.",
      result.stderr,
    );
  }
  return result.stdout;
};

const lastLines = (text: string, count = 20) => text.trim().split("\n").slice(-count).join("\n");

const prepareSchemas = async (input: BackupRestoreEnvironment, plan: BackupRestorePlan) => {
  for (const schema of plan.appSchemas) {
    const result = await psql(input, `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)};`);
    if (result.code !== 0) {
      throw new BackupRestoreError(
        "prepare_schemas",
        `Could not create the ${schema} schema in Supabase.`,
        result.stderr,
      );
    }
  }
};

const installedExtensionSchema = async (
  input: BackupRestoreEnvironment,
  name: string,
): Promise<string | null> => {
  const result = await psql(
    input,
    `SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = ${quoteLiteral(name)};`,
  );
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null;
};

// Same policy as the live clone: create what the app used, warn about what
// Supabase can't provide, and keep going.
const prepareExtensions = async (
  input: BackupRestoreEnvironment,
  plan: BackupRestorePlan,
): Promise<string[]> => {
  const sql = await renderEntriesSql(input, "extensions.list", plan.extensionEntries);
  const warnings: string[] = [];
  for (const extension of parseExtensionStatements(sql)) {
    let installedSchema = await installedExtensionSchema(input, extension.name);
    if (!installedSchema) {
      const result = await psql(
        input,
        `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(extension.schema)}; CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(extension.name)} WITH SCHEMA ${quoteIdentifier(extension.schema)};`,
      );
      if (result.code !== 0) {
        warnings.push(`extension ${extension.name} in schema ${extension.schema}`);
        input.log("warn", "backup_restore.extension_failed", {
          extension: extension.name,
          schema: extension.schema,
          error: lastLines(result.stderr, 3),
        });
        continue;
      }
      installedSchema = await installedExtensionSchema(input, extension.name);
    }
    if (installedSchema && installedSchema !== extension.schema) {
      warnings.push(
        `extension ${extension.name} in schema ${extension.schema} (currently installed in schema ${installedSchema})`,
      );
    }
  }
  return warnings;
};

// One transaction; when a non-data object fails, skip it and retry. Mirrors
// restore_schema_with_skips in run-clone.sh.
const restoreSchema = async (
  input: BackupRestoreEnvironment,
  plan: BackupRestorePlan,
): Promise<string[]> => {
  const skips: string[] = [];
  let entries = [...plan.schemaEntries];
  while (entries.length > 0) {
    const listPath = await writeList(input, "schema.list", entries);
    const result = await runCommand(
      "pg_restore",
      [
        "--dbname",
        input.targetDbUrl,
        "--single-transaction",
        "--no-owner",
        "--no-acl",
        "--use-list",
        listPath,
        input.archivePath,
      ],
      input.env,
    );
    if (result.code === 0) return skips;

    const failingId = result.stderr.match(/from TOC entry (\d+);/)?.[1];
    const failing = failingId
      ? entries.find((entry) => entry.id === Number.parseInt(failingId, 10))
      : undefined;
    const error =
      result.stderr.match(/error: could not execute query: (.*)/)?.[1]?.trim() ??
      "error unavailable";
    if (!failing || !SKIPPABLE_TOC_DESCS.has(failing.desc) || skips.length >= SCHEMA_SKIP_LIMIT) {
      throw new BackupRestoreError(
        "restore_schema",
        "Restoring the database structure failed.",
        lastLines(result.stderr),
      );
    }
    const description = `${failing.desc} ${failing.schema ?? "-"} ${failing.name}`;
    skips.push(`${description}: ${error}`);
    input.log("warn", "backup_restore.schema_object_skipped", { object: description, error });
    entries = entries.filter((entry) => entry.id !== failing.id);
  }
  return skips;
};

// Columns of the destination's tables in the managed schemas the data load
// writes to (auth), so the load can adapt to a different auth version.
const readDestinationColumns = async (
  input: BackupRestoreEnvironment,
  schemas: string[],
): Promise<DestinationTableColumns> => {
  const columns: DestinationTableColumns = new Map();
  if (schemas.length === 0) return columns;
  const result = await psql(
    input,
    `SELECT table_schema || '.' || table_name, column_name, is_generated <> 'NEVER' FROM information_schema.columns WHERE table_schema IN (${schemas.map(quoteLiteral).join(", ")});`,
  );
  if (result.code !== 0) {
    throw new BackupRestoreError(
      "restore_data",
      "Could not read the Supabase auth tables.",
      lastLines(result.stderr),
    );
  }
  for (const row of result.stdout.split("\n")) {
    const [table, column, generated] = row.split("|");
    if (!table || !column) continue;
    const tableColumns = columns.get(table) ?? new Map<string, boolean>();
    tableColumns.set(column, generated === "t");
    columns.set(table, tableColumns);
  }
  return columns;
};

// Schemas outside the app's own whose data the restore loads (auth).
const managedDataSchemas = (plan: BackupRestorePlan): string[] => [
  ...new Set(
    plan.dataEntries
      .map((entry) => entry.schema)
      .filter((schema): schema is string => !!schema && !plan.appSchemas.includes(schema)),
  ),
];

// Runs before anything is written: reads the backup's auth data and checks
// it fits the destination's auth tables. Returns every table that needs
// adjusting; findManagedDataGaps picks out the ones that would lose data.
export const checkManagedDataFits = async (
  input: BackupRestoreEnvironment,
  plan: BackupRestorePlan,
): Promise<ManagedTableAdjustment[]> => {
  const managedSchemas = managedDataSchemas(plan);
  const entries = plan.dataEntries.filter(
    (entry) => entry.schema !== null && managedSchemas.includes(entry.schema),
  );
  if (entries.length === 0) return [];
  const adapter = new ManagedTableAdapter(
    await readDestinationColumns(input, managedSchemas),
    new Set(managedSchemas),
  );
  const listPath = await writeList(input, "managed-data-check.list", entries);
  const child = spawn(
    "pg_restore",
    ["--data-only", "--use-list", listPath, "--file", "-", input.archivePath],
    { env: input.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exit = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  await pipeline(
    child.stdout,
    adapter,
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  );
  if ((await exit) !== 0) {
    throw new BackupRestoreError(
      "check_auth_data",
      "Could not read the sign-in data in the backup.",
      lastLines(stderr),
    );
  }
  return [...adapter.adjustments.values()];
};

const restoreData = async (
  input: BackupRestoreEnvironment,
  plan: BackupRestorePlan,
): Promise<{ counts: Map<string, number>; adjustments: ManagedTableAdjustment[] }> => {
  const managedSchemas = managedDataSchemas(plan);
  const adapter = new ManagedTableAdapter(
    await readDestinationColumns(input, managedSchemas),
    new Set(managedSchemas),
  );
  const listPath = await writeList(input, "data.list", plan.dataEntries);
  const restore = spawn(
    "pg_restore",
    ["--data-only", "--use-list", listPath, "--file", "-", input.archivePath],
    { env: input.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const load = spawn("psql", [input.targetDbUrl, "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-q"], {
    env: input.env,
    stdio: ["pipe", "ignore", "pipe"],
  });
  let restoreStderr = "";
  let loadStderr = "";
  restore.stderr.on("data", (chunk: Buffer) => {
    restoreStderr += chunk.toString("utf8");
  });
  load.stderr.on("data", (chunk: Buffer) => {
    loadStderr += chunk.toString("utf8");
  });
  const exited = (child: ReturnType<typeof spawn>) =>
    new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
  const restoreExit = exited(restore);
  const loadExit = exited(load);

  // Replica mode keeps triggers (including foreign keys and the app's own
  // auth.users trigger) from firing while rows load, like the live clone.
  // The counter sees the archive's rows before the adapter leaves any out.
  const counter = new CopyRowCounter();
  const streamed = pipeline(
    restore.stdout,
    counter,
    adapter,
    async function* withTransaction(source: AsyncIterable<Buffer>) {
      yield Buffer.from("BEGIN;\nSET LOCAL session_replication_role = replica;\n");
      for await (const chunk of source) yield chunk;
      // Only commit when the whole archive was read. Throwing here closes
      // psql's input mid-transaction, so the partial load rolls back.
      if ((await restoreExit) !== 0) throw new Error("pg_restore failed");
      yield Buffer.from("\nCOMMIT;\n");
    },
    load.stdin,
  ).catch((error: unknown) => error);

  const [restoreCode, loadCode, streamError] = await Promise.all([restoreExit, loadExit, streamed]);
  // When psql fails first, pg_restore dies of a broken pipe; psql's error is
  // the real cause.
  if (loadCode !== 0) {
    throw new BackupRestoreError(
      "restore_data",
      "Loading table data into Supabase failed.",
      lastLines(loadStderr || String(streamError ?? "")),
    );
  }
  if (restoreCode !== 0 || streamError instanceof Error) {
    throw new BackupRestoreError(
      "restore_data",
      "Could not read table data from the backup.",
      lastLines(restoreStderr || String(streamError ?? "")),
    );
  }
  return { counts: counter.counts, adjustments: [...adapter.adjustments.values()] };
};

// Restores entries one at a time so a single failure is reported, not fatal.
const restoreEachEntry = async (
  input: BackupRestoreEnvironment,
  entries: TocEntry[],
  name: (entry: TocEntry) => string,
): Promise<SelectiveRestoreResult> => {
  const result: SelectiveRestoreResult = { restored: [], failed: [] };
  for (const entry of entries) {
    const listPath = await writeList(input, `entry-${entry.id}.list`, [entry]);
    const restored = await runCommand(
      "pg_restore",
      [
        "--dbname",
        input.targetDbUrl,
        "--single-transaction",
        "--no-owner",
        "--no-acl",
        "--use-list",
        listPath,
        input.archivePath,
      ],
      input.env,
    );
    if (restored.code === 0) {
      result.restored.push(name(entry));
    } else {
      const error =
        restored.stderr.match(/error: could not execute query: (.*)/)?.[1]?.trim() ??
        lastLines(restored.stderr, 2);
      result.failed.push({ name: name(entry), error });
    }
  }
  return result;
};

const restoreManagedObjects = async (input: BackupRestoreEnvironment, plan: BackupRestorePlan) => {
  const appAuthTriggers: TocEntry[] = [];
  for (const entry of plan.authTriggerEntries) {
    const sql = await renderEntriesSql(input, `trigger-${entry.id}.list`, [entry]);
    if (triggerCallsAppFunction(sql, plan.appSchemas)) appAuthTriggers.push(entry);
  }
  const policyName = (entry: TocEntry) => {
    const [table, ...rest] = entry.name.split(" ");
    return `${rest.join(" ")} (storage.${table})`;
  };
  return {
    storagePolicies: await restoreEachEntry(input, plan.storagePolicyEntries, policyName),
    authTriggers: await restoreEachEntry(input, appAuthTriggers, (entry) => {
      const [table, ...rest] = entry.name.split(" ");
      return `${rest.join(" ")} (auth.${table})`;
    }),
    materializedViews: await restoreEachEntry(
      input,
      plan.materializedViewRefreshEntries,
      (entry) => `${entry.schema}.${entry.name}`,
    ),
  };
};

// Row counts for entries we report on but don't restore.
const countArchiveRows = async (
  input: BackupRestoreEnvironment,
  entry: TocEntry | null,
): Promise<number | null> => {
  if (!entry) return null;
  const listPath = await writeList(input, `count-${entry.id}.list`, [entry]);
  const child = spawn(
    "pg_restore",
    ["--data-only", "--use-list", listPath, "--file", "-", input.archivePath],
    { env: input.env, stdio: ["ignore", "pipe", "ignore"] },
  );
  const counter = new CopyRowCounter();
  const exit = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  await pipeline(
    child.stdout,
    counter,
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  );
  if ((await exit) !== 0) return null;
  return counter.counts.get(`${entry.schema}.${entry.name}`) ?? 0;
};

const countTargetRows = async (
  input: BackupRestoreEnvironment,
  table: string,
): Promise<number | null> => {
  const dot = table.indexOf(".");
  const relation = `${quoteIdentifier(table.slice(0, dot))}.${quoteIdentifier(table.slice(dot + 1))}`;
  const result = await psql(input, `SELECT count(*) FROM ${relation};`);
  if (result.code !== 0) return null;
  const count = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(count) ? count : null;
};

export const restoreLovableBackup = async (
  input: BackupRestoreEnvironment,
  plan: BackupRestorePlan,
): Promise<BackupRestoreResult> => {
  await input.onStage("prepare_schemas");
  await prepareSchemas(input, plan);

  await input.onStage("prepare_extensions");
  const extensionWarnings = await prepareExtensions(input, plan);

  await input.onStage("restore_schema");
  const schemaSkips = await restoreSchema(input, plan);

  await input.onStage("restore_data");
  const data = await restoreData(input, plan);
  for (const adjustment of data.adjustments) {
    input.log("warn", "backup_restore.managed_table_adjusted", adjustment);
  }

  await input.onStage("restore_managed_objects");
  const managed = await restoreManagedObjects(input, plan);

  await input.onStage("verify");
  // Tables the destination doesn't have can't be counted; they're reported
  // through managedTableAdjustments instead.
  const missingTables = new Set(
    data.adjustments.filter((adjustment) => adjustment.tableMissing).map((a) => a.table),
  );
  const tables: RestoredTableCount[] = [];
  for (const [table, archiveRows] of [...data.counts.entries()]
    .filter(([table]) => !missingTables.has(table))
    .sort(([left], [right]) => left.localeCompare(right))) {
    tables.push({ table, archiveRows, targetRows: await countTargetRows(input, table) });
  }
  const authUsersResult = await psql(
    input,
    "SELECT count(*), count(*) FILTER (WHERE encrypted_password IS NOT NULL AND encrypted_password <> '') FROM auth.users;",
  );
  const [restoredUsers, usersWithPassword] = authUsersResult.stdout.trim().split("|");

  return {
    appSchemas: plan.appSchemas,
    extensionWarnings,
    schemaSkips,
    tables,
    verificationOk: tables.every((table) => table.targetRows === table.archiveRows),
    managedTableAdjustments: data.adjustments,
    ...managed,
    authUsers: {
      restored: Number.parseInt(restoredUsers ?? "0", 10) || 0,
      withPassword: Number.parseInt(usersWithPassword ?? "0", 10) || 0,
    },
    archiveCounts: {
      storageObjects: await countArchiveRows(input, plan.storageObjectsDataEntry),
      cronJobs: await countArchiveRows(input, plan.cronJobDataEntry),
      vaultSecrets: await countArchiveRows(input, plan.vaultSecretsDataEntry),
    },
    skippedDataTables: plan.skippedDataTables,
  };
};

// pg_restore decides compatibility itself: it reads archives from newer
// pg_dump releases as long as the archive format is one it knows (pg_dump 18
// still writes a format pg_restore 17 reads), and fails with "unsupported
// version" in the file header otherwise.
export const listArchive = async (
  archivePath: string,
  env: NodeJS.ProcessEnv,
): Promise<
  | { ok: true; listing: string }
  | { ok: false; reason: "unsupported_archive_version" | "unreadable"; error: string }
> => {
  const result = await runCommand("pg_restore", ["--list", archivePath], env);
  const error = lastLines(result.stderr, 5);
  if (/unsupported version .* in file header/i.test(result.stderr)) {
    return { ok: false, reason: "unsupported_archive_version", error };
  }
  if (result.code !== 0 || /does not support compression/i.test(result.stderr)) {
    return { ok: false, reason: "unreadable", error };
  }
  return { ok: true, listing: result.stdout };
};

export type StorageOwnerRestoreResult = {
  // Files the backup lists with an owner.
  owned: number;
  // Of those, files now in the destination with the same owner.
  restored: number;
  // Owned files that aren't in the destination (not copied, or deleted since
  // the export).
  notFound: number;
};

// Copies file owners from the backup's storage.objects rows onto the files
// already copied into the destination. Safe to run again: it only touches
// rows whose owner differs.
export const restoreStorageObjectOwners = async (
  input: BackupArchiveConnection,
  entry: TocEntry | null,
): Promise<StorageOwnerRestoreResult> => {
  const none = { owned: 0, restored: 0, notFound: 0 };
  if (!entry) return none;
  const columns = await psql(
    input,
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'objects' AND column_name IN ('owner', 'owner_id');",
  );
  if (columns.code !== 0) {
    throw new BackupRestoreError(
      "restore_owners",
      "Could not read the storage files table.",
      lastLines(columns.stderr),
    );
  }
  const available = new Set(columns.stdout.split("\n").map((line) => line.trim()));
  const assignments = [
    available.has("owner") ? "owner = s.owner::uuid" : null,
    available.has("owner_id") ? "owner_id = s.owner_id" : null,
  ].filter((value): value is string => value !== null);
  if (assignments.length === 0) return none;
  const differs = [
    available.has("owner") ? "o.owner IS DISTINCT FROM s.owner::uuid" : null,
    available.has("owner_id") ? "o.owner_id IS DISTINCT FROM s.owner_id" : null,
  ].filter((value): value is string => value !== null);

  const listPath = await writeList(input, "storage-owners.list", [entry]);
  const restore = spawn(
    "pg_restore",
    ["--data-only", "--use-list", listPath, "--file", "-", input.archivePath],
    { env: input.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const load = spawn("psql", [input.targetDbUrl, "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-Atq"], {
    env: input.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let restoreStderr = "";
  let loadStdout = "";
  let loadStderr = "";
  restore.stderr.on("data", (chunk: Buffer) => {
    restoreStderr += chunk.toString("utf8");
  });
  load.stdout.on("data", (chunk: Buffer) => {
    loadStdout += chunk.toString("utf8");
  });
  load.stderr.on("data", (chunk: Buffer) => {
    loadStderr += chunk.toString("utf8");
  });
  const exited = (child: ReturnType<typeof spawn>) =>
    new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
  const restoreExit = exited(restore);
  const loadExit = exited(load);
  const extractor = new StorageOwnerRowExtractor();
  const matches = "o.bucket_id = s.bucket_id AND o.name = s.name";
  const streamed = pipeline(
    restore.stdout,
    extractor,
    async function* ownerScript(source: AsyncIterable<Buffer>) {
      // Replica mode keeps storage's own triggers (updated_at and the like)
      // from firing for an owner-only change.
      yield Buffer.from(
        "BEGIN;\nSET LOCAL session_replication_role = replica;\nCREATE TEMP TABLE migration_storage_owners (bucket_id text, name text, owner text, owner_id text) ON COMMIT DROP;\nCOPY migration_storage_owners FROM stdin;\n",
      );
      for await (const chunk of source) yield chunk;
      if ((await restoreExit) !== 0) throw new Error("pg_restore failed");
      yield Buffer.from(
        [
          "\\.",
          `UPDATE storage.objects o SET ${assignments.join(", ")} FROM migration_storage_owners s WHERE ${matches} AND (${differs.join(" OR ")});`,
          `SELECT (SELECT count(*) FROM migration_storage_owners) || '|' || (SELECT count(*) FROM migration_storage_owners s JOIN storage.objects o ON ${matches} WHERE NOT (${differs.join(" OR ")})) || '|' || (SELECT count(*) FROM migration_storage_owners s WHERE NOT EXISTS (SELECT 1 FROM storage.objects o WHERE ${matches}));`,
          "COMMIT;",
          "",
        ].join("\n"),
      );
    },
    load.stdin,
  ).catch((error: unknown) => error);
  const [restoreCode, loadCode, streamError] = await Promise.all([restoreExit, loadExit, streamed]);
  if (loadCode !== 0) {
    throw new BackupRestoreError(
      "restore_owners",
      "Could not restore file owners.",
      lastLines(loadStderr || String(streamError ?? "")),
    );
  }
  if (restoreCode !== 0 || streamError instanceof Error) {
    throw new BackupRestoreError(
      "restore_owners",
      "Could not read file owners from the backup.",
      lastLines(restoreStderr || String(streamError ?? "")),
    );
  }
  const [owned, restored, notFound] =
    loadStdout
      .trim()
      .split("\n")
      .at(-1)
      ?.split("|")
      .map((value) => Number.parseInt(value, 10)) ?? [];
  return { owned: owned ?? 0, restored: restored ?? 0, notFound: notFound ?? 0 };
};
