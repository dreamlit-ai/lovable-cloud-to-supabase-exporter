import { describe, expect, it } from "vitest";
import { BackupRestoreError } from "../backup-restore.js";
import { buildBackupRestoreRunnerError } from "../export-runner.js";

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
