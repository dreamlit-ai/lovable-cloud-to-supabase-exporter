import type {
  SourceStorageDiscoveredObject as StorageDiscoveredObject,
  SourceStorageObjectEnumerator as StorageSourceObjectEnumerator,
} from "./source-storage-discovery.js";
import type { StorageFailureAction, StorageFailureEventData } from "./types.js";

export type StorageCopyProgress = {
  bucketId: string;
  prefix: string;
  bucketsProcessed: number;
  bucketsTotal: number;
  prefixesScanned: number;
  scanComplete: boolean;
  objectsTotal: number;
  objectsCopied: number;
  objectsFailed: number;
  objectsSkippedExisting: number;
  objectsSkippedMissing: number;
};

export type StorageCopyObjectFailure = StorageCopyFailureDetails & {
  message: string;
};

export type StorageCopySummary = {
  bucketIds: string[];
  bucketsTotal: number;
  bucketsCreated: number;
  objectsTotal: number;
  objectsCopied: number;
  objectsFailed: number;
  objectsSkippedExisting: number;
  objectsSkippedMissing: number;
  failedObjectSamples: StorageCopyObjectFailure[];
};

export type StorageCopyStage = {
  stage:
    | "list_source_buckets"
    | "list_target_buckets"
    | "scan_source_bucket"
    | "prepare_target_bucket"
    | "copy_source_bucket";
  message: string;
  data?: Record<string, unknown>;
};

export type { StorageDiscoveredObject, StorageSourceObjectEnumerator };

export type StorageCopyEngineInput = {
  sourceProjectUrl: string;
  targetProjectUrl: string;
  sourceAdminKey: string;
  targetAdminKey: string;
  concurrency: number;
  skipExistingTargetObjects?: boolean;
  sourceObjectEnumerator: StorageSourceObjectEnumerator;
  onProgress?: (progress: StorageCopyProgress) => Promise<void> | void;
  onStage?: (stage: StorageCopyStage) => Promise<void> | void;
};

export type StorageCopyFailureAction = StorageFailureAction;

export type StorageCopyFailureDetails = {
  action: StorageCopyFailureAction;
  bucketId: string | null;
  objectPath: string | null;
  prefix: string | null;
  projectHost: string;
  projectRole: "source" | "target";
  statusCode: number | null;
  attempts: number;
  retryable: boolean;
};

type StorageBucket = {
  id?: string;
  name?: string;
  public?: boolean;
  file_size_limit?: number | null;
  allowed_mime_types?: string[] | null;
  avif_autodetection?: boolean;
};

type StorageCopyResult = "copied" | "failed" | "skipped_existing" | "skipped_missing";

const MAX_STORAGE_REQUEST_ATTEMPTS = 3;
const STORAGE_RETRY_BASE_DELAY_MS = 250;
const MAX_STORAGE_OBJECT_FAILURE_SAMPLES = 10;
const MAX_SYSTEMIC_OBJECT_FAILURES = 20;
export class StorageCopyFailure extends Error {
  details: StorageCopyFailureDetails;

  constructor(message: string, details: StorageCopyFailureDetails) {
    super(message);
    this.name = "StorageCopyFailure";
    this.details = details;
  }
}

export const getStorageCopyFailureDetails = (error: unknown): StorageCopyFailureDetails | null => {
  if (error instanceof StorageCopyFailure) {
    return error.details;
  }

  if (typeof error !== "object" || error === null) return null;
  const candidate = (error as { details?: unknown }).details;
  if (typeof candidate !== "object" || candidate === null) return null;

  const details = candidate as Partial<StorageCopyFailureDetails>;
  return {
    action:
      typeof details.action === "string"
        ? (details.action as StorageCopyFailureAction)
        : "list_source_buckets",
    bucketId: typeof details.bucketId === "string" ? details.bucketId : null,
    objectPath: typeof details.objectPath === "string" ? details.objectPath : null,
    prefix: typeof details.prefix === "string" ? details.prefix : null,
    projectHost: typeof details.projectHost === "string" ? details.projectHost : "unknown",
    projectRole: details.projectRole === "target" ? "target" : "source",
    statusCode:
      typeof details.statusCode === "number" && Number.isFinite(details.statusCode)
        ? details.statusCode
        : null,
    attempts:
      typeof details.attempts === "number" && Number.isFinite(details.attempts)
        ? Math.max(1, Math.trunc(details.attempts))
        : 1,
    retryable: details.retryable === true,
  };
};

