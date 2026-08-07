import { createServer } from "node:http";
import { get } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { RunnerError, serveArtifactLiveStream } from "../export-runner.js";

type ProgressPayload = {
  level: string;
  phase: string;
  status?: string;
  data?: Record<string, unknown>;
};

const originalLivePort = process.env.ARTIFACT_LIVE_PORT;
const originalLiveTimeout = process.env.ARTIFACT_LIVE_TIMEOUT_SECONDS;
const originalStallTimeout = process.env.ARTIFACT_STREAM_STALL_TIMEOUT_SECONDS;

const reservePort = async (): Promise<number> =>
  await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not reserve an artifact test port."));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("Timed out waiting for artifact stream test state.");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

const abortAfterFirstChunk = async (port: number): Promise<void> =>
  await new Promise<void>((resolve, reject) => {
    const req = get(`http://127.0.0.1:${port}/artifact`);
    req.once("error", (error) => {
      if (!req.destroyed) reject(error);
    });
    req.once("response", (res) => {
      res.once("error", () => undefined);
      res.once("data", () => {
        res.destroy();
        resolve();
      });
    });
  });

const hasCompleteZipTrailer = (body: Uint8Array): boolean =>
  Buffer.from(body).includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]));

describe.sequential("retryable artifact live stream", () => {
  afterEach(() => {
    if (originalLivePort === undefined) delete process.env.ARTIFACT_LIVE_PORT;
    else process.env.ARTIFACT_LIVE_PORT = originalLivePort;
    if (originalLiveTimeout === undefined) delete process.env.ARTIFACT_LIVE_TIMEOUT_SECONDS;
    else process.env.ARTIFACT_LIVE_TIMEOUT_SECONDS = originalLiveTimeout;
    if (originalStallTimeout === undefined)
      delete process.env.ARTIFACT_STREAM_STALL_TIMEOUT_SECONDS;
    else process.env.ARTIFACT_STREAM_STALL_TIMEOUT_SECONDS = originalStallTimeout;
  });

  it("aborts one attempt, rejects an overlapping GET, then regenerates a complete ZIP", async () => {
    const port = await reservePort();
    process.env.ARTIFACT_LIVE_PORT = String(port);
    process.env.ARTIFACT_LIVE_TIMEOUT_SECONDS = "5";
    process.env.ARTIFACT_STREAM_STALL_TIMEOUT_SECONDS = "5";
    const callbacks: ProgressPayload[] = [];
    let generations = 0;

    const serving = serveArtifactLiveStream(
      "artifact.zip",
      (async (payload: ProgressPayload) => {
        callbacks.push(payload);
      }) as never,
      () => async (writer, signal) => {
        generations += 1;
        await writer.appendText("attempt.txt", `attempt-${generations}`);
        if (generations === 1) {
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
      },
    );
    await waitFor(() => callbacks.some((callback) => callback.phase === "artifact_delivery.ready"));

    const firstResponse = await new Promise<import("node:http").IncomingMessage>(
      (resolve, reject) => {
        const req = get(`http://127.0.0.1:${port}/artifact`);
        req.once("error", reject);
        req.once("response", (res) => {
          res.once("error", () => undefined);
          res.once("data", () => resolve(res));
        });
      },
    );

    const overlapping = await fetch(`http://127.0.0.1:${port}/artifact`);
    expect(overlapping.status).toBe(409);
    firstResponse.destroy();
    await waitFor(
      () =>
        callbacks.filter((callback) => callback.phase === "artifact_delivery.stream_aborted")
          .length === 1,
    );

    const retry = await fetch(`http://127.0.0.1:${port}/artifact`);
    expect(retry.status).toBe(200);
    const retryBody = new Uint8Array(await retry.arrayBuffer());
    expect(retryBody.subarray(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]));
    expect(hasCompleteZipTrailer(retryBody)).toBe(true);
    await serving;

    expect(generations).toBe(2);
    expect(
      callbacks
        .filter((callback) => callback.phase === "artifact_delivery.request_accepted")
        .map((callback) => callback.data?.attempt),
    ).toEqual([1, 2]);
    expect(
      callbacks
        .filter((callback) => callback.phase === "artifact_delivery.first_byte")
        .map((callback) => callback.data?.attempt),
    ).toEqual([1, 2]);
    expect(
      callbacks.find((callback) => callback.phase === "artifact_delivery.stream_aborted"),
    ).toMatchObject({
      level: "warn",
      status: "running",
      data: {
        attempt: 1,
        bytes_written: expect.any(Number),
        last_observed_stage: "first_byte",
      },
    });
    expect(callbacks.at(-1)).toMatchObject({ phase: "download.succeeded", status: "succeeded" });
  });

  it("fails terminally after five aborted attempts", async () => {
    const port = await reservePort();
    process.env.ARTIFACT_LIVE_PORT = String(port);
    process.env.ARTIFACT_LIVE_TIMEOUT_SECONDS = "5";
    process.env.ARTIFACT_STREAM_STALL_TIMEOUT_SECONDS = "5";
    const callbacks: ProgressPayload[] = [];
    const serving = serveArtifactLiveStream(
      "artifact.zip",
      (async (payload: ProgressPayload) => {
        callbacks.push(payload);
      }) as never,
      () => async (writer, signal) => {
        await writer.appendText("partial.txt", "partial");
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    );
    const servingResult = serving.then(
      () => null,
      (error: unknown) => error,
    );
    await waitFor(() => callbacks.some((callback) => callback.phase === "artifact_delivery.ready"));

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await abortAfterFirstChunk(port);
      await waitFor(
        () =>
          callbacks.filter((callback) => callback.phase === "artifact_delivery.stream_aborted")
            .length === attempt,
      );
    }

    expect(await servingResult).toMatchObject({
      failureClass: "artifact_delivery_stream_aborted",
      eventData: {
        attempts: 5,
        last_observed_stage: "first_byte",
      },
    } satisfies Partial<RunnerError>);
  });

  it("uses artifact_delivery_timeout when no retry arrives after an abort", async () => {
    const port = await reservePort();
    process.env.ARTIFACT_LIVE_PORT = String(port);
    process.env.ARTIFACT_LIVE_TIMEOUT_SECONDS = "1";
    process.env.ARTIFACT_STREAM_STALL_TIMEOUT_SECONDS = "5";
    const callbacks: ProgressPayload[] = [];
    const serving = serveArtifactLiveStream(
      "artifact.zip",
      (async (payload: ProgressPayload) => {
        callbacks.push(payload);
      }) as never,
      () => async (writer, signal) => {
        await writer.appendText("partial.txt", "partial");
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    );
    await waitFor(() => callbacks.some((callback) => callback.phase === "artifact_delivery.ready"));
    await abortAfterFirstChunk(port);

    await expect(serving).rejects.toMatchObject({
      failureClass: "artifact_delivery_timeout",
      eventData: { last_observed_stage: "first_byte" },
    } satisfies Partial<RunnerError>);
  });

  it("ignores Range and returns a full 200 ZIP", async () => {
    const port = await reservePort();
    process.env.ARTIFACT_LIVE_PORT = String(port);
    process.env.ARTIFACT_LIVE_TIMEOUT_SECONDS = "5";
    process.env.ARTIFACT_STREAM_STALL_TIMEOUT_SECONDS = "5";
    const callbacks: ProgressPayload[] = [];
    const serving = serveArtifactLiveStream(
      "artifact.zip",
      (async (payload: ProgressPayload) => {
        callbacks.push(payload);
      }) as never,
      () => async (writer) => {
        await writer.appendText("complete.txt", "complete artifact");
      },
    );
    await waitFor(() => callbacks.some((callback) => callback.phase === "artifact_delivery.ready"));

    const response = await fetch(`http://127.0.0.1:${port}/artifact`, {
      headers: { Range: "bytes=100-" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Range")).toBeNull();
    expect(hasCompleteZipTrailer(new Uint8Array(await response.arrayBuffer()))).toBe(true);
    await serving;
  });
});
