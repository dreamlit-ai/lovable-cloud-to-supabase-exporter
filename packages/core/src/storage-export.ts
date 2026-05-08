import path from "node:path";
import type {
  SourceStorageDiscoveredObject as StorageExportDiscoveredObject,
  SourceStorageObjectEnumerator as StorageExportSourceObjectEnumerator,
} from "./source-storage-discovery.js";
import {
  buildStorageMissingObjectsCsv,
  sortStorageMissingObjects,
  type StorageMissingObject,
} from "./storage-missing.js";

export type StorageExportProgress = {
  bucketId: string;
  prefix: string;
  bucketsProcessed: number;
  bucketsTotal: number;
  prefixesScanned: number;
  scanComplete: boolean;
  objectsTotal: number;
  objectsCopied: number;
  objectsSkippedMissing: number;
};

export type StorageExportSummary = {
  bucketIds: string[];
  bucketsTotal: number;
  objectsTotal: number;
  objectsCopied: number;
  objectsSkippedMissing: number;
  missingObjects: StorageMissingObject[];
};

export type StorageExportStage = {
  stage: "list_source_buckets" | "scan_source_bucket";
  message: string;
  data?: Record<string, unknown>;
};

export type { StorageExportDiscoveredObject, StorageExportSourceObjectEnumerator };

export type StorageExportFileEntry = {
  relativePath: string;
  body: string | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>;
  sizeBytes: number | null;
  contentType: string | null;
  cacheControl: string | null;
};

export type StorageExportEngineInput = {
  sourceProjectUrl: string;
  sourceAdminKey: string;
  concurrency: number;
  maxInflightBytes?: number;
  unknownObjectSizeBytes?: number;
  sourceObjectEnumerator: StorageExportSourceObjectEnumerator;
  /**
   * Must fully materialize the entry before resolving. Throw StorageExportEntrySkippedError
   * only when a source object can be safely skipped before mutating the final artifact.
   */
  writeFile: (entry: StorageExportFileEntry) => Promise<void> | void;
  onProgress?: (progress: StorageExportProgress) => Promise<void> | void;
  onStage?: (stage: StorageExportStage) => Promise<void> | void;
};

type StorageBucket = {
  id?: string;
  name?: string;
  public?: boolean;
  file_size_limit?: number | null;
  allowed_mime_types?: string[] | null;
  avif_autodetection?: boolean;
};

type StorageExportResult =
  | { status: "copied" }
  | { status: "skipped_missing"; missingObject: StorageMissingObject };

type StorageObjectExport = {
  status: "ready";
  body: Uint8Array | ReadableStream<Uint8Array>;
  sizeBytes: number | null;
  contentType: string;
  cacheControl: string | null;
};

type StorageObjectReadResult =
  | StorageObjectExport
  | { status: "skipped_missing"; response: Response };

const MAX_STORAGE_REQUEST_ATTEMPTS = 5;
const STORAGE_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_MAX_INFLIGHT_STORAGE_EXPORT_BYTES = 64 * 1024 * 1024;
const storageHeaders = (adminKey: string) => ({
  Authorization: `Bearer ${adminKey}`,
  apikey: adminKey,
});

export class StorageExportEntrySkippedError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { cause?: unknown; retryable?: boolean } = {}) {
    super(message);
    this.name = "StorageExportEntrySkippedError";
    this.retryable = options.retryable ?? true;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

const projectHost = (projectUrl: string): string => {
  try {
    return new URL(projectUrl).host;
  } catch {
    return projectUrl;
  }
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const describeError = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message && cause.message !== error.message) {
    return `${error.message}: ${cause.message}`;
  }
  if (typeof cause === "string" && cause && cause !== error.message) {
    return `${error.message}: ${cause}`;
  }
  return error.message;
};

const isRetryableStorageStatus = (status: number): boolean =>
  status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);

const formatAttemptSuffix = (attempts: number): string =>
  attempts > 1 ? ` after ${attempts} attempts` : "";

const consumeResponse = async (response: Response): Promise<void> => {
  await response.arrayBuffer().catch(() => undefined);
};

