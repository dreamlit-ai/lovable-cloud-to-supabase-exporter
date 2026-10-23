// Temporary migration helper for newer Lovable projects.
//
// Lovable wires this file into a server route (for example
// /api/public/migration-helper) and passes in the project's existing
// server-side Supabase client, the one created with the service role key.
// The key never leaves the app's server: callers only receive bucket
// settings, file listings, and short-lived signed download URLs.
//
// Every request must send the access key in the x-access-key header.
// Remove the route once the migration is finished.

const HELPER_VERSION = 1;
const ACCESS_KEY = "replace-with-your-long-random-access-key";
const SIGNED_URL_TTL_SECONDS = 600;
const MAX_LIST_LIMIT = 1000;
const MAX_SIGN_PATHS = 100;
// The key unlocks every stored file, including the database export.
const MIN_ACCESS_KEY_LENGTH = 32;

interface StorageResult<T> {
  data: T | null;
  error: { message: string } | null;
}

interface StorageBucketRecord {
  id: string;
  name: string;
  public: boolean;
  file_size_limit?: number | null;
  allowed_mime_types?: string[] | null;
}

interface StorageListRecord {
  name: string;
  id: string | null;
  updated_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface StorageSignedUrlRecord {
  path: string | null;
  signedUrl: string | null;
  error: string | null;
}

export interface MigrationHelperStorageClient {
  storage: {
    listBuckets(): Promise<StorageResult<StorageBucketRecord[]>>;
    from(bucket: string): {
      list(
        path: string,
        options: {
          limit: number;
          offset: number;
          sortBy: { column: string; order: string };
        },
      ): Promise<StorageResult<StorageListRecord[]>>;
      createSignedUrls(
        paths: string[],
        expiresIn: number,
      ): Promise<StorageResult<StorageSignedUrlRecord[]>>;
    };
  };
}

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });

const errorResponse = (status: number, error: string): Response =>
  jsonResponse({ ok: false, error }, status);

const accessKeyMatches = (provided: string | null): boolean => {
  if (
    !provided ||
    ACCESS_KEY.startsWith("replace-with-") ||
    ACCESS_KEY.length < MIN_ACCESS_KEY_LENGTH
  ) {
    return false;
  }
  const expected = ACCESS_KEY;
  let difference = provided.length ^ expected.length;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= (provided.charCodeAt(index) || 0) ^ expected.charCodeAt(index);
  }
  return difference === 0;
};

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

const readCount = (value: unknown, fallback: number, max: number): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return fallback;
  return Math.min(value, max);
};

const readSize = (metadata: Record<string, unknown> | null | undefined): number | null => {
  const size = metadata?.size ?? metadata?.contentLength;
  return typeof size === "number" && Number.isFinite(size) ? size : null;
};

export async function handleMigrationHelperRequest(
  request: Request,
  admin: MigrationHelperStorageClient,
): Promise<Response> {
  if (request.method !== "POST") return errorResponse(405, "Use POST.");
  if (!accessKeyMatches(request.headers.get("x-access-key"))) {
    return errorResponse(401, "Unauthorized");
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return errorResponse(400, "Send a JSON object.");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return errorResponse(400, "Send a JSON object.");
  }

  try {
    switch (body.action) {
      case "ping":
        return jsonResponse({ ok: true, helper_version: HELPER_VERSION });

      case "list_buckets": {
        const { data, error } = await admin.storage.listBuckets();
        if (error) return errorResponse(502, error.message);
        return jsonResponse({
          ok: true,
          buckets: (data ?? []).map((bucket) => ({
            id: bucket.id,
            name: bucket.name,
            public: bucket.public,
            file_size_limit: bucket.file_size_limit ?? null,
            allowed_mime_types: bucket.allowed_mime_types ?? null,
          })),
        });
      }

      case "list_objects": {
        const bucket = readString(body.bucket);
        if (!bucket) return errorResponse(400, "bucket is required.");
        const prefix = typeof body.prefix === "string" ? body.prefix : "";
        const offset = readCount(body.offset, 0, Number.MAX_SAFE_INTEGER);
        const limit = readCount(body.limit, MAX_LIST_LIMIT, MAX_LIST_LIMIT) || MAX_LIST_LIMIT;
        const { data, error } = await admin.storage.from(bucket).list(prefix, {
          limit,
          offset,
          sortBy: { column: "name", order: "asc" },
        });
        if (error) return errorResponse(502, error.message);
        const records = data ?? [];
        return jsonResponse({
          ok: true,
          entries: records.map((record) =>
            record.id === null
              ? { name: record.name, kind: "folder" }
              : {
                  name: record.name,
                  kind: "file",
                  size: readSize(record.metadata),
                  mimetype:
                    typeof record.metadata?.mimetype === "string" ? record.metadata.mimetype : null,
                  updated_at: record.updated_at ?? null,
                },
          ),
          // Storage may return fewer rows than asked for, so keep paging
          // until a page comes back empty.
          next_offset: records.length > 0 ? offset + records.length : null,
        });
      }

      case "sign": {
        const bucket = readString(body.bucket);
        const paths = Array.isArray(body.paths)
          ? body.paths.filter((path): path is string => typeof path === "string" && path !== "")
          : [];
        if (!bucket || paths.length === 0) {
          return errorResponse(400, "bucket and paths are required.");
        }
        if (paths.length > MAX_SIGN_PATHS) {
          return errorResponse(400, `Sign at most ${MAX_SIGN_PATHS} paths per request.`);
        }
        const { data, error } = await admin.storage
          .from(bucket)
          .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);
        if (error) return errorResponse(502, error.message);
        return jsonResponse({
          ok: true,
          expires_in: SIGNED_URL_TTL_SECONDS,
          urls: (data ?? []).map((entry) => ({
            path: entry.path,
            signed_url: entry.signedUrl || null,
            error: entry.error,
          })),
        });
      }

      default:
        return errorResponse(400, "Unknown action.");
    }
  } catch {
    return errorResponse(500, "The migration helper failed. Try again.");
  }
}
