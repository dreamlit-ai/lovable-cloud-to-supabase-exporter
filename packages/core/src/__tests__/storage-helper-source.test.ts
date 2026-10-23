import { afterEach, describe, expect, it, vi } from "vitest";
import { runStorageCopyEngine } from "../storage-copy";
import {
  createStorageHelperClient,
  createStorageHelperCopySource,
  discoverStorageHelperObjects,
  findDatabaseBackupObjects,
  StorageHelperError,
  type StorageHelperClient,
} from "../storage-helper-source";

type FakeFile = { bucket: string; path: string; body: string };

// In-memory stand-in for the Lovable migration helper: folder-level listing
// with offset paging and per-path signing, like Supabase Storage.
const createFakeHelper = (files: FakeFile[], options: { pageSize?: number } = {}) => {
  const pageSize = options.pageSize ?? 1000;
  const signCalls: string[][] = [];
  let signCounter = 0;
  const client: StorageHelperClient = {
    helperHost: "app.example",
    ping: async () => ({ helperVersion: 1 }),
    listBuckets: async () =>
      [...new Set(files.map((file) => file.bucket))].map((id) => ({
        id,
        name: id,
        public: id === "public-assets",
      })),
    listObjects: async ({ bucketId, prefix, offset }) => {
      const base = prefix ? `${prefix}/` : "";
      const names = new Map<string, "file" | "folder">();
      for (const file of files) {
        if (file.bucket !== bucketId || !file.path.startsWith(base)) continue;
        const rest = file.path.slice(base.length);
        const slash = rest.indexOf("/");
        names.set(slash === -1 ? rest : rest.slice(0, slash), slash === -1 ? "file" : "folder");
      }
      const sorted = [...names.entries()].sort(([left], [right]) => (left < right ? -1 : 1));
      const page = sorted.slice(offset, offset + pageSize);
      return {
        entries: page.map(([name, kind]) =>
          kind === "folder"
            ? { name, kind }
            : { name, kind, size: 5, mimetype: "image/png", updated_at: null },
        ),
        nextOffset: page.length === pageSize ? offset + pageSize : null,
      };
    },
    sign: async ({ bucketId, paths }) => {
      signCalls.push(paths);
      signCounter += 1;
      return {
        expiresInSeconds: 600,
        urls: paths.map((path) => {
          const exists = files.some((file) => file.bucket === bucketId && file.path === path);
          return {
            path,
            signed_url: exists
              ? `https://src.supabase.co/storage/v1/object/sign/${bucketId}/${path}?token=t${signCounter}`
              : null,
            error: exists
              ? null
              : "Either the object does not exist or you do not have access to it",
          };
        }),
      };
    },
  };
  return { client, signCalls };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("discoverStorageHelperObjects", () => {
  it("walks nested folders across pages and finds every file once", async () => {
    const files: FakeFile[] = [
      ...Array.from({ length: 25 }, (_, index) => ({
        bucket: "photos",
        path: `users/u${index % 3}/pic-${index}.png`,
        body: `p${index}`,
      })),
      { bucket: "photos", path: "top.png", body: "top" },
      { bucket: "photos", path: "a/b/c/d.png", body: "deep" },
      { bucket: "public-assets", path: "logo.png", body: "logo" },
    ];
    const { client } = createFakeHelper(files, { pageSize: 4 });

    const manifest = await discoverStorageHelperObjects(client);

    expect(manifest.totalObjects).toBe(files.length);
    expect(manifest.buckets.map((bucket) => bucket.id)).toEqual(["photos", "public-assets"]);
    const photos = manifest.objectsByBucket.get("photos")?.map((object) => object.path) ?? [];
    expect(new Set(photos).size).toBe(27);
    expect(photos).toEqual([...photos].sort());
    expect(manifest.totalBytes).toBe(files.length * 5);
  });
});

describe("discoverStorageHelperObjects with a changing app", () => {
  it("keeps each file once when paging repeats an entry", async () => {
    const { client } = createFakeHelper([
      { bucket: "photos", path: "a.png", body: "a" },
      { bucket: "photos", path: "b.png", body: "b" },
    ]);
    const listObjects = client.listObjects;
    let calls = 0;
    // Simulates a file added mid-listing: the second page repeats "b.png".
    client.listObjects = async (input) => {
      calls += 1;
      if (calls === 1) {
        return {
          entries: [{ name: "a.png", kind: "file", size: 1, mimetype: null, updated_at: null }],
          nextOffset: 1,
        };
      }
      if (calls === 2) {
        return {
          entries: [
            { name: "b.png", kind: "file", size: 1, mimetype: null, updated_at: null },
            { name: "b.png", kind: "file", size: 1, mimetype: null, updated_at: null },
          ],
          nextOffset: null,
        };
      }
      return listObjects(input);
    };

    const manifest = await discoverStorageHelperObjects(client);
    expect(manifest.objectsByBucket.get("photos")?.map((object) => object.path)).toEqual([
      "a.png",
      "b.png",
    ]);
    expect(manifest.totalObjects).toBe(2);
  });
});

describe("createStorageHelperCopySource", () => {
  it("signs ahead in batches of at most 100 paths", async () => {
    const files = Array.from({ length: 250 }, (_, index) => ({
      bucket: "photos",
      path: `p/${String(index).padStart(3, "0")}.png`,
      body: "x",
    }));
    const { client, signCalls } = createFakeHelper(files);
    const manifest = await discoverStorageHelperObjects(client);
    const source = await createStorageHelperCopySource({ client, manifest });

    for (const file of files) {
      const download = await source.resolveDownload("photos", file.path);
      expect(download.kind).toBe("request");
    }

    expect(signCalls.length).toBe(3);
    expect(Math.max(...signCalls.map((paths) => paths.length))).toBe(100);
  });

  it("reports objects the helper can no longer sign as missing", async () => {
    const { client } = createFakeHelper([{ bucket: "photos", path: "kept.png", body: "x" }]);
    const manifest = await discoverStorageHelperObjects(client);
    manifest.objectsByBucket.get("photos")?.push({ path: "gone.png", size: 1, mimetype: null });
    const source = await createStorageHelperCopySource({ client, manifest });

    await expect(source.resolveDownload("photos", "gone.png")).resolves.toEqual({
      kind: "missing",
      statusCode: 404,
      error: "Either the object does not exist or you do not have access to it",
    });
  });

  it("re-signs when a cached URL is close to expiring", async () => {
    let clock = 0;
    const files = [
      { bucket: "photos", path: "a.png", body: "a" },
      { bucket: "photos", path: "b.png", body: "b" },
    ];
    const { client, signCalls } = createFakeHelper(files);
    const manifest = await discoverStorageHelperObjects(client);
    const source = await createStorageHelperCopySource({ client, manifest, now: () => clock });

    await source.resolveDownload("photos", "a.png");
    expect(signCalls).toEqual([["a.png", "b.png"]]);
    clock = 9 * 60 * 1000;
    await source.resolveDownload("photos", "b.png");
    expect(signCalls).toEqual([["a.png", "b.png"], ["b.png"]]);
  });

  it("copies every object through signed URLs without sending the target key to the source", async () => {
    const files = [
      { bucket: "photos", path: "users/u1/a.png", body: "aaa" },
      { bucket: "photos", path: "users/u2/b.png", body: "bbb" },
      { bucket: "public-assets", path: "logo.png", body: "logo" },
    ];
    const { client } = createFakeHelper(files);
    const manifest = await discoverStorageHelperObjects(client);
    const source = await createStorageHelperCopySource({ client, manifest });
    const uploads = new Map<string, string>();
    const createdBuckets: unknown[] = [];
    const sourceAuthHeaders: Array<string | null> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.startsWith("https://src.supabase.co/storage/v1/object/sign/")) {
          sourceAuthHeaders.push(new Headers(init?.headers).get("authorization"));
          const [bucket, ...path] = new URL(url).pathname
            .replace("/storage/v1/object/sign/", "")
            .split("/");
          const file = files.find((item) => item.bucket === bucket && item.path === path.join("/"));
          return new Response(file?.body ?? "", { status: file ? 200 : 404 });
        }
        if (url === "https://target.example/storage/v1/bucket" && method === "GET") {
          return Response.json([]);
        }
        if (url === "https://target.example/storage/v1/bucket" && method === "POST") {
          createdBuckets.push(JSON.parse(String(init?.body)));
          return Response.json({});
        }
        if (url.startsWith("https://target.example/storage/v1/object/") && method === "POST") {
          const body = init?.body instanceof ArrayBuffer ? new TextDecoder().decode(init.body) : "";
          uploads.set(
            decodeURIComponent(url.replace("https://target.example/storage/v1/object/", "")),
            body,
          );
          return new Response("{}", { status: 200 });
        }
        throw new Error(`Unexpected fetch ${method} ${url}`);
      }),
    );

    const summary = await runStorageCopyEngine({
      source,
      targetProjectUrl: "https://target.example",
      targetAdminKey: "target-key",
      concurrency: 4,
    });

    expect(summary).toMatchObject({
      objectsTotal: 3,
      objectsCopied: 3,
      objectsFailed: 0,
      objectsSkippedMissing: 0,
      bucketsCreated: 2,
    });
    expect(Object.fromEntries(uploads)).toEqual({
      "photos/users/u1/a.png": "aaa",
      "photos/users/u2/b.png": "bbb",
      "public-assets/logo.png": "logo",
    });
    expect(sourceAuthHeaders).toEqual([null, null, null]);
    expect(createdBuckets).toContainEqual(
      expect.objectContaining({ id: "public-assets", public: true }),
    );
  });
});