const fetchWithRetry = async (
  url: string,
  init: RequestInit,
  context: string,
): Promise<{ response: Response; attempts: number }> => {
  for (let attempt = 1; attempt <= MAX_STORAGE_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (
        response.ok ||
        !isRetryableStorageStatus(response.status) ||
        attempt === MAX_STORAGE_REQUEST_ATTEMPTS
      ) {
        return { response, attempts: attempt };
      }

      await consumeResponse(response);
    } catch (error) {
      if (attempt === MAX_STORAGE_REQUEST_ATTEMPTS) {
        throw new Error(`${context}: ${describeError(error)}${formatAttemptSuffix(attempt)}.`);
      }
    }

    await sleep(attempt * STORAGE_RETRY_BASE_DELAY_MS);
  }

  throw new Error(`${context}${formatAttemptSuffix(MAX_STORAGE_REQUEST_ATTEMPTS)}.`);
};

const encodeObjectPath = (name: string): string =>
  name
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

const isMissingStorageObjectResponse = (status: number, responseBody: string): boolean => {
  if (status === 404) return true;
  const lowered = responseBody.toLowerCase();
  if (lowered.includes('"error":"not_found"')) return true;
  if (lowered.includes("object not found")) return true;
  if (lowered.includes('"statuscode":"404"')) return true;
  return false;
};

const toSkippedExportFailure = (input: {
  bucketId: string;
  objectName: string;
  projectHost: string;
  error: unknown;
}): StorageMissingObject => ({
  bucketId: input.bucketId,
  objectPath: input.objectName,
  projectHost: input.projectHost,
  projectRole: "source",
  statusCode: 0,
  reason: "source_object_export_failed",
  error: describeError(input.error),
});

const withAttemptContext = (error: unknown, attempts: number): Error => {
  const message = describeError(error).replace(/\.+$/, "");
  return new Error(`${message}${formatAttemptSuffix(attempts)}.`);
};

const fetchObjectOnce = async (input: {
  url: string;
  init: RequestInit;
  context: string;
  metadata: Record<string, unknown> | null;
}): Promise<StorageObjectReadResult> => {
  let response: Response;
  try {
    response = await fetch(input.url, input.init);
  } catch (error) {
    throw new StorageExportEntrySkippedError(`${input.context}: ${describeError(error)}.`, {
      cause: error,
      retryable: true,
    });
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    if (isMissingStorageObjectResponse(response.status, errorBody)) {
      return { status: "skipped_missing", response };
    }

    throw new StorageExportEntrySkippedError(`${input.context} (${response.status}).`, {
      retryable: isRetryableStorageStatus(response.status),
    });
  }

  const contentType =
    input.metadata && typeof input.metadata.mimetype === "string"
      ? input.metadata.mimetype
      : (response.headers.get("content-type") ?? "application/octet-stream");
  const cacheControl =
    input.metadata &&
    (typeof input.metadata.cacheControl === "string" ||
      typeof input.metadata.cacheControl === "number")
      ? String(input.metadata.cacheControl)
      : null;
  const sizeBytes = toSizeBytes(response, input.metadata);

  if (response.body) {
    return {
      status: "ready",
      body: response.body,
      sizeBytes,
      contentType,
      cacheControl,
    };
  }

  try {
    return {
      status: "ready",
      body: new Uint8Array(await response.arrayBuffer()),
      sizeBytes,
      contentType,
      cacheControl,
    };
  } catch (error) {
    throw new StorageExportEntrySkippedError(`${input.context}: ${describeError(error)}.`, {
      cause: error,
      retryable: true,
    });
  }
};

const toBoundedPositiveInteger = (value: unknown, fallback: number): number => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.trunc(parsed));
};

const metadataByteValue = (
  metadata: Record<string, unknown> | null,
  keys: string[],
): number | null => {
  if (!metadata) return null;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.trunc(value);
    }
    if (typeof value === "string") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return Math.trunc(parsed);
      }
    }
  }
  return null;
};

const estimateObjectBytes = (
  metadata: Record<string, unknown> | null,
  unknownObjectSizeBytes: number,
): number => metadataByteValue(metadata, ["contentLength", "size"]) ?? unknownObjectSizeBytes;

