import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getStorageCopyFailureDetails,
  runStorageCopyEngine,
  toStorageFailureEventData,
  type StorageBucket,
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
  // Keep retry backoff from slowing the suite down.
  retryBaseDelayMs: 1,
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
  onListSourceBuckets?: () => Response;
  onListTargetBuckets?: () => Response;
  onCreateBucket?: (body: StorageBucket) => Response;
  onListTargetObjects?: (input: { prefix: string; limit: number; offset: number }) => Response;
  onDownload?: (input: {
    attempt: number;
    objectPath: string;
    signal?: AbortSignal | null;
  }) => Response | Promise<Response>;
  onUpload?: (input: { attempt: number; objectPath: string }) => Response | Promise<Response>;
}) => {
  let downloadCallCount = 0;
  let uploadCallCount = 0;

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url === "https://source.example/storage/v1/bucket" && method === "GET") {
      return (
        handlers.onListSourceBuckets?.() ??
        makeJsonResponse([{ id: "avatars", name: "avatars", public: false }])
      );
    }

    if (url === "https://target.example/storage/v1/bucket" && method === "GET") {
      return (
        handlers.onListTargetBuckets?.() ??
        makeJsonResponse([{ id: "avatars", name: "avatars", public: false }])
      );
    }

    if (url === "https://target.example/storage/v1/bucket" && method === "POST") {
      return handlers.onCreateBucket?.(JSON.parse(String(init?.body))) ?? makeJsonResponse({});
    }

    if (url === "https://target.example/storage/v1/object/list/avatars" && method === "POST") {
      return handlers.onListTargetObjects?.(JSON.parse(String(init?.body))) ?? makeJsonResponse([]);
    }

    if (url.startsWith("https://source.example/storage/v1/object/avatars/") && method === "GET") {
      downloadCallCount += 1;
      if (!handlers.onDownload) {
        throw new Error("Unexpected source download request");
      }
      return handlers.onDownload({
        attempt: downloadCallCount,
        objectPath: decodeObjectPath(url, "https://source.example/storage/v1/object/avatars/"),
        signal: init?.signal,
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

// A response whose body fails on the first read, like a connection that
// drops after the headers arrive.
const makeDroppedBodyResponse = () =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError("terminated"));
      },
    }),
    { status: 200, headers: { "Content-Type": "text/plain" } },
  );

// A response whose body never sends a byte.
const makeStalledBodyResponse = () =>
  new Response(
    new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
    }),
    { status: 200, headers: { "Content-Type": "text/plain" } },
  );

