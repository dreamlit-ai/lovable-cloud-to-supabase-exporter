export type StorageCopyProgress = {
  bucketId: string;
  prefix: string;
  bucketsProcessed: number;
  bucketsTotal: number;
  objectsTotal: number;
  objectsCopied: number;
  objectsSkippedMissing: number;
};

export type StorageCopySummary = {
  bucketIds: string[];
  bucketsTotal: number;
  bucketsCreated: number;
  objectsTotal: number;
  objectsCopied: number;
  objectsSkippedMissing: number;
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

export type StorageCopyEngineInput = {
  sourceProjectUrl: string;
  targetProjectUrl: string;
  sourceAdminKey: string;
  targetAdminKey: string;
  concurrency: number;
  onProgress?: (progress: StorageCopyProgress) => Promise<void> | void;
  onStage?: (stage: StorageCopyStage) => Promise<void> | void;
};

type StorageBucket = {
  id?: string;
  name?: string;
  public?: boolean;
  file_size_limit?: number | null;
  allowed_mime_types?: string[] | null;
  avif_autodetection?: boolean;
};

type StorageObject = {
  id?: string | null;
  name?: string;
  metadata?: Record<string, unknown> | null;
};

type StorageCopyResult = "copied" | "skipped_missing";

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

const fetchWithContext = async (
  url: string,
  init: RequestInit & { duplex?: "half" },
  context: string,
): Promise<Response> => {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw new Error(`${context}: ${describeError(error)}`);
  }
};

const encodeObjectPath = (name: string): string =>
  name
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

const normalizeObjectSegment = (value: string): string =>
  value.replace(/^\/+/, "").replace(/\/+$/, "");

const isMissingStorageObjectResponse = (status: number, responseBody: string): boolean => {
  if (status === 404) return true;
  const lowered = responseBody.toLowerCase();
  if (lowered.includes('"error":"not_found"')) return true;
  if (lowered.includes("object not found")) return true;
  if (lowered.includes('"statuscode":"404"')) return true;
  return false;
};

const mapWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  if (items.length === 0) return [];

  const out: R[] = Array(items.length);
  let index = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });

  await Promise.all(runners);
  return out;
};