describe("createStorageHelperClient", () => {
  it("does not retry a rejected access key and says what went wrong", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    );
    const client = createStorageHelperClient({
      helperUrl: "https://app.example/api/public/migration-helper",
      accessKey: "wrong",
      fetchImpl,
    });

    const error = await client.ping().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StorageHelperError);
    expect((error as StorageHelperError).message).toBe(
      "The migration helper rejected the access key.",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries transient helper failures", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true, helper_version: 1 }));
    const client = createStorageHelperClient({
      helperUrl: "https://app.example/api/public/migration-helper",
      accessKey: "key",
      fetchImpl,
    });

    await expect(client.ping()).resolves.toEqual({ helperVersion: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("x-access-key")).toBe("key");
  });
});

describe("findDatabaseBackupObjects", () => {
  it("finds every real backup, including older exports, by its first bytes", async () => {
    const files: FakeFile[] = [
      { bucket: "database_export_01_10_26", path: "p_261001.backup", body: "PGDMP..." },
      { bucket: "database_export_20_10_26", path: "p_261020.backup", body: "PGDMP..." },
      // Named like a backup, but an app file.
      { bucket: "uploads", path: "notes.backup", body: "just text" },
      { bucket: "uploads", path: "photo.png", body: "PNG" },
    ];
    const { client } = createFakeHelper(files);
    const manifest = await discoverStorageHelperObjects(client);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const match = String(url).match(/\/sign\/([^/]+)\/([^?]+)/);
      const file = files.find((item) => item.bucket === match?.[1] && item.path === match?.[2]);
      return new Response(file?.body ?? "", { status: file ? 206 : 404 });
    });

    const backups = await findDatabaseBackupObjects(client, manifest, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(backups).toEqual([
      { bucketId: "database_export_01_10_26", path: "p_261001.backup" },
      { bucketId: "database_export_20_10_26", path: "p_261020.backup" },
    ]);
    // Only backup-named files are checked.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