const smallFile = (fullPath: string): StorageDiscoveredObject => ({
  fullPath,
  metadata: { mimetype: "text/plain", size: 5 },
});

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
    // Three downloads: one transient failure, one success, and one
    // re-download that feeds the upload retry a fresh body stream.
    expect(mock.getCallCounts().downloadCallCount).toBe(3);
    expect(mock.getCallCounts().uploadCallCount).toBe(2);
  });

  it("captures network diagnostics when target uploads fail before an HTTP response", async () => {
    const cause = Object.assign(new Error("socket closed before response"), {
      code: "UND_ERR_SOCKET",
    });

    installFetchMock({
      onDownload: () => makeTextResponse("hello"),
      onUpload: () => {
        const error = Object.assign(new TypeError("fetch failed"), {
          cause,
          code: "ERR_FETCH_FAILED",
        });
        throw error;
      },
    });

    const summary = await runStorageCopyEngine({
      ...createStorageCopyInput(),
      sourceObjectEnumerator: createSourceObjectEnumerator([
        { fullPath: "logo.png", metadata: { mimetype: "text/plain", size: 1234 } },
      ]),
    });

    const failure = summary.failedObjectSamples[0];
    expect(summary.objectsFailed).toBe(1);
    expect(failure?.statusCode).toBeNull();
    // Small objects upload from a buffered body so retries can resend it.
    expect(failure?.requestBodyKind).toBe("array_buffer");
    expect(failure?.objectSizeBytes).toBe(1234);
    expect(failure?.errorName).toBe("TypeError");
    expect(failure?.errorMessage).toBe("fetch failed");
    expect(failure?.errorCode).toBe("ERR_FETCH_FAILED");
    expect(failure?.errorCauseName).toBe("Error");
    expect(failure?.errorCauseMessage).toBe("socket closed before response");
    expect(failure?.errorCauseCode).toBe("UND_ERR_SOCKET");
    expect(failure?.attemptErrorsSample).toHaveLength(5);

    const eventData = toStorageFailureEventData(failure!);
    expect(eventData.request_body_kind).toBe("array_buffer");
    expect(eventData.object_size_bytes).toBe(1234);
    expect(eventData.error_name).toBe("TypeError");
    expect(eventData.error_cause_code).toBe("UND_ERR_SOCKET");
    expect(eventData.attempt_errors_sample?.map((item) => item.attempt)).toEqual([1, 2, 3, 4, 5]);
  });

  it("skips files without resolving downloads and lists a prefix once across batches", async () => {
    const progressEvents: StorageCopyProgress[] = [];
    const onListTargetObjects = vi.fn(({ prefix, limit, offset }) => {
      expect(prefix).toBe("icons/");
      if (offset === 0) {
        return makeJsonResponse(
          Array.from({ length: limit }, (_, index) => ({
            id: `other-${index}`,
            name: `earlier-${index}`,
            metadata: null,
          })),
        );
      }
      expect(offset).toBe(limit);
      return makeJsonResponse([
        { id: "a", name: "logo.png", metadata: { size: 5 } },
        { id: "b", name: "other.png", metadata: null },
      ]);
    });
    const mock = installFetchMock({ onListTargetObjects });
    const resolveDownload = vi.fn();
    const summary = await runStorageCopyEngine({
      ...createStorageCopyInput(),
      skipExistingTargetObjects: true,
      source: {
        projectHost: "source.example",
        listBuckets: async () => [{ id: "avatars" }],
        objectEnumerator: {
          exactTotalObjects: 2,
          forEachBucketObjectBatch: async (_bucket, onBatch) => {
            for (const name of ["logo.png", "other.png"]) {
              await onBatch({ prefix: "icons/", fileObjects: [smallFile(`icons/${name}`)] });
            }
          },
        },
        resolveDownload,
      },
      onProgress: (progress) => {
        progressEvents.push(progress);
      },
    });

    expect(onListTargetObjects).toHaveBeenCalledTimes(2);
    expect(resolveDownload).not.toHaveBeenCalled();
    expect(mock.getCallCounts()).toEqual({ downloadCallCount: 0, uploadCallCount: 0 });
    expect(summary).toMatchObject({
      objectsSkippedExisting: 2,
      objectsCopied: 0,
      objectsFailed: 0,
    });
    expect(progressEvents.at(-1)?.objectsSkippedExisting).toBe(2);
  });

  it("reports a differently sized destination file and copies files missing from the listing", async () => {
    const mock = installFetchMock({
      onListTargetObjects: () =>
        makeJsonResponse([
          { id: "a", name: "different.png", metadata: { size: 10 } },
          { id: null, name: "folder", metadata: null },
        ]),
      onDownload: ({ objectPath }) => {
        expect(objectPath).toBe("folder");
        return makeTextResponse("hello");
      },
    });
    const summary = await runStorageCopyEngine({
      ...createStorageCopyInput(),
      skipExistingTargetObjects: true,
      sourceObjectEnumerator: createSourceObjectEnumerator([
        smallFile("different.png"),
        smallFile("folder"),
      ]),
    });

    expect(summary).toMatchObject({
      objectsCopied: 1,
      objectsSkippedExisting: 0,
      objectsFailed: 1,
    });
    expect(summary.failedObjectSamples[0]).toMatchObject({
      objectPath: "different.png",
      errorCauseCode: "TargetObjectSizeMismatch",
    });
    expect(mock.getCallCounts()).toEqual({ downloadCallCount: 1, uploadCallCount: 1 });
  });

  it("skips a duplicate created after the target listing", async () => {
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

  it.each(["classic", "backup"])(
    "creates every missing target bucket before scanning %s files",
    async (sourceKind) => {
      const sourceBuckets = [{ id: "avatars" }, { id: "late" }];
      const created: string[] = [];
      const enumerator = createSourceObjectEnumerator([]);
      const forEachBucketObjectBatch = vi.fn(async () => {
        expect(created).toEqual(["avatars", "late"]);
      });
      enumerator.forEachBucketObjectBatch = forEachBucketObjectBatch;
      installFetchMock({
        onListSourceBuckets: () => makeJsonResponse(sourceBuckets),
        onListTargetBuckets: () => makeJsonResponse([]),
        onCreateBucket: ({ id }) => {
          created.push(id!);
          return makeJsonResponse({});
        },
      });
      await runStorageCopyEngine({
        ...createStorageCopyInput(),
        ...(sourceKind === "backup"
          ? {
              source: {
                projectHost: "helper.example",
                listBuckets: async () => sourceBuckets,
                objectEnumerator: enumerator,
                resolveDownload: vi.fn(),
              },
            }
          : { sourceObjectEnumerator: enumerator }),
      });

      expect(forEachBucketObjectBatch).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    { error: "EntityTooLarge" },
    { message: "The object exceeded the maximum allowed size" },
  ])("retries bucket creation without the rejected limit for %j", async (reply) => {
    const sourceLimit = 125 * 1024 * 1024;
    const bucket = {
      id: "avatars",
      name: "avatars",
      public: true,
      allowed_mime_types: ["image/png"],
      avif_autodetection: true,
    };
    const onCreateBucket = vi.fn((body: StorageBucket) =>
      body.file_size_limit ? makeJsonResponse(reply, 400) : makeJsonResponse({}),
    );
    installFetchMock({
      onListSourceBuckets: () => makeJsonResponse([{ ...bucket, file_size_limit: sourceLimit }]),
      onListTargetBuckets: () => makeJsonResponse([]),
      onCreateBucket,
    });
    const summary = await runStorageCopyEngine({
      ...createStorageCopyInput(),
      sourceObjectEnumerator: createSourceObjectEnumerator([]),
    });

    expect(onCreateBucket.mock.calls).toEqual([
      [{ ...bucket, file_size_limit: sourceLimit }],
      [bucket],
    ]);
    expect(summary.bucketsCreated).toBe(1);
    expect(summary.bucketSizeLimitFallbacks).toEqual([
      { bucketId: "avatars", sourceLimitBytes: sourceLimit },
    ]);
  });

  it("fails before scanning when a later bucket rejects the fallback too", async () => {
    const onCreateBucket = vi.fn(({ id }: StorageBucket) =>
      id === "late" ? makeJsonResponse({ error: "EntityTooLarge" }, 400) : makeJsonResponse({}),
    );
    installFetchMock({
      onListSourceBuckets: () =>
        makeJsonResponse([{ id: "avatars" }, { id: "late", file_size_limit: 123 }]),
      onListTargetBuckets: () => makeJsonResponse([]),
      onCreateBucket,
    });
    const forEachBucketObjectBatch = vi.fn();
    await expect(
      runStorageCopyEngine({
        ...createStorageCopyInput(),
        sourceObjectEnumerator: { exactTotalObjects: 1, forEachBucketObjectBatch },
      }),
    ).rejects.toMatchObject({
      details: { bucketId: "late", attempts: 2, errorCauseCode: "EntityTooLarge" },
    });
    expect(onCreateBucket).toHaveBeenCalledTimes(3);
    expect(forEachBucketObjectBatch).not.toHaveBeenCalled();
  });

  it("skips objects the target rejects as too large and reports them", async () => {
    const progressEvents: StorageCopyProgress[] = [];
    const mock = installFetchMock({
      onDownload: () => makeTextResponse("hello"),
      onUpload: () =>
        makeTextResponse(
          '{"statusCode":"413","error":"Payload too large","message":"The object exceeded the maximum allowed size"}',
          400,
          "application/json",
        ),
    });

    const summary = await runStorageCopyEngine({
      ...createStorageCopyInput(),
      sourceObjectEnumerator: createSourceObjectEnumerator([
        { fullPath: "logo.png", metadata: { mimetype: "text/plain", size: 1234 } },
      ]),
      onProgress: (progress) => {
        progressEvents.push(progress);
      },
    });

    expect(summary.objectsCopied).toBe(0);
    expect(summary.objectsFailed).toBe(0);
    expect(summary.objectsSkippedOversized).toBe(1);
    expect(summary.oversizedObjects).toEqual([
      {
        bucketId: "avatars",
        objectPath: "logo.png",
        objectSizeBytes: 1234,
        statusCode: 400,
      },
    ]);
    expect(mock.getCallCounts().uploadCallCount).toBe(1);
    expect(progressEvents.at(-1)?.objectsSkippedOversized).toBe(1);
  });

  it("returns partial success when a source object disappears during copy", async () => {
    const mock = installFetchMock({
      onDownload: () => makeTextResponse('{"error":"not_found"}', 404, "application/json"),
    });

    const summary = await runStorageCopyEngine(createStorageCopyInput());

    expect(summary.objectsCopied).toBe(0);
    expect(summary.objectsFailed).toBe(0);
    expect(summary.objectsSkippedMissing).toBe(1);
    expect(summary.missingObjects).toEqual([
      {
        bucketId: "avatars",
        objectPath: "logo.png",
        projectHost: "source.example",
        projectRole: "source",
        statusCode: 404,
        reason: "source_object_not_found",
      },
    ]);
    expect(mock.getCallCounts().uploadCallCount).toBe(0);
  });

  it("captures a sanitized response body sample on bucket creation failures", async () => {
    const onCreateBucket = vi.fn(() =>
      makeJsonResponse(
        {
          message: "invalid bucket configuration",
          target_admin_key: "secret-value",
          error: "InvalidBucket",
        },
        400,
      ),
    );
    installFetchMock({
      onListSourceBuckets: () => makeJsonResponse([{ id: "avatars", file_size_limit: 123 }]),
      onListTargetBuckets: () => makeJsonResponse([]),
      onCreateBucket,
    });

    let capturedError: unknown = null;
    try {
      await runStorageCopyEngine(createStorageCopyInput());
    } catch (error) {
      capturedError = error;
    }

    const details = getStorageCopyFailureDetails(capturedError);
    expect(onCreateBucket).toHaveBeenCalledTimes(1);
    expect(details?.action).toBe("create_target_bucket");
    expect(details?.responseBodySample).toContain("invalid bucket configuration");
    expect(details?.responseBodySample).toContain('"target_admin_key":"<redacted>"');
    expect(details?.responseBodySample).not.toContain("secret-value");
    expect(toStorageFailureEventData(details!)).toMatchObject({
      response_body_sample: details?.responseBodySample,
      error_cause_message: "invalid bucket configuration",
      error_cause_code: "InvalidBucket",
    });
  });

  it("falls back to a sanitized body sample when the bucket list reply is plain text", async () => {
    installFetchMock({
      onListTargetBuckets: () =>
        makeTextResponse(
          "Permission denied for person@example.com at api.example.net (key target-key)",
          403,
        ),
    });
    await expect(runStorageCopyEngine(createStorageCopyInput())).rejects.toMatchObject({
      details: {
        action: "list_target_buckets",
        errorCauseMessage:
          "Permission denied for <redacted-email> at <redacted-host> (key <redacted>)",
        errorCauseCode: null,
      },
    });
  });

  it("caps and redacts the Supabase message and code on an upload failure", async () => {
    const reply = {
      message:
        "Upload rejected for person@example.com at db.example.net, key target-key, " +
        "https://target.example/file?signature=signed-token " +
        "sb_secret_not_a_real_key " +
        "long message ".repeat(200),
      code: "InvalidUpload",
      error: "The less specific error",
    };
    installFetchMock({
      onDownload: () => makeTextResponse("hello"),
      onUpload: () => makeJsonResponse(reply, 400),
    });
    const summary = await runStorageCopyEngine(createStorageCopyInput());
    expect(summary.objectsFailed).toBe(1);
    const eventData = toStorageFailureEventData(summary.failedObjectSamples[0]!);
    expect(eventData.error_cause_message).toContain("Upload rejected");
    expect(eventData.error_cause_code).toBe("InvalidUpload");
    expect(eventData.error_cause_message!.length).toBeLessThanOrEqual(1000);
    for (const secret of [
      "person",
      "example.net",
      "target.example",
      "target-key",
      "signed-token",
      "sb_secret_not_a_real_key",
    ]) {
      expect(eventData.error_cause_message).not.toContain(secret);
      expect(eventData.response_body_sample).not.toContain(secret);
    }
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
    expect(summary.failedObjectSamples[0]?.responseBodySample).toBe("permission denied");
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

  it("keeps every transfer slot busy when each listing batch holds one file", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    installFetchMock({
      onDownload: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
        inFlight -= 1;
        return makeTextResponse("hello");
      },
    });

    const summary = await runStorageCopyEngine({
      ...createStorageCopyInput(),
      concurrency: 4,
      sourceObjectEnumerator: {
        exactTotalObjects: 12,
        forEachBucketObjectBatch: async (_bucketId, onBatch) => {
          for (let index = 0; index < 12; index += 1) {
            await onBatch({
              prefix: `todo-${index}/`,
              fileObjects: [smallFile(`todo-${index}/photo.png`)],
            });
          }
        },
      },
    });

    expect(summary.objectsCopied).toBe(12);
    expect(maxInFlight).toBe(4);
  });

  it("rides out a short burst of source server errors", async () => {
    const mock = installFetchMock({
      onDownload: ({ attempt }) =>
        attempt <= 3 ? makeTextResponse("Internal Server Error", 500) : makeTextResponse("hello"),
    });

    const summary = await runStorageCopyEngine({
      ...createStorageCopyInput(),
      sourceObjectEnumerator: createSourceObjectEnumerator([smallFile("logo.png")]),
    });

    expect(summary.objectsCopied).toBe(1);
    expect(summary.objectsFailed).toBe(0);
    expect(mock.getCallCounts().downloadCallCount).toBe(4);
  });

  it("downloads a file again when its connection drops mid-read", async () => {
    const mock = installFetchMock({
      onDownload: ({ attempt }) =>
        attempt === 1 ? makeDroppedBodyResponse() : makeTextResponse("hello"),
    });

    const summary = await runStorageCopyEngine({
      ...createStorageCopyInput(),
      sourceObjectEnumerator: createSourceObjectEnumerator([smallFile("logo.png")]),
    });

    expect(summary.objectsCopied).toBe(1);
    expect(summary.objectsFailed).toBe(0);
    expect(mock.getCallCounts().downloadCallCount).toBe(2);
  });

  it("fails only the affected file when its connection keeps dropping", async () => {
    installFetchMock({
      onDownload: ({ objectPath }) =>
        objectPath === "broken.png" ? makeDroppedBodyResponse() : makeTextResponse("hello"),
    });

    const summary = await runStorageCopyEngine({
      ...createStorageCopyInput(),
      sourceObjectEnumerator: createSourceObjectEnumerator([
        smallFile("broken.png"),
        smallFile("logo.png"),
      ]),
    });

    expect(summary.objectsCopied).toBe(1);
    expect(summary.objectsFailed).toBe(1);
    expect(summary.failedObjectSamples[0]?.objectPath).toBe("broken.png");
    expect(summary.failedObjectSamples[0]?.attempts).toBe(5);
    expect(summary.failedObjectSamples[0]?.message).toContain("Download failed while reading");
  });

  it("retries a download whose body stalls", async () => {
    const mock = installFetchMock({
      onDownload: ({ attempt }) =>
        attempt === 1 ? makeStalledBodyResponse() : makeTextResponse("hello"),
    });

    const summary = await runStorageCopyEngine({
      ...createStorageCopyInput(),
      stallTimeoutMs: 50,
      sourceObjectEnumerator: createSourceObjectEnumerator([smallFile("logo.png")]),
    });

    expect(summary.objectsCopied).toBe(1);
    expect(mock.getCallCounts().downloadCallCount).toBe(2);
  });

  it("retries a request that gets no response", async () => {
    const mock = installFetchMock({
      onDownload: ({ attempt, signal }) =>
        attempt === 1
          ? new Promise<Response>((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            })
          : makeTextResponse("hello"),
    });

    const summary = await runStorageCopyEngine({
      ...createStorageCopyInput(),
      stallTimeoutMs: 50,
      sourceObjectEnumerator: createSourceObjectEnumerator([smallFile("logo.png")]),
    });

    expect(summary.objectsCopied).toBe(1);
    expect(mock.getCallCounts().downloadCallCount).toBe(2);
  });
});
