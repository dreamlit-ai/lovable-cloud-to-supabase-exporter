// Storage source for newer Lovable projects. Those projects can't hand out
// their service key, so a temporary helper route inside the Lovable app
// lists buckets and files and signs short-lived download URLs. The protocol
// matches storage-helper/migration-helper.ts at the repo root.

import { createSourceStorageObjectEnumerator } from "./source-storage-discovery.js";
import type { StorageBucket, StorageCopySource, StorageObjectDownload } from "./storage-copy.js";

const HELPER_REQUEST_ATTEMPTS = 3;
const HELPER_RETRY_BASE_DELAY_MS = 500;
const HELPER_REQUEST_TIMEOUT_MS = 30_000;
const HELPER_LIST_PAGE_SIZE = 1000;
const HELPER_MAX_SIGN_PATHS = 100;
// Signed URLs are refreshed this long before they expire, so a URL handed to
// the copy engine still works when the download actually starts.
const SIGNED_URL_REFRESH_MARGIN_MS = 120_000;
const MISSING_OBJECT_STATUS = 404;

export type StorageHelperObject = {
  path: string;
  size: number | null;
  mimetype: string | null;
};

export type StorageHelperManifest = {
  buckets: StorageBucket[];
  objectsByBucket: Map<string, StorageHelperObject[]>;
  totalObjects: number;
  totalBytes: number;
};

type HelperListEntry =
  | { name: string; kind: "folder" }
  | {
      name: string;
      kind: "file";
      size: number | null;
      mimetype: string | null;
      updated_at: string | null;
    };

type HelperSignedUrl = { path: string | null; signed_url: string | null; error: string | null };

export class StorageHelperError extends Error {
  statusCode: number | null;
  retryable: boolean;

  constructor(message: string, options: { statusCode: number | null; retryable: boolean }) {
    super(message);
    this.name = "StorageHelperError";
    this.statusCode = options.statusCode;
    this.retryable = options.retryable;
  }
}

export type StorageHelperClient = {
  helperHost: string;
  ping: () => Promise<{ helperVersion: number | null }>;
  listBuckets: () => Promise<StorageBucket[]>;
  listObjects: (input: {
    bucketId: string;
    prefix: string;
    offset: number;
  }) => Promise<{ entries: HelperListEntry[]; nextOffset: number | null }>;
  sign: (input: {
    bucketId: string;
    paths: string[];
  }) => Promise<{ expiresInSeconds: number; urls: HelperSignedUrl[] }>;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const isRetryableHelperStatus = (status: number): boolean =>
  status === 408 || status === 425 || status === 429 || status >= 500;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asNumberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const asStringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

export const describeStorageHelperStatus = (status: number): string => {
  if (status === 401) return "The migration helper rejected the access key.";
  if (status === 404) return "The migration helper route was not found. Publish the app and retry.";
  if (status === 405) return "The migration helper only accepts POST requests.";
  return `The migration helper returned HTTP ${status}.`;
};

export const createStorageHelperClient = (input: {
  helperUrl: string;
  accessKey: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}): StorageHelperClient => {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.requestTimeoutMs ?? HELPER_REQUEST_TIMEOUT_MS;

  const call = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    let lastError: StorageHelperError | null = null;
    for (let attempt = 1; attempt <= HELPER_REQUEST_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetchImpl(input.helperUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-access-key": input.accessKey,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const payload = asRecord(await response.json().catch(() => null));
        if (response.ok && payload?.ok === true) return payload;

        const helperMessage = asStringOrNull(payload?.error);
        lastError = new StorageHelperError(
          helperMessage && response.status !== 401
            ? `${describeStorageHelperStatus(response.status)} ${helperMessage}`
            : describeStorageHelperStatus(response.status),
          { statusCode: response.status, retryable: isRetryableHelperStatus(response.status) },
        );
        if (!lastError.retryable) throw lastError;
      } catch (error) {
        if (error instanceof StorageHelperError && !error.retryable) throw error;
        lastError =
          error instanceof StorageHelperError
            ? error
            : new StorageHelperError(
                `Could not reach the migration helper: ${error instanceof Error ? error.message : String(error)}`,
                { statusCode: null, retryable: true },
              );
      }
      if (attempt < HELPER_REQUEST_ATTEMPTS) await sleep(attempt * HELPER_RETRY_BASE_DELAY_MS);
    }
    throw (
      lastError ??
      new StorageHelperError("The migration helper failed.", {
        statusCode: null,
        retryable: true,
      })
    );
  };

  return {
    helperHost: hostOf(input.helperUrl),
    ping: async () => {
      const payload = await call({ action: "ping" });
      return { helperVersion: asNumberOrNull(payload.helper_version) };
    },
    listBuckets: async () => {
      const payload = await call({ action: "list_buckets" });
      const buckets = Array.isArray(payload.buckets) ? payload.buckets : [];
      return buckets
        .map(asRecord)
        .filter((bucket): bucket is Record<string, unknown> => typeof bucket?.id === "string")
        .map((bucket) => ({
          id: bucket.id as string,
          name: typeof bucket.name === "string" ? bucket.name : (bucket.id as string),
          public: bucket.public === true,
          file_size_limit: asNumberOrNull(bucket.file_size_limit),
          allowed_mime_types: Array.isArray(bucket.allowed_mime_types)
            ? bucket.allowed_mime_types.filter((type): type is string => typeof type === "string")
            : null,
        }));
    },
    listObjects: async ({ bucketId, prefix, offset }) => {
      const payload = await call({
        action: "list_objects",
        bucket: bucketId,
        prefix,
        offset,
        limit: HELPER_LIST_PAGE_SIZE,
      });
      const entries = (Array.isArray(payload.entries) ? payload.entries : [])
        .map(asRecord)
        .filter((entry): entry is Record<string, unknown> => typeof entry?.name === "string")
        .map(
          (entry): HelperListEntry =>
            entry.kind === "folder"
              ? { name: entry.name as string, kind: "folder" }
              : {
                  name: entry.name as string,
                  kind: "file",
                  size: asNumberOrNull(entry.size),
                  mimetype: asStringOrNull(entry.mimetype),
                  updated_at: asStringOrNull(entry.updated_at),
                },
        );
      return { entries, nextOffset: asNumberOrNull(payload.next_offset) };
    },
    sign: async ({ bucketId, paths }) => {
      const payload = await call({ action: "sign", bucket: bucketId, paths });
      const urls = (Array.isArray(payload.urls) ? payload.urls : [])
        .map(asRecord)
        .filter((entry): entry is Record<string, unknown> => entry !== null)
        .map((entry) => ({
          path: asStringOrNull(entry.path),
          signed_url: asStringOrNull(entry.signed_url),
          error: asStringOrNull(entry.error),
        }));
      return { expiresInSeconds: asNumberOrNull(payload.expires_in) ?? 0, urls };
    },
  };
};