const listBuckets = async (
  projectUrl: string,
  adminKey: string,
  role: "source" | "target",
): Promise<StorageBucket[]> => {
  const host = projectHost(projectUrl);
  const response = await fetchWithContext(
    `${projectUrl}/storage/v1/bucket`,
    {
      method: "GET",
      headers: storageHeaders(adminKey),
    },
    `List ${role} buckets request failed for ${host}`,
  );

  if (!response.ok) {
    throw new Error(`List ${role} buckets failed for ${host} (${response.status}).`);
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
  const response = await fetchWithContext(
    `${projectUrl}/storage/v1/bucket`,
    {
      method: "POST",
      headers: {
        ...storageHeaders(adminKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    `Create bucket ${bucketId} request failed on ${host}`,
  );

  if (response.ok || response.status === 409) return;
  const text = await response.text();
  if (text.toLowerCase().includes("already exists")) return;
  throw new Error(`Create bucket ${bucketId} failed on ${host} (${response.status}).`);
};

const listObjects = async (
  projectUrl: string,
  adminKey: string,
  bucketId: string,
  prefix: string,
  limit: number,
  offset: number,
  role: "source" | "target",
): Promise<StorageObject[]> => {
  const host = projectHost(projectUrl);
  const response = await fetchWithContext(
    `${projectUrl}/storage/v1/object/list/${encodeURIComponent(bucketId)}`,
    {
      method: "POST",
      headers: {
        ...storageHeaders(adminKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prefix,
        limit,
        offset,
        sortBy: { column: "name", order: "asc" },
      }),
    },
    `List ${role} objects request failed for bucket ${bucketId} on ${host}`,
  );

  if (!response.ok) {
    throw new Error(
      `List ${role} objects failed for bucket ${bucketId} on ${host} (${response.status}).`,
    );
  }

  const data = await response.json().catch(() => []);
  return Array.isArray(data) ? (data as StorageObject[]) : [];
};

const copyOneObject = async (
  sourceProjectUrl: string,
  targetProjectUrl: string,
  sourceAdminKey: string,
  targetAdminKey: string,
  bucketId: string,
  objectName: string,
  object: StorageObject,
): Promise<StorageCopyResult> => {
  const encodedPath = encodeObjectPath(objectName);
  const sourceHost = projectHost(sourceProjectUrl);
  const downloadResponse = await fetchWithContext(
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
      `Download failed for ${bucketId}/${objectName} from ${sourceHost} (${downloadResponse.status}).`,
    );
  }

  const metadata = object.metadata && typeof object.metadata === "object" ? object.metadata : null;

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
    "x-upsert": "true",
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
  const uploadResponse = await fetchWithContext(
    `${targetProjectUrl}/storage/v1/object/${encodeURIComponent(bucketId)}/${encodedPath}`,
    uploadInit,
    `Upload request failed for ${bucketId}/${objectName} to ${targetHost}`,
  );

  if (!uploadResponse.ok) {
    throw new Error(
      `Upload failed for ${bucketId}/${objectName} to ${targetHost} (${uploadResponse.status}).`,
    );
  }

  return "copied";
};

const forEachBucketObjectBatch = async (
  projectUrl: string,
  adminKey: string,
  bucketId: string,
  onBatch: (input: {
    prefix: string;
    fileObjects: Array<{ object: StorageObject; fullPath: string }>;
  }) => Promise<void> | void,
): Promise<void> => {
  const prefixes = [""];
  const visitedPrefixes = new Set<string>([""]);

  while (prefixes.length > 0) {
    const prefix = prefixes.shift() ?? "";
    let offset = 0;
    const limit = 1000;

    while (true) {
      const objects = await listObjects(
        projectUrl,
        adminKey,
        bucketId,
        prefix,
        limit,
        offset,
        "source",
      );

      if (objects.length === 0) break;

      const fileObjects: Array<{ object: StorageObject; fullPath: string }> = [];
      for (const object of objects) {
        const objectName =
          typeof object.name === "string" ? normalizeObjectSegment(object.name) : "";
        if (!objectName) continue;

        const fullPath = prefix ? `${prefix}${objectName}` : objectName;
        const isFileObject = typeof object.id === "string" && object.id.trim().length > 0;

        if (!isFileObject) {
          const childPrefix = `${fullPath}/`;
          if (!visitedPrefixes.has(childPrefix)) {
            visitedPrefixes.add(childPrefix);
            prefixes.push(childPrefix);
          }
          continue;
        }

        fileObjects.push({ object, fullPath });
      }

      await onBatch({ prefix, fileObjects });
      offset += objects.length;
    }
  }
};

export const runStorageCopyEngine = async (
  input: StorageCopyEngineInput,
): Promise<StorageCopySummary> => {
  const boundedConcurrency = Math.max(1, Math.trunc(input.concurrency) || 1);
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
  let objectsTotal = 0;
  let objectsTotalIsFinal = false;
  let objectsCopied = 0;
  let objectsSkippedMissing = 0;
  let lastProgressEmitAt = 0;
  let lastProgressEmitCopied = -1;
  let lastProgressEmitSkipped = -1;
  let progressWrite = Promise.resolve();

  const emitProgress = async (bucketId: string, prefix: string, force = false) => {
    if (!input.onProgress) return;

    const now = Date.now();
    const hasCountChange =
      objectsCopied !== lastProgressEmitCopied || objectsSkippedMissing !== lastProgressEmitSkipped;
    const shouldEmit =
      force ||
      lastProgressEmitAt === 0 ||
      (hasCountChange && now - lastProgressEmitAt >= 1000) ||
      (!hasCountChange && objectsTotal > 0 && now - lastProgressEmitAt >= 5000);

    if (!shouldEmit) return;

    lastProgressEmitAt = now;
    lastProgressEmitCopied = objectsCopied;
    lastProgressEmitSkipped = objectsSkippedMissing;

    progressWrite = progressWrite.then(() =>
      Promise.resolve(
        input.onProgress?.({
          bucketId,
          prefix,
          bucketsProcessed,
          bucketsTotal: sourceBuckets.length,
          objectsTotal: objectsTotalIsFinal ? objectsTotal : 0,
          objectsCopied,
          objectsSkippedMissing,
        }),
      ),
    );

    await progressWrite;
  };

  const bucketIds: string[] = [];
  let lastScannedBucketId = "";
  let lastScannedPrefix = "";

  for (const bucket of sourceBuckets) {
    const bucketId = typeof bucket.id === "string" ? bucket.id : null;
    if (!bucketId) continue;
    bucketIds.push(bucketId);

    await emitStage({
      stage: "scan_source_bucket",
      message: `Scanning source storage bucket ${bucketId}.`,
      data: {
        bucket_id: bucketId,
        project_host: sourceHost,
        project_role: "source",
      },
    });
    await forEachBucketObjectBatch(
      input.sourceProjectUrl,
      input.sourceAdminKey,
      bucketId,
      async ({ prefix, fileObjects }) => {
        lastScannedBucketId = bucketId;
        lastScannedPrefix = prefix;
        await emitProgress(bucketId, prefix, true);
        objectsTotal += fileObjects.length;
      },
    );
  }

  objectsTotalIsFinal = true;
  await emitProgress(lastScannedBucketId, lastScannedPrefix, true);

  for (const bucket of sourceBuckets) {
    const bucketId = typeof bucket.id === "string" ? bucket.id : null;
    if (!bucketId) continue;

    if (!targetBucketIds.has(bucketId)) {
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

    await emitStage({
      stage: "copy_source_bucket",
      message: `Copying source storage bucket ${bucketId} into ${targetHost}.`,
      data: {
        bucket_id: bucketId,
        source_project_host: sourceHost,
        target_project_host: targetHost,
      },
    });
    await forEachBucketObjectBatch(
      input.sourceProjectUrl,
      input.sourceAdminKey,
      bucketId,
      async ({ prefix, fileObjects }) => {
        await emitProgress(bucketId, prefix, true);

        await mapWithConcurrency(fileObjects, boundedConcurrency, async ({ object, fullPath }) => {
          const result = await copyOneObject(
            input.sourceProjectUrl,
            input.targetProjectUrl,
            input.sourceAdminKey,
            input.targetAdminKey,
            bucketId,
            fullPath,
            object,
          );

          if (result === "copied") {
            objectsCopied += 1;
          } else {
            objectsSkippedMissing += 1;
          }

          await emitProgress(bucketId, prefix);
          return result;
        });

        if (fileObjects.length > 0) {
          await emitProgress(bucketId, prefix, true);
        }
      },
    );

    bucketsProcessed += 1;
  }

  return {
    bucketIds,
    bucketsTotal: sourceBuckets.length,
    bucketsCreated,
    objectsTotal,
    objectsCopied,
    objectsSkippedMissing,
  };
};
