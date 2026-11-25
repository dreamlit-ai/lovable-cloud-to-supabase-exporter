import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTocList, planBackupRestore } from "../backup-plan";
import {
  BackupRestoreError,
  restoreLovableBackup,
  type BackupRestoreStage,
} from "../backup-restore";
import { buildBackupRestoreRunnerError } from "../export-runner";

const table = "1; 1259 100 TABLE public todos postgres";
const data = "2; 0 100 TABLE DATA public todos postgres";
const badIndex = "3; 1259 101 INDEX public bad_idx postgres";
const goodIndex = "4; 1259 102 INDEX public good_idx postgres";
const plan = planBackupRestore(parseTocList([table, data, badIndex, goodIndex].join("\n")), {
  excludeDataTables: [],
});

const copy = "COPY public.todos (id) FROM stdin;\n1\n2\n\\.\n";
const tempDirs: string[] = [];

const setup = async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "backup-restore-"));
  tempDirs.push(workDir);
  const traceFile = path.join(workDir, "trace");
  const sqlFile = path.join(workDir, "sql");
  const stages: BackupRestoreStage[] = [];
  await writeFile(
    path.join(workDir, "pg_restore"),
    [
      "#!/bin/sh",
      "set -eu",
      "cat >/dev/null",
      'if [ "$1" = "--data-only" ]; then',
      '  printf "data\\n" >>"$TRACE_FILE"',
      '  cat "$COPY_FILE"',
      '  exit "${DATA_STATUS:-0}"',
      "fi",
      'printf "%s PGOPTIONS=%s\\n" "$*" "$PGOPTIONS" >>"$TRACE_FILE"',
      'section=""',
      'list=""',
      "verbose=0",
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    --section=*) section="${1#--section=}" ;;',
      '    --use-list) list="$2"; shift ;;',
      "    --verbose) verbose=1 ;;",
      "  esac",
      "  shift",
      "done",
      'if [ "$section" = "post-data" ] && grep -q "^3;" "$list"; then',
      '  if [ "$verbose" -eq 1 ]; then',
      '    printf "pg_restore: from TOC entry %s\\n" "$BAD_INDEX" >&2',
      "  fi",
      '  printf "%s\\n" "${POST_DATA_ERROR:-pg_restore: error: could not execute query: ERROR: index expression failed}" >&2',
      "  exit 1",
      "fi",
      'cat "$list" >>"$TRACE_FILE"',
    ].join("\n"),
    { mode: 0o755 },
  );
  await writeFile(
    path.join(workDir, "psql"),
    [
      "#!/bin/sh",
      'case "$*" in',
      '  *"FROM auth.users;"*) cat >/dev/null; printf "0|0\\n" ;;',
      '  *\'FROM "public"."todos";\'*) cat >/dev/null; printf "2\\n" ;;',
      '  *" -c "*) cat >/dev/null ;;',
      '  *) cat >"$SQL_FILE" ;;',
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );
  const copyFile = path.join(workDir, "copy.sql");
  await writeFile(copyFile, copy);
  return {
    traceFile,
    sqlFile,
    stages,
    input: {
      workDir,
      archivePath: path.join(workDir, "archive"),
      targetDbUrl: "postgresql://target.example/db",
      env: {
        PATH: workDir + path.delimiter + process.env.PATH,
        PGOPTIONS: "-c statement_timeout=0",
        TRACE_FILE: traceFile,
        SQL_FILE: sqlFile,
        COPY_FILE: copyFile,
        BAD_INDEX: badIndex,
      },
      onStage: async (stage: BackupRestoreStage) => {
        stages.push(stage);
      },
      log: vi.fn(),
    },
  };
};

