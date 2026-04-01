import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getStorageCopyFailureDetails,
  runStorageCopyEngine,
  type StorageDiscoveredObject,
  type StorageCopyEngineInput,
  type StorageCopyProgress,
} from "../storage-copy";

const makeJsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });

const makeTextResponse = (body: string, status = 200, contentType = "text/plain") =>
  new Response(body, {
    status,
    headers: {
      "Content-Type": contentType,
    },
  });

const createSourceObjectEnumerator = (
  objects: StorageDiscoveredObject[] = [
    {
      fullPath: "logo.png",
      metadata: { mimetype: "text/plain" },
    },
  ],
): StorageCopyEngineInput["sourceObjectEnumerator"] => ({
  exactTotalObjects: objects.length,
  forEachBucketObjectBatch: async (_bucketId, onBatch) => {
    await onBatch({
      prefix: "",
      fileObjects: objects,
    });
  },
});

const createStorageCopyInput = (): StorageCopyEngineInput => ({
  sourceProjectUrl: "https://source.example",
  targetProjectUrl: "https://target.example",
  sourceAdminKey: "source-key",
  targetAdminKey: "target-key",
  concurrency: 1,
  sourceObjectEnumerator: createSourceObjectEnumerator(),
});

const decodeObjectPath = (url: string, prefix: string): string =>
  url
    .slice(prefix.length)
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join("/");

const waitFor = async (predicate: () => boolean, timeoutMs = 1000): Promise<void> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
};