const comparePaths = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

// Walks every bucket folder by folder. Supabase Storage lists one folder
// level at a time, so this is a breadth-first walk with offset paging.
export const discoverStorageHelperObjects = async (
  client: StorageHelperClient,
  options: {
    onProgress?: (progress: { bucketId: string; objectsFound: number }) => Promise<void> | void;
  } = {},
): Promise<StorageHelperManifest> => {
  const buckets = await client.listBuckets();
  const objectsByBucket = new Map<string, StorageHelperObject[]>();
  let totalObjects = 0;
  let totalBytes = 0;

  for (const bucket of buckets) {
    const bucketId = bucket.id as string;
    const objects: StorageHelperObject[] = [];
    // Offset paging over a live app can return a file twice when one is
    // added mid-listing; keep each path once.
    const seenPaths = new Set<string>();
    const folders = [""];
    while (folders.length > 0) {
      const prefix = folders.shift() as string;
      let offset: number | null = 0;
      while (offset !== null) {
        const page = await client.listObjects({ bucketId, prefix, offset });
        for (const entry of page.entries) {
          const path = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.kind === "folder") {
            folders.push(path);
          } else if (!seenPaths.has(path)) {
            seenPaths.add(path);
            objects.push({ path, size: entry.size, mimetype: entry.mimetype });
            totalBytes += entry.size ?? 0;
          }
        }
        offset = page.nextOffset;
      }
      await options.onProgress?.({ bucketId, objectsFound: totalObjects + objects.length });
    }
    objects.sort((left, right) => comparePaths(left.path, right.path));
    objectsByBucket.set(bucketId, objects);
    totalObjects += objects.length;
  }

  return { buckets, objectsByBucket, totalObjects, totalBytes };
};

type SignedUrlCacheEntry = { url: string | null; error: string | null; refreshAt: number };