const createWeightedConcurrencyGate = (concurrency: number, maxInflightBytes: number) => {
  let active = 0;
  let activeBytes = 0;
  const waiters: Array<{
    weightBytes: number;
    resolve: () => void;
  }> = [];

  const accountedWeight = (weightBytes: number) =>
    Math.min(maxInflightBytes, Math.max(1, Math.trunc(weightBytes) || 1));

  const canAcquire = (weightBytes: number): boolean => {
    if (active >= concurrency) return false;
    const boundedWeight = accountedWeight(weightBytes);
    if (active === 0) return true;
    return activeBytes + boundedWeight <= maxInflightBytes;
  };

  const reserve = (weightBytes: number) => {
    active += 1;
    activeBytes += accountedWeight(weightBytes);
  };

  const drain = () => {
    while (waiters.length > 0 && canAcquire(waiters[0]!.weightBytes)) {
      const waiter = waiters.shift()!;
      reserve(waiter.weightBytes);
      waiter.resolve();
    }
  };

  const acquire = async (weightBytes: number) => {
    if (canAcquire(weightBytes)) {
      reserve(weightBytes);
      return;
    }

    await new Promise<void>((resolve) => {
      waiters.push({ weightBytes, resolve });
    });
  };

  const release = (weightBytes: number) => {
    active = Math.max(0, active - 1);
    activeBytes = Math.max(0, activeBytes - accountedWeight(weightBytes));
    drain();
  };

  return {
    run: async <T>(weightBytes: number, task: () => Promise<T>): Promise<T> => {
      await acquire(weightBytes);
      try {
        return await task();
      } finally {
        release(weightBytes);
      }
    },
  };
};

const listBuckets = async (projectUrl: string, adminKey: string): Promise<StorageBucket[]> => {
  const host = projectHost(projectUrl);
  const { response, attempts } = await fetchWithRetry(
    `${projectUrl}/storage/v1/bucket`,
    {
      method: "GET",
      headers: storageHeaders(adminKey),
    },
    `List source buckets request failed for ${host}`,
  );

  if (!response.ok) {
    throw new Error(
      `List source buckets failed for ${host} (${response.status})${formatAttemptSuffix(attempts)}.`,
    );
  }

  const data = await response.json().catch(() => []);
  return Array.isArray(data) ? (data as StorageBucket[]) : [];
};

