import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type StorageExportProgress = {
  bucketId: string;
  prefix: string;
  bucketsProcessed: number;
  bucketsTotal: number;
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

export type StorageExportEngineInput = {
  sourceProjectUrl: string;
  sourceAdminKey: string;
  exportDir: string;
  concurrency: number;
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

type StorageObject = {
  id?: string | null;
  name?: string;
  metadata?: Record<string, unknown> | null;
};

type StorageExportResult = "copied" | "skipped_missing";

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
  init: RequestInit,
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

const listBuckets = async (projectUrl: string, adminKey: string): Promise<StorageBucket[]> => {
  const host = projectHost(projectUrl);
  const response = await fetchWithContext(
    `${projectUrl}/storage/v1/bucket`,
    {
      method: "GET",
      headers: storageHeaders(adminKey),
    },
    `List source buckets request failed for ${host}`,
  );

  if (!response.ok) {
    throw new Error(`List source buckets failed for ${host} (${response.status}).`);
  }

  const data = await response.json().catch(() => []);
  return Array.isArray(data) ? (data as StorageBucket[]) : [];
};

const listObjects = async (
  projectUrl: string,
  adminKey: string,
  bucketId: string,
  prefix: string,
  limit: number,
  offset: number,
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
    `List source objects request failed for bucket ${bucketId} on ${host}`,
  );

  if (!response.ok) {
    throw new Error(
      `List source objects failed for bucket ${bucketId} on ${host} (${response.status}).`,
    );
  }

  const data = await response.json().catch(() => []);
  return Array.isArray(data) ? (data as StorageObject[]) : [];
};

const downloadOneObject = async (
  sourceProjectUrl: string,
  sourceAdminKey: string,
  exportDir: string,
  bucketId: string,
  objectName: string,
): Promise<StorageExportResult> => {
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

  const outputPath = path.join(exportDir, "storage", bucketId, objectName);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const arrayBuffer = await downloadResponse.arrayBuffer();
  await writeFile(outputPath, Buffer.from(arrayBuffer));
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
      const objects = await listObjects(projectUrl, adminKey, bucketId, prefix, limit, offset);

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

  await mkdir(path.join(input.exportDir, "storage"), { recursive: true });
  await writeFile(
    path.join(input.exportDir, "storage", "buckets.json"),
    `${JSON.stringify(sourceBuckets, null, 2)}\n`,
    "utf8",
  );

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

    await forEachBucketObjectBatch(
      input.sourceProjectUrl,
      input.sourceAdminKey,
      bucketId,
      async ({ prefix, fileObjects }) => {
        await emitProgress(bucketId, prefix, true);

        await mapWithConcurrency(fileObjects, boundedConcurrency, async ({ fullPath }) => {
          const result = await downloadOneObject(
            input.sourceProjectUrl,
            input.sourceAdminKey,
            input.exportDir,
            bucketId,
            fullPath,
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
    objectsTotal,
    objectsCopied,
    objectsSkippedMissing,
  };
};