export const createStorageHelperCopySource = async (input: {
  client: StorageHelperClient;
  manifest: StorageHelperManifest;
  now?: () => number;
}): Promise<StorageCopySource> => {
  const { client, manifest } = input;
  const now = input.now ?? Date.now;
  const signedUrls = new Map<string, SignedUrlCacheEntry>();
  const pathIndexes = new Map<string, Map<string, number>>();
  for (const [bucketId, objects] of manifest.objectsByBucket) {
    pathIndexes.set(bucketId, new Map(objects.map((object, index) => [object.path, index])));
  }
  const cacheKey = (bucketId: string, path: string) => `${bucketId}\u0000${path}`;

  // Signs the requested object plus the objects after it in manifest order,
  // which is the order the copy engine works through them.
  const signAhead = async (bucketId: string, path: string): Promise<void> => {
    const objects = manifest.objectsByBucket.get(bucketId) ?? [];
    const startIndex = pathIndexes.get(bucketId)?.get(path);
    const paths = [path];
    if (startIndex !== undefined) {
      for (
        let index = startIndex + 1;
        index < objects.length && paths.length < HELPER_MAX_SIGN_PATHS;
        index += 1
      ) {
        const candidate = objects[index]?.path;
        if (candidate === undefined) break;
        const cached = signedUrls.get(cacheKey(bucketId, candidate));
        if (!cached || cached.refreshAt <= now()) paths.push(candidate);
      }
    }
    const signedAt = now();
    const result = await client.sign({ bucketId, paths });
    const refreshAt =
      signedAt + Math.max(0, result.expiresInSeconds * 1000 - SIGNED_URL_REFRESH_MARGIN_MS);
    result.urls.forEach((entry, index) => {
      const entryPath = entry.path ?? paths[index];
      if (entryPath === undefined) return;
      signedUrls.set(cacheKey(bucketId, entryPath), {
        url: entry.signed_url,
        error: entry.error,
        refreshAt,
      });
    });
  };

  const objectEnumerator = await createSourceStorageObjectEnumerator({
    countObjects: async () => manifest.totalObjects,
    listObjects: async (bucketId, lastObjectPath, limit) => {
      const objects = manifest.objectsByBucket.get(bucketId) ?? [];
      const startIndex =
        lastObjectPath === null
          ? 0
          : (pathIndexes.get(bucketId)?.get(lastObjectPath) ?? objects.length - 1) + 1;
      return objects.slice(startIndex, startIndex + limit).map((object) => ({
        objectPath: object.path,
        metadata: {
          ...(object.size !== null ? { size: object.size } : {}),
          ...(object.mimetype ? { mimetype: object.mimetype } : {}),
        },
      }));
    },
    pageSize: HELPER_LIST_PAGE_SIZE,
  });

  return {
    projectHost: client.helperHost,
    listBuckets: async () => manifest.buckets,
    objectEnumerator,
    resolveDownload: async (bucketId, objectPath): Promise<StorageObjectDownload> => {
      const key = cacheKey(bucketId, objectPath);
      let cached = signedUrls.get(key);
      if (!cached || cached.refreshAt <= now()) {
        await signAhead(bucketId, objectPath);
        cached = signedUrls.get(key);
      }
      signedUrls.delete(key);
      if (!cached?.url) {
        return {
          kind: "missing",
          statusCode: MISSING_OBJECT_STATUS,
          ...(cached?.error ? { error: cached.error } : {}),
        };
      }
      return { kind: "request", url: cached.url, headers: {} };
    },
  };
};

// Host of the Supabase project behind the helper, read from a signed URL.
// Used to find restored rows that still point at the old project's files.
export const sourceStorageHostFromSignedUrl = (signedUrl: string): string | null => {
  try {
    return new URL(signedUrl).host;
  } catch {
    return null;
  }
};

const BACKUP_FILE_NAME_PATTERN = /\.(backup|dump)$/i;
const MAX_BACKUP_SIGNATURE_CHECKS = 25;

// Lovable's "Export project data" leaves database backups in the project's
// own storage, one dated bucket per export. They aren't app files, so the
// copy leaves out every file that starts like a PostgreSQL archive.
export const findDatabaseBackupObjects = async (
  client: StorageHelperClient,
  manifest: StorageHelperManifest,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<Array<{ bucketId: string; path: string }>> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const candidates = [...manifest.objectsByBucket.entries()]
    .flatMap(([bucketId, objects]) =>
      objects
        .filter((object) => BACKUP_FILE_NAME_PATTERN.test(object.path))
        .map((object) => ({ bucketId, path: object.path })),
    )
    .slice(0, MAX_BACKUP_SIGNATURE_CHECKS);
  const backups: Array<{ bucketId: string; path: string }> = [];
  for (const candidate of candidates) {
    const signed = await client
      .sign({ bucketId: candidate.bucketId, paths: [candidate.path] })
      .catch(() => null);
    const url = signed?.urls[0]?.signed_url;
    if (!url) continue;
    const isArchive = await fetchImpl(url, {
      headers: { Range: "bytes=0-4" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    })
      .then(async (response) => {
        if (!response.ok || !response.body) return false;
        // Read only the first chunk, in case the server ignores Range.
        const reader = response.body.getReader();
        try {
          const { value } = await reader.read();
          return new TextDecoder().decode((value ?? new Uint8Array()).slice(0, 5)) === "PGDMP";
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      })
      .catch(() => false);
    if (isArchive) backups.push(candidate);
  }
  return backups;
};
