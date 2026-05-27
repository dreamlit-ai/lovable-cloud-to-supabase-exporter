import { describe, expect, it, vi } from "vitest";
import {
  JOB_POLL_CONNECTION_INTERRUPTED_MESSAGE,
  JOB_POLL_CONNECTION_TIMEOUT_MESSAGE,
  pollDownloadJobStatusUntilComplete,
  pollJobStatusUntilComplete,
  pollStartedJobStatus,
  type MigrationJobRecord,
} from "../job-polling";

const buildRecord = (
  status: MigrationJobRecord["status"],
  events: MigrationJobRecord["events"] = [],
): MigrationJobRecord => ({
  status,
  run_id: "run-1",
  started_at: "2026-05-27T12:00:00.000Z",
  finished_at: status === "running" ? null : "2026-05-27T12:01:00.000Z",
  error: status === "failed" ? "Export failed." : null,
  events,
  debug: null,
});

const buildEmptyIdleRecord = (): MigrationJobRecord => ({
  status: "idle",
  run_id: null,
  started_at: null,
  finished_at: null,
  error: null,
  events: [],
  debug: null,
});

describe("job status polling", () => {
  it("retries transient fetch failures and clears the reconnect notice after recovery", async () => {
    const running = buildRecord("running");
    const succeeded = buildRecord("succeeded");
    const getStatus = vi
      .fn<() => Promise<MigrationJobRecord>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(succeeded);
    const updates: MigrationJobRecord[] = [];
    const interrupted = vi.fn();
    const restored = vi.fn();
    const sleep = vi.fn(async () => undefined);

    await expect(
      pollJobStatusUntilComplete({
        getStatus,
        onUpdate: (record) => updates.push(record),
        onConnectionInterrupted: interrupted,
        onConnectionRestored: restored,
        sleep,
      }),
    ).resolves.toBe(succeeded);

    expect(getStatus).toHaveBeenCalledTimes(3);
    expect(interrupted).toHaveBeenCalledWith(JOB_POLL_CONNECTION_INTERRUPTED_MESSAGE);
    expect(restored).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([running, succeeded]);
    expect(sleep).toHaveBeenCalledWith(1200);
  });

  it("does not retry API response failures as client network interruptions", async () => {
    const getStatus = vi
      .fn<() => Promise<MigrationJobRecord>>()
      .mockRejectedValue(new Error("Unauthorized"));
    const sleep = vi.fn(async () => undefined);

    await expect(
      pollJobStatusUntilComplete({
        getStatus,
        onUpdate: () => undefined,
        sleep,
      }),
    ).rejects.toThrow("Unauthorized");

    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fails with a friendly message after a sustained polling outage", async () => {
    const getStatus = vi
      .fn<() => Promise<MigrationJobRecord>>()
      .mockRejectedValue(new TypeError("Failed to fetch"));
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(11);
    const sleep = vi.fn(async () => undefined);

    await expect(
      pollJobStatusUntilComplete({
        getStatus,
        onUpdate: () => undefined,
        reconnectTimeoutMs: 10,
        sleep,
        now,
      }),
    ).rejects.toThrow(JOB_POLL_CONNECTION_TIMEOUT_MESSAGE);

    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("keeps the last download record while retrying after artifact readiness", async () => {
    const ready = buildRecord("running", [
      {
        at: "2026-05-27T12:00:10.000Z",
        level: "info",
        phase: "artifact_delivery.ready",
        message: "ZIP artifact is ready to stream.",
      },
    ]);
    const succeeded = buildRecord("succeeded");
    const getStatus = vi
      .fn<() => Promise<MigrationJobRecord>>()
      .mockResolvedValueOnce(ready)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(succeeded);
    const updates: MigrationJobRecord[] = [];
    const onArtifactReady = vi.fn();
    const sleep = vi.fn(async () => undefined);

    await expect(
      pollDownloadJobStatusUntilComplete({
        getStatus,
        onUpdate: (record) => updates.push(record),
        isArtifactReady: (record) =>
          record.status === "succeeded" ||
          record.events.some((event) => event.phase === "artifact_delivery.ready"),
        onArtifactReady,
        sleep,
      }),
    ).resolves.toBe(succeeded);

    expect(updates).toEqual([ready, ready, succeeded]);
    expect(onArtifactReady).toHaveBeenCalledTimes(1);
    expect(onArtifactReady).toHaveBeenCalledWith(ready);
  });

  it("retries download polling even before the first status record arrives", async () => {
    const running = buildRecord("running");
    const succeeded = buildRecord("succeeded");
    const getStatus = vi
      .fn<() => Promise<MigrationJobRecord>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(succeeded);
    const updates: MigrationJobRecord[] = [];
    const interrupted = vi.fn();
    const sleep = vi.fn(async () => undefined);

    await expect(
      pollDownloadJobStatusUntilComplete({
        getStatus,
        onUpdate: (record) => updates.push(record),
        isArtifactReady: (record) => record.status === "succeeded",
        onArtifactReady: () => undefined,
        onConnectionInterrupted: interrupted,
        sleep,
      }),
    ).resolves.toBe(succeeded);

    expect(getStatus).toHaveBeenCalledTimes(3);
    expect(interrupted).toHaveBeenCalledWith(JOB_POLL_CONNECTION_INTERRUPTED_MESSAGE);
    expect(updates).toEqual([running, succeeded]);
  });

  it("confirms a started job after transient start-response loss and status retry", async () => {
    const running = buildRecord("running");
    const getStatus = vi
      .fn<() => Promise<MigrationJobRecord>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(running);
    const interrupted = vi.fn();
    const restored = vi.fn();
    const updates: MigrationJobRecord[] = [];
    const sleep = vi.fn(async () => undefined);

    await expect(
      pollStartedJobStatus({
        getStatus,
        onUpdate: (record) => updates.push(record),
        onConnectionInterrupted: interrupted,
        onConnectionRestored: restored,
        sleep,
      }),
    ).resolves.toBe(running);

    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(interrupted).toHaveBeenCalledWith(JOB_POLL_CONNECTION_INTERRUPTED_MESSAGE);
    expect(restored).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([running]);
  });

  it("returns null when start-response loss has no status evidence of a job", async () => {
    const idle = buildEmptyIdleRecord();
    const getStatus = vi.fn<() => Promise<MigrationJobRecord>>().mockResolvedValueOnce(idle);
    const updates: MigrationJobRecord[] = [];
    const sleep = vi.fn(async () => undefined);

    await expect(
      pollStartedJobStatus({
        getStatus,
        onUpdate: (record) => updates.push(record),
        sleep,
      }),
    ).resolves.toBeNull();

    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([]);
    expect(sleep).not.toHaveBeenCalled();
  });
});
