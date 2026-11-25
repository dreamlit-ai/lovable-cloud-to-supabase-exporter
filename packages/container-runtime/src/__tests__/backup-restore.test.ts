import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTocList, planBackupRestore } from "../backup-plan";
import {
  BackupRestoreError,
  extractDropStatements,
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
// What pg_restore --clean --if-exists prints: settings, the drops, then the
// first object it would create.
const cleanOutput = [
  "--",
  "-- PostgreSQL database dump",
  "--",
  "",
  "\\restrict token",
  "",
  "SET statement_timeout = 0;",
  "SELECT pg_catalog.set_config('search_path', '', false);",
  "",
  "DROP TABLE IF EXISTS public.todos;",
  "--",
  "-- Name: todos; Type: TABLE; Schema: public; Owner: -",
  "--",
  "",
  "CREATE TABLE public.todos (id integer);",
  "",
  "\\unrestrict token",
  "",
].join("\n");
const undoScript = [
  "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE;",
  "BEGIN;",
  "--",
  "-- PostgreSQL database dump",
  "--",
  "",
  "",
  "SET statement_timeout = 0;",
  "SELECT pg_catalog.set_config('search_path', '', false);",
  "",
  "DROP TABLE IF EXISTS public.todos;",
  "--",
  "",
  "COMMIT;",
  "",
].join("\n");
const diskFull =
  'psql:<stdin>:4: ERROR:  53100: could not extend file "base/5/19833": No space left on device';
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
      'case " $* " in *" --clean "*)',
      '  printf "clean\\n" >>"$TRACE_FILE"',
      '  while [ "$#" -gt 0 ]; do [ "$1" = "--use-list" ] && cat "$2" >>"$TRACE_FILE"; shift; done',
      '  cat "$CLEAN_FILE"',
      "  exit 0 ;;",
      "esac",
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
      '  *"DROP SCHEMA"*) cat >/dev/null; printf "%s\\n" "$*" >>"$UNDO_FILE" ;;',
      '  *" -c "*) cat >/dev/null ;;',
      '  *"VERBOSITY=verbose"*)',
      '    cat >"$SQL_FILE"',
      '    if [ -n "${LOAD_ERROR:-}" ]; then printf "%s\\n" "$LOAD_ERROR" >&2; exit 3; fi ;;',
      "  *)",
      '    cat >>"$UNDO_FILE"',
      '    if [ -n "${UNDO_ERROR:-}" ]; then',
      '      attempts=$(cat "$UNDO_FILE.attempts" 2>/dev/null || printf 0)',
      '      printf "%s" "$((attempts + 1))" >"$UNDO_FILE.attempts"',
      '      if [ "$attempts" -lt "${UNDO_FAILURES:-1}" ]; then printf "%s\\n" "$UNDO_ERROR" >&2; exit 2; fi',
      "    fi ;;",
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );
  const copyFile = path.join(workDir, "copy.sql");
  await writeFile(copyFile, copy);
  const cleanFile = path.join(workDir, "clean.sql");
  await writeFile(cleanFile, cleanOutput);
  const undoFile = path.join(workDir, "undo");
  return {
    traceFile,
    sqlFile,
    undoFile,
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
        CLEAN_FILE: cleanFile,
        UNDO_FILE: undoFile,
        BAD_INDEX: badIndex,
      },
      onStage: async (stage: BackupRestoreStage) => {
        stages.push(stage);
      },
      log: vi.fn(),
      undoRetry: { waitMs: 200, delayMs: 10 },
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

  it("stops post-data without skipping when the target disk fills mid-index", async () => {
    const { input, traceFile } = await setup();
    Object.assign(input.env, {
      POST_DATA_ERROR:
        'pg_restore: error: could not execute query: ERROR:  could not extend file "base/5/19900": No space left on device',
    });
    const error = await restoreLovableBackup(input, plan).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ stage: "restore_post_data" });
    const trace = await readFile(traceFile, "utf8");
    expect(trace.match(/--section=post-data/g)).toHaveLength(1);
    expect(buildBackupRestoreRunnerError(error as BackupRestoreError, 8192, 12)).toMatchObject({
      exitCode: 43,
      failureClass: "target_db_storage_exhausted",
    });
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
    // Nothing was committed, so the run takes its tables back out.
    expect(stages.slice(-2)).toEqual(["restore_data", "undo_restore"]);
  });
});