export const getStorageCopyFailureHint = (details: StorageCopyFailureDetails | null): string => {
  if (!details) {
    return "Retry the storage copy. Inspect the failing bucket/object in the status fields.";
  }

  if (details.statusCode === 401 || details.statusCode === 403) {
    return details.projectRole === "source"
      ? "Check the source admin key and source bucket/object permissions."
      : "Check the target admin key and target bucket/object permissions.";
  }

  if (details.action === "create_target_bucket") {
    return "Check the target admin key and target storage bucket permissions.";
  }

  if (details.retryable) {
    return "Transient storage API failure. Retry the storage copy; the failing bucket/object is in the status fields.";
  }

  return "Check source/target admin keys and bucket/object permissions.";
};

export const toStorageFailureEventData = (
  details: StorageCopyFailureDetails,
): StorageFailureEventData => ({
  storage_action: details.action,
  bucket_id: details.bucketId,
  object_path: details.objectPath,
  prefix: details.prefix,
  project_host: details.projectHost,
  project_role: details.projectRole,
  status_code: details.statusCode,
  attempts: details.attempts,
  retryable: details.retryable,
});

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

const buildStorageFailureMessage = (
  context: string,
  attempts: number,
  cause?: string | null,
): string => `${context}${cause ? `: ${cause}` : ""}${formatAttemptSuffix(attempts)}.`;

const consumeResponse = async (response: Response): Promise<void> => {
  await response.arrayBuffer().catch(() => undefined);
};

const createStorageCopyFailure = (
  context: string,
  details: StorageCopyFailureDetails,
  cause?: string | null,
): StorageCopyFailure =>
  new StorageCopyFailure(buildStorageFailureMessage(context, details.attempts, cause), details);

const toStorageCopyObjectFailure = (error: unknown): StorageCopyObjectFailure | null => {
  const details = getStorageCopyFailureDetails(error);
  if (!details) return null;

  return {
    ...details,
    message: error instanceof Error ? error.message : String(error),
  };
};

const isObjectTransferFailure = (details: StorageCopyFailureDetails): boolean =>
  details.action === "download_object" || details.action === "upload_object";

const isSystemicObjectFailure = (details: StorageCopyFailureDetails): boolean =>
  isObjectTransferFailure(details) && (details.statusCode === 401 || details.statusCode === 403);

const getSystemicObjectFailureSignature = (details: StorageCopyFailureDetails): string =>
  `${details.action}:${details.projectRole}:${details.statusCode ?? "unknown"}`;

const fetchWithRetry = async (input: {
  url: string;
  init: RequestInit & { duplex?: "half" };
  action: StorageCopyFailureAction;
  context: string;
  bucketId?: string | null;
  objectPath?: string | null;
  prefix?: string | null;
  projectHost: string;
  projectRole: "source" | "target";
}): Promise<{ response: Response; attempts: number }> => {
  for (let attempt = 1; attempt <= MAX_STORAGE_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(input.url, input.init);
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
        throw createStorageCopyFailure(
          input.context,
          {
            action: input.action,
            bucketId: input.bucketId ?? null,
            objectPath: input.objectPath ?? null,
            prefix: input.prefix ?? null,
            projectHost: input.projectHost,
            projectRole: input.projectRole,
            statusCode: null,
            attempts: attempt,
            retryable: true,
          },
          describeError(error),
        );
      }
    }

    await sleep(attempt * STORAGE_RETRY_BASE_DELAY_MS);
  }

  throw createStorageCopyFailure(input.context, {
    action: input.action,
    bucketId: input.bucketId ?? null,
    objectPath: input.objectPath ?? null,
    prefix: input.prefix ?? null,
    projectHost: input.projectHost,
    projectRole: input.projectRole,
    statusCode: null,
    attempts: MAX_STORAGE_REQUEST_ATTEMPTS,
    retryable: true,
  });
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