const toSizeBytes = (
  response: Response,
  metadata: Record<string, unknown> | null,
): number | null => {
  const responseLength = response.headers.get("content-length");
  if (responseLength) {
    const parsed = Number.parseInt(responseLength, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  const metadataSize = metadata?.size;
  if (typeof metadataSize === "number" && Number.isFinite(metadataSize) && metadataSize >= 0) {
    return metadataSize;
  }

  if (typeof metadataSize === "string") {
    const parsed = Number.parseInt(metadataSize, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return null;
};

const downloadOneObject = async (
  sourceProjectUrl: string,
  sourceAdminKey: string,
  bucketId: string,
  objectName: string,
  metadata: Record<string, unknown> | null,
  writeFile: StorageExportEngineInput["writeFile"],
): Promise<StorageExportResult> => {
  const encodedPath = encodeObjectPath(objectName);
  const sourceHost = projectHost(sourceProjectUrl);

  for (let attempt = 1; attempt <= MAX_STORAGE_REQUEST_ATTEMPTS; attempt += 1) {
    let download: StorageObjectReadResult;
    try {
      download = await fetchObjectOnce({
        url: `${sourceProjectUrl}/storage/v1/object/${encodeURIComponent(bucketId)}/${encodedPath}`,
        init: {
          method: "GET",
          headers: storageHeaders(sourceAdminKey),
        },
        context: `Download failed for ${bucketId}/${objectName} from ${sourceHost}`,
        metadata,
      });
    } catch (error) {
      if (
        error instanceof StorageExportEntrySkippedError &&
        error.retryable &&
        attempt < MAX_STORAGE_REQUEST_ATTEMPTS
      ) {
        await sleep(attempt * STORAGE_RETRY_BASE_DELAY_MS);
        continue;
      }

      return {
        status: "skipped_missing",
        missingObject: toSkippedExportFailure({
          bucketId,
          objectName,
          projectHost: sourceHost,
          error: withAttemptContext(error, attempt),
        }),
      };
    }

    if (download.status === "skipped_missing") {
      return {
        status: "skipped_missing",
        missingObject: {
          bucketId,
          objectPath: objectName,
          projectHost: sourceHost,
          projectRole: "source",
          statusCode: download.response.status,
          reason: "source_object_not_found",
        },
      };
    }

    try {
      await Promise.resolve(
        writeFile({
          relativePath: path.posix.join("storage", bucketId, objectName),
          body: download.body,
          sizeBytes: download.sizeBytes,
          contentType: download.contentType,
          cacheControl: download.cacheControl,
        }),
      );
      return { status: "copied" };
    } catch (error) {
      if (!(error instanceof StorageExportEntrySkippedError)) {
        throw error;
      }

      if (error.retryable && attempt < MAX_STORAGE_REQUEST_ATTEMPTS) {
        await sleep(attempt * STORAGE_RETRY_BASE_DELAY_MS);
        continue;
      }

      return {
        status: "skipped_missing",
        missingObject: toSkippedExportFailure({
          bucketId,
          objectName,
          projectHost: sourceHost,
          error: withAttemptContext(error, attempt),
        }),
      };
    }
  }

  return {
    status: "skipped_missing",
    missingObject: toSkippedExportFailure({
      bucketId,
      objectName,
      projectHost: sourceHost,
      error: new Error(
        `Download failed for ${bucketId}/${objectName} from ${sourceHost}${formatAttemptSuffix(MAX_STORAGE_REQUEST_ATTEMPTS)}.`,
      ),
    }),
  };
};

export const runStorageExportEngine = async (
  input: StorageExportEngineInput,
): Promise<StorageExportSummary> => {
  const boundedConcurrency = Math.max(1, Math.trunc(input.concurrency) || 1);
  const maxInflightBytes = toBoundedPositiveInteger(
    input.maxInflightBytes,
    DEFAULT_MAX_INFLIGHT_STORAGE_EXPORT_BYTES,
  );
  const unknownObjectSizeBytes = toBoundedPositiveInteger(
    input.unknownObjectSizeBytes,
    maxInflightBytes,
  );
  const sourceHost = projectHost(input.sourceProjectUrl);
  const emitStage = async (stage: StorageExportStage) => {
    await input.onStage?.(stage);
  };

  await emitStage({
    stage: "list_source_buckets",
    message: `Listing source storage buckets from ${sourceHost}.`,
    data: {
      project_host: sourceHost,
      project_role: "source",
    },
  });
  const sourceBuckets = await listBuckets(input.sourceProjectUrl, input.sourceAdminKey);

  const bucketsManifest = `${JSON.stringify(sourceBuckets, null, 2)}\n`;
  await Promise.resolve(
    input.writeFile({
      relativePath: "storage/buckets.json",
      body: bucketsManifest,
      sizeBytes: Buffer.byteLength(bucketsManifest),
      contentType: "application/json; charset=utf-8",
      cacheControl: null,
    }),
  );

  let bucketsProcessed = 0;
  let prefixesScanned = 0;
  let scanComplete = false;
  let objectsTotal = input.sourceObjectEnumerator.exactTotalObjects;
  let objectsDiscovered = 0;
  let objectsCopied = 0;
  let objectsSkippedMissing = 0;
  const missingObjects: StorageMissingObject[] = [];
  let lastProgressEmitAt = 0;
  let lastProgressEmitPrefixesScanned = -1;
  let lastProgressEmitScanComplete = false;
  let lastProgressEmitObjectsTotal = -1;
  let lastProgressEmitCopied = -1;
  let lastProgressEmitSkipped = -1;
  let progressWrite = Promise.resolve();
  let progressWriteError: unknown = null;
  const objectDownloadGate = createWeightedConcurrencyGate(boundedConcurrency, maxInflightBytes);

  const flushProgress = async () => {
    await progressWrite;
    if (progressWriteError) {
      throw progressWriteError;
    }
  };

  const emitProgress = (bucketId: string, prefix: string, force = false) => {
    if (!input.onProgress) return;
    if (progressWriteError) {
      throw progressWriteError;
    }

    const now = Date.now();
    const hasCountChange =
      prefixesScanned !== lastProgressEmitPrefixesScanned ||
      scanComplete !== lastProgressEmitScanComplete ||
      objectsTotal !== lastProgressEmitObjectsTotal ||
      objectsCopied !== lastProgressEmitCopied ||
      objectsSkippedMissing !== lastProgressEmitSkipped;
    const shouldEmit =
      force ||
      lastProgressEmitAt === 0 ||
      (hasCountChange && now - lastProgressEmitAt >= 1000) ||
      (!hasCountChange && now - lastProgressEmitAt >= 5000);

    if (!shouldEmit) return;

    lastProgressEmitAt = now;
    lastProgressEmitPrefixesScanned = prefixesScanned;
    lastProgressEmitScanComplete = scanComplete;
    lastProgressEmitObjectsTotal = objectsTotal;
    lastProgressEmitCopied = objectsCopied;
    lastProgressEmitSkipped = objectsSkippedMissing;

    progressWrite = progressWrite
      .then(() =>
        Promise.resolve(
          input.onProgress?.({
            bucketId,
            prefix,
            bucketsProcessed,
            bucketsTotal: sourceBuckets.length,
            prefixesScanned,
            scanComplete,
            objectsTotal,
            objectsCopied,
            objectsSkippedMissing,
          }),
        ),
      )
      .catch((error) => {
        progressWriteError = error;
      });
  };

  const bucketIds: string[] = [];
  let lastProgressBucketId = "";
  let lastProgressPrefix = "";

  if (objectsTotal > 0) {
    emitProgress("", "", true);
  }

  for (const bucket of sourceBuckets) {
    const bucketId = typeof bucket.id === "string" ? bucket.id : null;
    if (!bucketId) continue;
    bucketIds.push(bucketId);
    lastProgressBucketId = bucketId;
    lastProgressPrefix = "";

    await emitStage({
      stage: "scan_source_bucket",
      message: `Scanning source storage bucket ${bucketId}.`,
      data: {
        bucket_id: bucketId,
        project_host: sourceHost,
        project_role: "source",
      },
    });
    await input.sourceObjectEnumerator.forEachBucketObjectBatch(
      bucketId,
      async ({ prefix, fileObjects }) => {
        prefixesScanned += 1;
        objectsDiscovered += fileObjects.length;
        objectsTotal = Math.max(objectsTotal, objectsDiscovered);
        lastProgressBucketId = bucketId;
        lastProgressPrefix = prefix;
        emitProgress(bucketId, prefix);

        await Promise.all(
          fileObjects.map(({ metadata, fullPath }) => {
            const estimatedBytes = estimateObjectBytes(metadata, unknownObjectSizeBytes);
            return objectDownloadGate.run(estimatedBytes, async () => {
              const result = await downloadOneObject(
                input.sourceProjectUrl,
                input.sourceAdminKey,
                bucketId,
                fullPath,
                metadata,
                input.writeFile,
              );

              if (result.status === "copied") {
                objectsCopied += 1;
              } else {
                objectsSkippedMissing += 1;
                missingObjects.push(result.missingObject);
              }

              emitProgress(bucketId, prefix);
              return result;
            });
          }),
        );

        emitProgress(bucketId, prefix, true);
      },
    );

    bucketsProcessed += 1;
    emitProgress(bucketId, lastProgressPrefix, true);
  }

  scanComplete = true;
  emitProgress(lastProgressBucketId, lastProgressPrefix, true);
  await flushProgress();

  const sortedMissingObjects = sortStorageMissingObjects(missingObjects);
  if (sortedMissingObjects.length > 0) {
    const csv = buildStorageMissingObjectsCsv(sortedMissingObjects);
    await Promise.resolve(
      input.writeFile({
        relativePath: "storage/missing-objects.csv",
        body: csv,
        sizeBytes: Buffer.byteLength(csv),
        contentType: "text/csv; charset=utf-8",
        cacheControl: null,
      }),
    );
  }

  return {
    bucketIds,
    bucketsTotal: sourceBuckets.length,
    objectsTotal,
    objectsCopied,
    objectsSkippedMissing,
    missingObjects: sortedMissingObjects,
  };
};
