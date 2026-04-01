import path from "node:path";
import type {
  SourceStorageDiscoveredObject as StorageExportDiscoveredObject,
  SourceStorageObjectEnumerator as StorageExportSourceObjectEnumerator,
} from "./source-storage-discovery.js";

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
  sourceObjectEnumerator: StorageExportSourceObjectEnumerator;
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

type StorageExportResult = "copied" | "skipped_missing";

const MAX_STORAGE_REQUEST_ATTEMPTS = 5;
const STORAGE_RETRY_BASE_DELAY_MS = 250;
const storageHeaders = (adminKey: string) => ({
  Authorization: `Bearer ${adminKey}`,
  apikey: adminKey,
});

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

const createConcurrencyGate = (concurrency: number) => {
  let active = 0;
  const waiters: Array<() => void> = [];

  const acquire = async () => {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }
    active += 1;
  };

  const release = () => {
    active = Math.max(0, active - 1);
    waiters.shift()?.();
  };

  return {
    run: async <T>(task: () => Promise<T>): Promise<T> => {
      await acquire();
      try {
        return await task();
      } finally {
        release();
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
  const { response: downloadResponse, attempts } = await fetchWithRetry(
    `${sourceProjectUrl}/storage/v1/object/${encodeURIComponent(bucketId)}/${encodedPath}`,
    {
      method: "GET",
      headers: storageHeaders(sourceAdminKey),
    },
    `Download request failed for ${bucketId}/${objectName} from ${sourceHost}`,
  );

  if (!downloadResponse.ok) {
    const errorBody = await downloadResponse.text();
    if (isMissingStorageObjectResponse(downloadResponse.status, errorBody)) {
      return "skipped_missing";
    }
    throw new Error(
      `Download failed for ${bucketId}/${objectName} from ${sourceHost} (${downloadResponse.status})${formatAttemptSuffix(attempts)}.`,
    );
  }

  const contentType =
    metadata && typeof metadata.mimetype === "string"
      ? metadata.mimetype
      : (downloadResponse.headers.get("content-type") ?? "application/octet-stream");
  const cacheControl =
    metadata &&
    (typeof metadata.cacheControl === "string" || typeof metadata.cacheControl === "number")
      ? String(metadata.cacheControl)
      : null;

  await Promise.resolve(
    writeFile({
      relativePath: path.posix.join("storage", bucketId, objectName),
      body: downloadResponse.body ?? new Uint8Array(await downloadResponse.arrayBuffer()),
      sizeBytes: toSizeBytes(downloadResponse, metadata),
      contentType,
      cacheControl,
    }),
  );

  return "copied";
};

export const runStorageExportEngine = async (
  input: StorageExportEngineInput,
): Promise<StorageExportSummary> => {
  const boundedConcurrency = Math.max(1, Math.trunc(input.concurrency) || 1);
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
  let lastProgressEmitAt = 0;
  let lastProgressEmitPrefixesScanned = -1;
  let lastProgressEmitScanComplete = false;
  let lastProgressEmitObjectsTotal = -1;
  let lastProgressEmitCopied = -1;
  let lastProgressEmitSkipped = -1;
  let progressWrite = Promise.resolve();
  let progressWriteError: unknown = null;
  const objectDownloadGate = createConcurrencyGate(boundedConcurrency);

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
          fileObjects.map(({ metadata, fullPath }) =>
            objectDownloadGate.run(async () => {
              const result = await downloadOneObject(
                input.sourceProjectUrl,
                input.sourceAdminKey,
                bucketId,
                fullPath,
                metadata,
                input.writeFile,
              );

              if (result === "copied") {
                objectsCopied += 1;
              } else {
                objectsSkippedMissing += 1;
              }

              emitProgress(bucketId, prefix);
              return result;
            }),
          ),
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

  return {
    bucketIds,
    bucketsTotal: sourceBuckets.length,
    objectsTotal,
    objectsCopied,
    objectsSkippedMissing,
  };
};