describe("undoing a failed restore", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("keeps only the settings and drops from pg_restore --clean", () => {
    const drops = extractDropStatements(cleanOutput);
    expect(drops).toContain("DROP TABLE IF EXISTS public.todos;");
    expect(drops).toContain("set_config('search_path'");
    expect(drops).not.toContain("CREATE TABLE");
    expect(drops).not.toContain("restrict");
    expect(extractDropStatements("SET statement_timeout = 0;\n")).toBe("");
  });

  it("drops what the run created when the data load fails, so the target is empty again", async () => {
    const { input, stages, traceFile, undoFile } = await setup();
    Object.assign(input.env, { LOAD_ERROR: diskFull });
    const error = await restoreLovableBackup(input, plan).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BackupRestoreError);
    expect(error).toMatchObject({
      stage: "restore_data",
      structureUndone: true,
      dataRestore: { dataBytesSent: copy.length },
    });
    expect(stages).toEqual([
      "prepare_schemas",
      "prepare_extensions",
      "restore_schema",
      "restore_data",
      "undo_restore",
    ]);
    // The drops come from the same entries the pre-data step created.
    const trace = (await readFile(traceFile, "utf8")).trim().split("\n");
    expect(trace.slice(-4)).toEqual(["clean", table, badIndex, goodIndex]);
    // One transaction of drops. public is never dropped.
    expect(await readFile(undoFile, "utf8")).toBe(undoScript);
  });

  it("drops the schemas the run created, after the objects in them", async () => {
    const { input, undoFile } = await setup();
    Object.assign(input.env, { LOAD_ERROR: diskFull });
    const withAppSchema = planBackupRestore(
      parseTocList(["5; 2615 200 SCHEMA - app postgres", table, data].join("\n")),
      { excludeDataTables: [] },
    );
    const error = await restoreLovableBackup(input, withAppSchema).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ structureUndone: true });
    const undo = await readFile(undoFile, "utf8");
    expect(undo.startsWith(undoScript)).toBe(true);
    expect(undo.slice(undoScript.length)).toContain('DROP SCHEMA IF EXISTS "app";');
    expect(undo).not.toContain('"public"');
  });

  it("waits for a target that is restarting after the failure", async () => {
    const { input, undoFile } = await setup();
    Object.assign(input.env, {
      LOAD_ERROR: diskFull,
      UNDO_ERROR:
        'psql: error: connection to server at "db.example" (10.0.0.1), port 5432 failed: FATAL:  the database system is in recovery mode',
      UNDO_FAILURES: "2",
    });
    const error = await restoreLovableBackup(input, plan).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ stage: "restore_data", structureUndone: true });
    expect(await readFile(`${undoFile}.attempts`, "utf8")).toBe("3");
  });

  it("reports the target as not undone when it stays down", async () => {
    const { input } = await setup();
    Object.assign(input.env, {
      LOAD_ERROR: diskFull,
      UNDO_ERROR:
        'psql: error: connection to server at "db.example" (10.0.0.1), port 5432 failed: FATAL:  the database system is in recovery mode',
      UNDO_FAILURES: "1000",
    });
    const error = await restoreLovableBackup(input, plan).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ stage: "restore_data", structureUndone: false });
    expect(input.log).toHaveBeenCalledWith(
      "warn",
      "backup_restore.undo_failed",
      expect.objectContaining({ error: expect.stringContaining("recovery mode") }),
    );
  });

  it("does not retry an undo that fails for another reason", async () => {
    const { input, undoFile } = await setup();
    Object.assign(input.env, {
      LOAD_ERROR: diskFull,
      UNDO_ERROR: "psql:<stdin>:9: ERROR:  2BP01: cannot drop table public.todos",
      UNDO_FAILURES: "1000",
    });
    const error = await restoreLovableBackup(input, plan).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ structureUndone: false });
    expect(await readFile(`${undoFile}.attempts`, "utf8")).toBe("1");
  });

  it("leaves the target alone once rows are committed", async () => {
    const { input, stages, traceFile } = await setup();
    Object.assign(input.env, {
      POST_DATA_ERROR:
        "pg_restore: error: could not execute query: server closed the connection unexpectedly",
    });
    const error = await restoreLovableBackup(input, plan).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ stage: "restore_post_data", structureUndone: false });
    expect(stages).not.toContain("undo_restore");
    expect(await readFile(traceFile, "utf8")).not.toContain("clean");
  });
});

describe("backup restore failure events", () => {
  it("reports a full target disk during the data load as storage exhausted", () => {
    const error = new BackupRestoreError(
      "restore_data",
      "Loading table data into Supabase failed.",
      'psql:<stdin>:4301: ERROR:  could not extend file "base/5/19833": No space left on device\nHINT:  Check free disk space.\nCONTEXT:  COPY bookings, line 4299: "private row value"',
      { targetStage: "restore_data", lastCopyTable: "public.bookings" },
    );

    const runnerError = buildBackupRestoreRunnerError(error, 8192, 12);
    expect(runnerError).toMatchObject({
      exitCode: 44,
      failureClass: "target_db_storage_exhausted",
      failureHint: expect.stringContaining("increase the project's disk size"),
      errorExcerpt: "No space left on device",
      eventData: { last_copy_table: "public.bookings" },
    });
    expect(JSON.stringify(runnerError)).not.toContain("private row value");
  });

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

  it("tells the user to keep the project when the failed restore was undone", () => {
    const fullDisk = new BackupRestoreError(
      "restore_data",
      "Loading table data into Supabase failed.",
      diskFull,
      { targetStage: "restore_data", lastCopyTable: "public.todos", dataBytesSent: 4096 },
    );

    const undone = buildBackupRestoreRunnerError(fullDisk, 8192, 12, true);
    expect(undone).toMatchObject({
      failureClass: "target_db_storage_exhausted",
      eventData: { target_left_empty: true, data_bytes_sent: 4096 },
    });
    expect(undone.failureHint).toContain("this project is empty again");
    expect(undone.failureHint).toContain("increase its disk size");
    expect(undone.failureHint).not.toContain("new empty project");

    const leftBehind = buildBackupRestoreRunnerError(fullDisk, 8192, 12);
    expect(leftBehind.failureHint).toContain("new empty project");
    expect(leftBehind.eventData).toMatchObject({ target_left_empty: false });

    const other = new BackupRestoreError(
      "restore_data",
      "Loading table data into Supabase failed.",
      "psql:<stdin>:88: ERROR:  22P02: invalid input syntax for integer",
      { targetStage: "restore_data" },
    );
    expect(buildBackupRestoreRunnerError(other, 8192, 12, true).failureHint).toBe(
      "We removed the partial restore, so this project is empty again. Try again. Contact us if it fails again.",
    );
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