const isExistingStorageObjectResponse = (status: number, responseBody: string): boolean => {
  if (status === 409) return true;
  const lowered = responseBody.toLowerCase();
  if (lowered.includes("already exists")) return true;
  if (lowered.includes("already been taken")) return true;
  if (lowered.includes('"error":"duplicate"')) return true;
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

const listBuckets = async (
  projectUrl: string,
  adminKey: string,
  role: "source" | "target",
): Promise<StorageBucket[]> => {
  const host = projectHost(projectUrl);
  const { response, attempts } = await fetchWithRetry({
    url: `${projectUrl}/storage/v1/bucket`,
    init: {
      method: "GET",
      headers: storageHeaders(adminKey),
    },
    action: role === "source" ? "list_source_buckets" : "list_target_buckets",
    context: `List ${role} buckets request failed for ${host}`,
    projectHost: host,
    projectRole: role,
  });

  if (!response.ok) {
    throw createStorageCopyFailure(`List ${role} buckets failed for ${host} (${response.status})`, {
      action: role === "source" ? "list_source_buckets" : "list_target_buckets",
      bucketId: null,
      objectPath: null,
      prefix: null,
      projectHost: host,
      projectRole: role,
      statusCode: response.status,
      attempts,
      retryable: isRetryableStorageStatus(response.status),
    });
  }

  const data = await response.json().catch(() => []);
  return Array.isArray(data) ? (data as StorageBucket[]) : [];
};

const createBucketIfMissing = async (
  projectUrl: string,
  adminKey: string,
  sourceBucket: StorageBucket,
): Promise<void> => {
  const bucketId = typeof sourceBucket.id === "string" ? sourceBucket.id : null;
  if (!bucketId) return;

  const body: Record<string, unknown> = {
    id: bucketId,
    name: typeof sourceBucket.name === "string" ? sourceBucket.name : bucketId,
    public: sourceBucket.public === true,
  };

  if (typeof sourceBucket.file_size_limit === "number") {
    body.file_size_limit = sourceBucket.file_size_limit;
  }
  if (Array.isArray(sourceBucket.allowed_mime_types)) {
    body.allowed_mime_types = sourceBucket.allowed_mime_types;
  }
  if (typeof sourceBucket.avif_autodetection === "boolean") {
    body.avif_autodetection = sourceBucket.avif_autodetection;
  }

  const host = projectHost(projectUrl);
  const { response, attempts } = await fetchWithRetry({
    url: `${projectUrl}/storage/v1/bucket`,
    init: {
      method: "POST",
      headers: {
        ...storageHeaders(adminKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    action: "create_target_bucket",
    context: `Create bucket ${bucketId} request failed on ${host}`,
    bucketId,
    projectHost: host,
    projectRole: "target",
  });

  if (response.ok || response.status === 409) return;
  const text = await response.text();
  if (text.toLowerCase().includes("already exists")) return;
  throw createStorageCopyFailure(
    `Create bucket ${bucketId} failed on ${host} (${response.status})`,
    {
      action: "create_target_bucket",
      bucketId,
      objectPath: null,
      prefix: null,
      projectHost: host,
      projectRole: "target",
      statusCode: response.status,
      attempts,
      retryable: isRetryableStorageStatus(response.status),
    },
  );
};

const copyOneObject = async (
  sourceProjectUrl: string,
  targetProjectUrl: string,
  sourceAdminKey: string,
  targetAdminKey: string,
  bucketId: string,
  objectName: string,
  metadata: Record<string, unknown> | null,
  skipExistingTargetObjects: boolean,
): Promise<StorageCopyResult> => {
  const encodedPath = encodeObjectPath(objectName);
  const sourceHost = projectHost(sourceProjectUrl);
  const { response: downloadResponse, attempts: downloadAttempts } = await fetchWithRetry({
    url: `${sourceProjectUrl}/storage/v1/object/${encodeURIComponent(bucketId)}/${encodedPath}`,
    init: {
      method: "GET",
      headers: storageHeaders(sourceAdminKey),
    },
    action: "download_object",
    context: `Download request failed for ${bucketId}/${objectName} from ${sourceHost}`,
    bucketId,
    objectPath: objectName,
    projectHost: sourceHost,
    projectRole: "source",
  });

  if (!downloadResponse.ok) {
    const errorBody = await downloadResponse.text();
    if (isMissingStorageObjectResponse(downloadResponse.status, errorBody)) {
      return "skipped_missing";
    }
    throw createStorageCopyFailure(
      `Download failed for ${bucketId}/${objectName} from ${sourceHost} (${downloadResponse.status})`,
      {
        action: "download_object",
        bucketId,
        objectPath: objectName,
        prefix: null,
        projectHost: sourceHost,
        projectRole: "source",
        statusCode: downloadResponse.status,
        attempts: downloadAttempts,
        retryable: isRetryableStorageStatus(downloadResponse.status),
      },
    );
  }

  const mimetype =
    metadata && typeof metadata.mimetype === "string"
      ? metadata.mimetype
      : (downloadResponse.headers.get("content-type") ?? "application/octet-stream");

  const cacheControl =
    metadata &&
    (typeof metadata.cacheControl === "string" || typeof metadata.cacheControl === "number")
      ? String(metadata.cacheControl)
      : null;

  const uploadHeaders: Record<string, string> = {
    ...storageHeaders(targetAdminKey),
    "x-upsert": skipExistingTargetObjects ? "false" : "true",
    "Content-Type": mimetype,
  };
  if (cacheControl) uploadHeaders["cache-control"] = cacheControl;

  const uploadInit: RequestInit & { duplex?: "half" } = {
    method: "POST",
    headers: uploadHeaders,
  };

  if (downloadResponse.body) {
    uploadInit.body = downloadResponse.body;
    uploadInit.duplex = "half";
  } else {
    uploadInit.body = await downloadResponse.arrayBuffer();
  }

  const targetHost = projectHost(targetProjectUrl);
  const { response: uploadResponse, attempts: uploadAttempts } = await fetchWithRetry({
    url: `${targetProjectUrl}/storage/v1/object/${encodeURIComponent(bucketId)}/${encodedPath}`,
    init: uploadInit,
    action: "upload_object",
    context: `Upload request failed for ${bucketId}/${objectName} to ${targetHost}`,
    bucketId,
    objectPath: objectName,
    projectHost: targetHost,
    projectRole: "target",
  });

  if (!uploadResponse.ok) {
    const errorBody = await uploadResponse.text();
    if (
      skipExistingTargetObjects &&
      isExistingStorageObjectResponse(uploadResponse.status, errorBody)
    ) {
      return "skipped_existing";
    }
    throw createStorageCopyFailure(
      `Upload failed for ${bucketId}/${objectName} to ${targetHost} (${uploadResponse.status})`,
      {
        action: "upload_object",
        bucketId,
        objectPath: objectName,
        prefix: null,
        projectHost: targetHost,
        projectRole: "target",
        statusCode: uploadResponse.status,
        attempts: uploadAttempts,
        retryable: isRetryableStorageStatus(uploadResponse.status),
      },
    );
  }

  return "copied";
};

export const runStorageCopyEngine = async (
  input: StorageCopyEngineInput,
): Promise<StorageCopySummary> => {
  const boundedConcurrency = Math.max(1, Math.trunc(input.concurrency) || 1);
  const skipExistingTargetObjects = input.skipExistingTargetObjects === true;
  const sourceHost = projectHost(input.sourceProjectUrl);
  const targetHost = projectHost(input.targetProjectUrl);
  const emitStage = async (stage: StorageCopyStage) => {
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
  const sourceBuckets = await listBuckets(input.sourceProjectUrl, input.sourceAdminKey, "source");

  await emitStage({
    stage: "list_target_buckets",
    message: `Listing target storage buckets from ${targetHost}.`,
    data: {
      project_host: targetHost,
      project_role: "target",
    },
  });
  const targetBuckets = await listBuckets(input.targetProjectUrl, input.targetAdminKey, "target");

  const targetBucketIds = new Set(
    targetBuckets
      .map((bucket) => (typeof bucket.id === "string" ? bucket.id : null))
      .filter((id): id is string => Boolean(id)),
  );

  let bucketsCreated = 0;
  let bucketsProcessed = 0;
  let prefixesScanned = 0;
  let scanComplete = false;
  let objectsTotal = input.sourceObjectEnumerator.exactTotalObjects;
  let objectsDiscovered = 0;
  let objectsCopied = 0;
  let objectsFailed = 0;
  let objectsSkippedExisting = 0;
  let objectsSkippedMissing = 0;
  const failedObjectSamples: StorageCopyObjectFailure[] = [];
  let lastProgressEmitAt = 0;
  let lastProgressEmitPrefixesScanned = -1;
  let lastProgressEmitScanComplete = false;
  let lastProgressEmitObjectsTotal = -1;
  let lastProgressEmitCopied = -1;
  let lastProgressEmitFailed = -1;
  let lastProgressEmitSkippedExisting = -1;
  let lastProgressEmitSkipped = -1;
  let progressWrite = Promise.resolve();
  let progressWriteError: unknown = null;
  let systemicFailureWindowOpen = true;
  let systemicObjectFailureSignature: string | null = null;
  let systemicObjectFailureCount = 0;
  const objectTransferGate = createConcurrencyGate(boundedConcurrency);

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
    const hasProgressChange =
      prefixesScanned !== lastProgressEmitPrefixesScanned ||
      scanComplete !== lastProgressEmitScanComplete ||
      objectsTotal !== lastProgressEmitObjectsTotal ||
      objectsCopied !== lastProgressEmitCopied ||
      objectsFailed !== lastProgressEmitFailed ||
      objectsSkippedExisting !== lastProgressEmitSkippedExisting ||
      objectsSkippedMissing !== lastProgressEmitSkipped;
    const shouldEmit =
      force ||
      lastProgressEmitAt === 0 ||
      (hasProgressChange && now - lastProgressEmitAt >= 1000) ||
      (!hasProgressChange && now - lastProgressEmitAt >= 5000);

    if (!shouldEmit) return;

    lastProgressEmitAt = now;
    lastProgressEmitPrefixesScanned = prefixesScanned;
    lastProgressEmitScanComplete = scanComplete;
    lastProgressEmitObjectsTotal = objectsTotal;
    lastProgressEmitCopied = objectsCopied;
    lastProgressEmitFailed = objectsFailed;
    lastProgressEmitSkippedExisting = objectsSkippedExisting;
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
            objectsFailed,
            objectsSkippedExisting,
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

    const targetBucketAlreadyExists = targetBucketIds.has(bucketId);

    if (!targetBucketAlreadyExists) {
      await emitStage({
        stage: "prepare_target_bucket",
        message: `Creating missing target storage bucket ${bucketId}.`,
        data: {
          bucket_id: bucketId,
          project_host: targetHost,
          project_role: "target",
        },
      });
      await createBucketIfMissing(input.targetProjectUrl, input.targetAdminKey, bucket);
      targetBucketIds.add(bucketId);
      bucketsCreated += 1;
    }

    let copyStageStarted = false;
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
        lastProgressBucketId = bucketId;
        lastProgressPrefix = prefix;

        if (!copyStageStarted) {
          copyStageStarted = true;
          await emitStage({
            stage: "copy_source_bucket",
            message: `Copying source storage bucket ${bucketId} into ${targetHost}.`,
            data: {
              bucket_id: bucketId,
              source_project_host: sourceHost,
              target_project_host: targetHost,
            },
          });
        }

        objectsDiscovered += fileObjects.length;
        objectsTotal = Math.max(objectsTotal, objectsDiscovered);
        emitProgress(bucketId, prefix);

        await Promise.all(
          fileObjects.map(({ metadata, fullPath }) =>
            objectTransferGate.run(async () => {
              let result: StorageCopyResult;
              try {
                result = await copyOneObject(
                  input.sourceProjectUrl,
                  input.targetProjectUrl,
                  input.sourceAdminKey,
                  input.targetAdminKey,
                  bucketId,
                  fullPath,
                  metadata,
                  skipExistingTargetObjects,
                );
              } catch (error) {
                const failure = toStorageCopyObjectFailure(error);
                if (!failure || !isObjectTransferFailure(failure)) {
                  throw error;
                }

                objectsFailed += 1;
                if (failedObjectSamples.length < MAX_STORAGE_OBJECT_FAILURE_SAMPLES) {
                  failedObjectSamples.push(failure);
                }

                if (systemicFailureWindowOpen) {
                  if (isSystemicObjectFailure(failure)) {
                    const signature = getSystemicObjectFailureSignature(failure);
                    if (
                      systemicObjectFailureSignature === null ||
                      systemicObjectFailureSignature === signature
                    ) {
                      systemicObjectFailureSignature = signature;
                      systemicObjectFailureCount += 1;
                      if (systemicObjectFailureCount >= MAX_SYSTEMIC_OBJECT_FAILURES) {
                        throw createStorageCopyFailure(
                          `Storage copy aborted after ${MAX_SYSTEMIC_OBJECT_FAILURES} repeated object permission failures`,
                          {
                            action: failure.action,
                            bucketId: failure.bucketId,
                            objectPath: failure.objectPath,
                            prefix: failure.prefix,
                            projectHost: failure.projectHost,
                            projectRole: failure.projectRole,
                            statusCode: failure.statusCode,
                            attempts: failure.attempts,
                            retryable: false,
                          },
                        );
                      }
                    } else {
                      systemicFailureWindowOpen = false;
                    }
                  } else {
                    systemicFailureWindowOpen = false;
                  }
                }

                emitProgress(bucketId, prefix);
                return "failed";
              }

              if (result === "copied") {
                systemicFailureWindowOpen = false;
                objectsCopied += 1;
              } else if (result === "skipped_missing") {
                systemicFailureWindowOpen = false;
                objectsSkippedMissing += 1;
              } else if (result === "skipped_existing") {
                systemicFailureWindowOpen = false;
                objectsSkippedExisting += 1;
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
    bucketsCreated,
    objectsTotal,
    objectsCopied,
    objectsFailed,
    objectsSkippedExisting,
    objectsSkippedMissing,
    failedObjectSamples,
  };
};
