import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertTargetDbConnection,
  countSourceAppTables,
  inspectSourceCloneTableCount,
  resolveSourceObjectEnumerator,
} from "../export-runner.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));

const dbUrl = "postgresql://postgres:secret-word@pooler.supabase.com/postgres";
const warning = 'WARNING: database "postgres" has a collation version mismatch';

const queuePsqlResult = (stdout: string, stderr = warning, code = 0): void => {
  spawn.mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    queueMicrotask(() => {
      child.stderr.end(`${stderr}\n`);
      child.stdout.end(`${stdout}\n`);
      child.emit("close", code);
    });
    return child;
  });
};

afterEach(() => {
  spawn.mockReset();
  vi.restoreAllMocks();
});

describe("psql query output", () => {
  it("parses counts and storage rows even when psql logs a warning", async () => {
    const stderr = vi.spyOn(process.stderr, "write");
    queuePsqlResult("1", `${warning}: ${dbUrl}`);
    queuePsqlResult('{"object_path":"folder/café.png","metadata":{"size":42}}');
    queuePsqlResult("5");
    queuePsqlResult("8");

    const enumerator = await resolveSourceObjectEnumerator({
      sourceDbUrl: dbUrl,
      postProgress: vi.fn(),
    });
    const batch = vi.fn();
    await enumerator.forEachBucketObjectBatch("photos", batch);

    expect(enumerator.exactTotalObjects).toBe(1);
    expect(batch).toHaveBeenCalledWith({
      prefix: "folder/",
      fileObjects: [{ fullPath: "folder/café.png", metadata: { size: 42 } }],
    });
    await expect(countSourceAppTables(dbUrl, ["public"])).resolves.toBe(5);
    await expect(inspectSourceCloneTableCount(dbUrl, { dataSchemas: ["public"] })).resolves.toBe(8);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(warning));
    expect(stderr.mock.calls.flat().join("")).not.toContain("secret-word");
  });

  it.each(["", "12 invalid"])(
    "lists storage even when the successful count is %j",
    async (count) => {
      queuePsqlResult(count);
      queuePsqlResult('{"object_path":"folder/photo.png","metadata":null}');
      const postProgress = vi.fn();

      const enumerator = await resolveSourceObjectEnumerator({ sourceDbUrl: dbUrl, postProgress });
      const batch = vi.fn();
      await enumerator.forEachBucketObjectBatch("photos", batch);

      expect(enumerator.exactTotalObjects).toBeNull();
      expect(postProgress).toHaveBeenLastCalledWith(
        expect.objectContaining({
          level: "warn",
          data: { stage: "count_source_objects", objects_total: null },
        }),
      );
      expect(batch).toHaveBeenCalledWith({
        prefix: "folder/",
        fileObjects: [{ fullPath: "folder/photo.png", metadata: null }],
      });
    },
  );

  it("fails storage discovery on a query error and keeps sanitized diagnostics", async () => {
    queuePsqlResult("partial result", `ERROR: permission denied at ${dbUrl}`, 1);

    await expect(
      resolveSourceObjectEnumerator({ sourceDbUrl: dbUrl, postProgress: vi.fn() }),
    ).rejects.toMatchObject({
      failureClass: "storage_discovery_failed",
      message: expect.stringMatching(
        /partial result\nERROR: permission denied at <redacted-postgres-url>/,
      ),
    });
  });

  it("tells users to wait when target validation hits a restarting database", async () => {
    queuePsqlResult(
      "",
      'psql: error: connection to server at "pooler.supabase.com" failed: FATAL: the database system is not accepting connections\nDETAIL: Hot standby mode is disabled.',
      2,
    );

    await expect(assertTargetDbConnection(dbUrl)).rejects.toMatchObject({
      failureClass: "target_db_restarting",
      failureHint: "Your Supabase database is restarting. Wait a minute, then try again.",
      exitCode: 67,
    });
  });

  it("offers retry guidance when the Supabase pooler times out", async () => {
    queuePsqlResult(
      "",
      'psql: error: connection to server at "pooler.supabase.com" failed: timeout expired',
      2,
    );

    await expect(assertTargetDbConnection(dbUrl)).rejects.toMatchObject({
      message: "Supabase did not respond in time.",
      failureClass: "target_db_connection_failed",
      failureHint: "Try again in a few minutes.",
    });
  });
});
