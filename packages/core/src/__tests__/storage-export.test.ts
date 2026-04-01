import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runStorageExportEngine,
  type StorageExportDiscoveredObject,
  type StorageExportFileEntry,
} from "../storage-export";

const readEntryBody = async (body: StorageExportFileEntry["body"]): Promise<string> => {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
  return await new Response(body).text();
};

const createSourceObjectEnumerator = (
  objects: StorageExportDiscoveredObject[] = [
    {
      fullPath: "logo.png",
      metadata: { mimetype: "image/png", cacheControl: "3600" },
    },
  ],
): Parameters<typeof runStorageExportEngine>[0]["sourceObjectEnumerator"] => ({
  exactTotalObjects: objects.length,
  forEachBucketObjectBatch: async (_bucketId, onBatch) => {
    await onBatch({
      prefix: "",
      fileObjects: objects,
    });
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runStorageExportEngine", () => {
  it("retries transient object downloads and writes streamed entries", async () => {
    let downloadAttempts = 0;
    const entries: StorageExportFileEntry[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

        if (url.endsWith("/storage/v1/bucket")) {
          return new Response(JSON.stringify([{ id: "avatars", name: "avatars" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.includes("/storage/v1/object/avatars/")) {
          downloadAttempts += 1;
          if (downloadAttempts === 1) {
            return new Response("temporary overload", { status: 503 });
          }
          return new Response("PNGDATA", {
            status: 200,
            headers: {
              "Content-Type": "image/png",
              "Content-Length": "7",
            },
          });
        }

        throw new Error(`Unexpected fetch request: ${url}`);
      }),
    );

    const summary = await runStorageExportEngine({
      sourceProjectUrl: "https://source.supabase.co",
      sourceAdminKey: "source-key",
      concurrency: 32,
      sourceObjectEnumerator: createSourceObjectEnumerator(),
      writeFile: async (entry) => {
        entries.push(entry);
      },
    });

    expect(summary).toEqual({
      bucketIds: ["avatars"],
      bucketsTotal: 1,
      objectsTotal: 1,
      objectsCopied: 1,
      objectsSkippedMissing: 0,
    });
    expect(downloadAttempts).toBe(2);
    expect(entries.map((entry) => entry.relativePath)).toEqual([
      "storage/buckets.json",
      "storage/avatars/logo.png",
    ]);
    expect(entries[1]?.sizeBytes).toBe(7);
    expect(entries[1]?.contentType).toBe("image/png");
    expect(entries[1]?.cacheControl).toBe("3600");
    expect(await readEntryBody(entries[1]!.body)).toBe("PNGDATA");
  });

  it("skips missing objects without writing object entries", async () => {
    const entries: StorageExportFileEntry[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

        if (url.endsWith("/storage/v1/bucket")) {
          return new Response(JSON.stringify([{ id: "avatars", name: "avatars" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.includes("/storage/v1/object/avatars/ghost.png")) {
          return new Response(JSON.stringify({ error: "not_found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        throw new Error(`Unexpected fetch request: ${url}`);
      }),
    );

    const summary = await runStorageExportEngine({
      sourceProjectUrl: "https://source.supabase.co",
      sourceAdminKey: "source-key",
      concurrency: 16,
      sourceObjectEnumerator: createSourceObjectEnumerator([
        { fullPath: "ghost.png", metadata: null },
      ]),
      writeFile: async (entry) => {
        entries.push(entry);
      },
    });

    expect(summary.objectsCopied).toBe(0);
    expect(summary.objectsSkippedMissing).toBe(1);
    expect(entries.map((entry) => entry.relativePath)).toEqual(["storage/buckets.json"]);
  });

  it("accepts an exact-count source object enumerator instead of listing storage prefixes", async () => {
    const entries: StorageExportFileEntry[] = [];
    const progressEvents: Array<{ prefixesScanned: number; scanComplete: boolean }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.endsWith("/storage/v1/bucket")) {
        return new Response(JSON.stringify([{ id: "avatars", name: "avatars" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/storage/v1/object/avatars/")) {
        return new Response("PNGDATA", {
          status: 200,
          headers: {
            "Content-Type": "image/png",
            "Content-Length": "7",
          },
        });
      }

      throw new Error(`Unexpected fetch request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await runStorageExportEngine({
      sourceProjectUrl: "https://source.supabase.co",
      sourceAdminKey: "source-key",
      concurrency: 8,
      sourceObjectEnumerator: {
        exactTotalObjects: 1,
        forEachBucketObjectBatch: async (bucketId, onBatch) => {
          expect(bucketId).toBe("avatars");
          await onBatch({
            prefix: "folder-a/group-1/",
            fileObjects: [
              {
                fullPath: "folder-a/group-1/logo.png",
                metadata: { mimetype: "image/png", cacheControl: "3600" },
              },
            ],
          });
        },
      },
      writeFile: async (entry) => {
        entries.push(entry);
      },
      onProgress: (progress) => {
        progressEvents.push({
          prefixesScanned: progress.prefixesScanned,
          scanComplete: progress.scanComplete,
        });
      },
    });

    expect(summary.objectsTotal).toBe(1);
    expect(summary.objectsCopied).toBe(1);
    expect(entries.map((entry) => entry.relativePath)).toEqual([
      "storage/buckets.json",
      "storage/avatars/folder-a/group-1/logo.png",
    ]);
    expect(fetchMock).not.toHaveBeenCalledWith(
      "https://source.supabase.co/storage/v1/object/list/avatars",
      expect.anything(),
    );
    expect(progressEvents.some((progress) => progress.prefixesScanned > 0)).toBe(true);
    expect(progressEvents.at(-1)?.scanComplete).toBe(true);
  });
});