describe("restoreLovableBackup", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("runs schema sections around one data transaction and retries post-data skips", async () => {
    const { input, stages, traceFile, sqlFile } = await setup();
    const restore = await restoreLovableBackup(input, plan);

    expect(stages).toEqual([
      "prepare_schemas",
      "prepare_extensions",
      "restore_schema",
      "restore_data",
      "restore_post_data",
      "restore_managed_objects",
      "verify",
    ]);
    const trace = (await readFile(traceFile, "utf8")).trim().split("\n");
    const preData = expect.stringMatching(
      /--single-transaction .*--section=pre-data .*PGOPTIONS=-c statement_timeout=0$/,
    );
    const postData = expect.stringMatching(
      /--single-transaction .*--section=post-data .*PGOPTIONS=-c statement_timeout=0 -c max_parallel_maintenance_workers=0$/,
    );
    expect(trace).toEqual([
      preData,
      table,
      badIndex,
      goodIndex,
      "data",
      postData,
      postData,
      table,
      goodIndex,
    ]);
    expect(await readFile(sqlFile, "utf8")).toBe(
      "BEGIN;\nSET LOCAL session_replication_role = replica;\n" + copy + "\nCOMMIT;\n",
    );
    expect(restore.schemaSkips).toEqual(["INDEX public bad_idx: ERROR: index expression failed"]);
    expect(restore.verificationOk).toBe(true);
  });

  it("stops post-data without skipping when the target crashes mid-index", async () => {
    const { input, traceFile } = await setup();
    Object.assign(input.env, {
      POST_DATA_ERROR:
        "pg_restore: error: could not execute query: server closed the connection unexpectedly",
    });
    const error = await restoreLovableBackup(input, plan).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BackupRestoreError);
    expect(error).toMatchObject({
      stage: "restore_post_data",
      dataRestore: { targetStage: "restore_data" },
    });
    const trace = await readFile(traceFile, "utf8");
    expect(trace.match(/--section=post-data/g)).toHaveLength(1);
    expect(buildBackupRestoreRunnerError(error as BackupRestoreError, 8192, 12)).toMatchObject({
      message: "Restoring the database structure failed.",
      exitCode: 43,
      failureClass: "target_db_crashed",
    });
  });

  it("omits COMMIT and skips post-data if pg_restore exits after a complete COPY", async () => {
    const { input, stages, sqlFile } = await setup();
    Object.assign(input.env, { DATA_STATUS: "1" });
    await expect(restoreLovableBackup(input, plan)).rejects.toMatchObject({
      stage: "restore_data",
    });

    expect(await readFile(sqlFile, "utf8")).toBe(
      "BEGIN;\nSET LOCAL session_replication_role = replica;\n" + copy,
    );
    expect(stages.at(-1)).toBe("restore_data");
  });
});

describe("backup restore failure events", () => {
  it("reports backup metadata and the last observed COPY table after a target crash", () => {
    const error = new BackupRestoreError(
      "restore_data",
      "Loading table data into Supabase failed.",
      "WARNING:  57P02: terminating connection because of crash of another server process\nserver closed the connection unexpectedly\nconnection to server was lost",
      { targetStage: "restore_data", lastCopyTable: "public.todos" },
    );

    expect(buildBackupRestoreRunnerError(error, 8192, 12)).toMatchObject({
      phase: "db_clone.failed",
      exitCode: 44,
      failureClass: "target_db_crashed",
      errorExcerpt: expect.stringContaining("crash of another server process"),
      eventData: {
        stage: "restore_data",
        backup_bytes: 8192,
        table_count: 12,
        last_copy_table: "public.todos",
      },
    });
  });

  it("keeps a generic target data failure and omits COPY row values from diagnostics", () => {
    const error = new BackupRestoreError(
      "restore_data",
      "Loading table data into Supabase failed.",
      'psql:<stdin>:88: ERROR:  22P02: invalid input syntax for integer: "server closed the connection unexpectedly"\nCONTEXT: COPY todos, line 1: "private row value"',
      { targetStage: "restore_data" },
    );

    expect(buildBackupRestoreRunnerError(error, 8192, 12)).toMatchObject({
      failureClass: "backup_data_restore_failed",
      errorExcerpt: "PostgreSQL error 22P02",
      eventData: { last_copy_table: null },
    });
  });

  it("does not infer a target crash from a failure reading the backup", () => {
    const error = new BackupRestoreError(
      "restore_data",
      "Could not read table data from the backup.",
      "server closed the connection unexpectedly",
    );

    expect(buildBackupRestoreRunnerError(error, 8192, 12)).toMatchObject({
      failureClass: "backup_data_restore_failed",
      errorExcerpt: null,
    });
  });
});