const installFetchMock = (handlers: {
  onDownload?: (input: { attempt: number; objectPath: string }) => Response | Promise<Response>;
  onUpload?: (input: { attempt: number; objectPath: string }) => Response | Promise<Response>;
}) => {
  let downloadCallCount = 0;
  let uploadCallCount = 0;

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url === "https://source.example/storage/v1/bucket" && method === "GET") {
      return makeJsonResponse([{ id: "avatars", name: "avatars", public: false }]);
    }

    if (url === "https://target.example/storage/v1/bucket" && method === "GET") {
      return makeJsonResponse([{ id: "avatars", name: "avatars", public: false }]);
    }

    if (url.startsWith("https://source.example/storage/v1/object/avatars/") && method === "GET") {
      downloadCallCount += 1;
      if (!handlers.onDownload) {
        throw new Error("Unexpected source download request");
      }
      return handlers.onDownload({
        attempt: downloadCallCount,
        objectPath: decodeObjectPath(url, "https://source.example/storage/v1/object/avatars/"),
      });
    }

    if (url.startsWith("https://target.example/storage/v1/object/avatars/") && method === "POST") {
      uploadCallCount += 1;
      return (
        handlers.onUpload?.({
          attempt: uploadCallCount,
          objectPath: decodeObjectPath(url, "https://target.example/storage/v1/object/avatars/"),
        }) ?? makeTextResponse("", 200)
      );
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  return {
    fetchMock,
    getCallCounts: () => ({
      downloadCallCount,
      uploadCallCount,
    }),
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("runStorageCopyEngine", () => {
  it("retries transient download/upload failures and eventually succeeds", async () => {
    const mock = installFetchMock({
      onDownload: ({ attempt }) =>
        attempt === 1 ? makeTextResponse("temporary source error", 503) : makeTextResponse("hello"),
      onUpload: ({ attempt }) =>
        attempt === 1 ? makeTextResponse("temporary target error", 503) : makeTextResponse("", 200),
    });

    const summary = await runStorageCopyEngine(createStorageCopyInput());

    expect(summary.objectsCopied).toBe(1);
    expect(summary.objectsFailed).toBe(0);
    expect(summary.objectsSkippedMissing).toBe(0);
    expect(mock.getCallCounts().downloadCallCount).toBe(2);
    expect(mock.getCallCounts().uploadCallCount).toBe(2);
  });

  it("skips files that already exist on the target so reruns can resume", async () => {
    const progressEvents: StorageCopyProgress[] = [];
    const mock = installFetchMock({
      onDownload: () => makeTextResponse("hello"),
      onUpload: () => makeTextResponse("already exists", 409),
    });

    const summary = await runStorageCopyEngine({
      ...createStorageCopyInput(),
      skipExistingTargetObjects: true,
      onProgress: (progress) => {
        progressEvents.push(progress);
      },
    });

    expect(summary.objectsCopied).toBe(0);
    expect(summary.objectsSkippedExisting).toBe(1);
    expect(summary.objectsSkippedMissing).toBe(0);
    expect(mock.getCallCounts().downloadCallCount).toBe(1);
    expect(mock.getCallCounts().uploadCallCount).toBe(1);
    expect(progressEvents.at(-1)?.objectsSkippedExisting).toBe(1);
  });

  it("returns partial success when a source object disappears during copy", async () => {
    const mock = installFetchMock({
      onDownload: () => makeTextResponse('{"error":"not_found"}', 404, "application/json"),
    });

    const summary = await runStorageCopyEngine(createStorageCopyInput());

    expect(summary.objectsCopied).toBe(0);
    expect(summary.objectsFailed).toBe(0);
    expect(summary.objectsSkippedMissing).toBe(1);
    expect(mock.getCallCounts().uploadCallCount).toBe(0);
  });

  it("accepts an exact-count source object enumerator instead of listing storage prefixes", async () => {
    const progressEvents: StorageCopyProgress[] = [];
    const mock = installFetchMock({
      onDownload: () => makeTextResponse("hello"),
    });

    const summary = await runStorageCopyEngine({
      ...createStorageCopyInput(),
      sourceObjectEnumerator: {
        exactTotalObjects: 1,
        forEachBucketObjectBatch: async (bucketId, onBatch) => {
          expect(bucketId).toBe("avatars");
          await onBatch({
            prefix: "folder-a/group-1/",
            fileObjects: [
              {
                fullPath: "folder-a/group-1/logo.png",
                metadata: { mimetype: "text/plain" },
              },
            ],
          });
        },
      },
      onProgress: (progress) => {
        progressEvents.push(progress);
      },
    });

    expect(summary.objectsTotal).toBe(1);
    expect(summary.objectsCopied).toBe(1);
    expect(mock.getCallCounts().downloadCallCount).toBe(1);
    expect(progressEvents[0]?.objectsTotal).toBe(1);
    expect(progressEvents.some((progress) => progress.prefixesScanned > 0)).toBe(true);
    expect(progressEvents.at(-1)?.scanComplete).toBe(true);
  });

  it("continues after non-retryable object failures and reports them in the summary", async () => {
    installFetchMock({
      onDownload: ({ objectPath }) =>
        objectPath === "logo.png"
          ? makeTextResponse("permission denied", 403)
          : makeTextResponse("hello"),
    });

    const summary = await runStorageCopyEngine({
      ...createStorageCopyInput(),
      sourceObjectEnumerator: createSourceObjectEnumerator([
        { fullPath: "logo.png", metadata: { mimetype: "text/plain" } },
        { fullPath: "avatar.png", metadata: { mimetype: "text/plain" } },
      ]),
    });

    expect(summary.objectsCopied).toBe(1);
    expect(summary.objectsFailed).toBe(1);
    expect(summary.objectsSkippedMissing).toBe(0);
    expect(summary.failedObjectSamples).toHaveLength(1);
    expect(summary.failedObjectSamples[0]?.action).toBe("download_object");
    expect(summary.failedObjectSamples[0]?.bucketId).toBe("avatars");
    expect(summary.failedObjectSamples[0]?.objectPath).toBe("logo.png");
    expect(summary.failedObjectSamples[0]?.statusCode).toBe(403);
    expect(summary.failedObjectSamples[0]?.retryable).toBe(false);
    expect(summary.failedObjectSamples[0]?.message).toContain("Download failed");
  });

  it("does not block object transfers on a slow progress callback", async () => {
    const progressBarrier = Promise.withResolvers<void>();
    let firstProgressSeen = false;
    let downloadStarted = false;

    installFetchMock({
      onDownload: () => {
        downloadStarted = true;
        return makeTextResponse("hello");
      },
    });

    const runPromise = runStorageCopyEngine({
      ...createStorageCopyInput(),
      onProgress: () => {
        if (!firstProgressSeen) {
          firstProgressSeen = true;
          return progressBarrier.promise;
        }
      },
    });

    await waitFor(() => firstProgressSeen, 1000);
    await waitFor(() => downloadStarted, 1000);
    progressBarrier.resolve();

    const summary = await runPromise;
    expect(summary.objectsCopied).toBe(1);
  });

  it("aborts after repeated early permission failures that look systemic", async () => {
    installFetchMock({
      onDownload: () => makeTextResponse("permission denied", 403),
    });

    let capturedError: unknown = null;
    try {
      await runStorageCopyEngine({
        ...createStorageCopyInput(),
        sourceObjectEnumerator: createSourceObjectEnumerator(
          Array.from({ length: 20 }, (_, index) => ({
            fullPath: `file-${index + 1}.png`,
            metadata: { mimetype: "text/plain" },
          })),
        ),
      });
    } catch (error) {
      capturedError = error;
    }

    const details = getStorageCopyFailureDetails(capturedError);
    expect(details).not.toBeNull();
    expect(details?.action).toBe("download_object");
    expect(details?.statusCode).toBe(403);
    expect(details?.retryable).toBe(false);
    expect((capturedError as Error | null)?.message).toContain(
      "Storage copy aborted after 20 repeated object permission failures",
    );
  });
});
