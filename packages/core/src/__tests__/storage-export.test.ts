import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StorageExportEntrySkippedError,
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
        if (entry.relativePath === "storage/avatars/logo.png") {
          try {
            const body = await readEntryBody(entry.body);
            entries.push({ ...entry, body: new TextEncoder().encode(body) });
            return;
          } catch (error) {
            throw new StorageExportEntrySkippedError("source body failed", { cause: error });
          }
        }
        entries.push(entry);
      },
    });

    expect(summary).toEqual({
      bucketIds: ["avatars"],
      bucketsTotal: 1,
      objectsTotal: 1,
      objectsCopied: 1,
      objectsSkippedMissing: 0,
      missingObjects: [],
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

  it("retries object body stream failures before writing entries", async () => {
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
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("partial"));
                  controller.error(new TypeError("terminated"));
                },
              }),
              { status: 200 },
            );
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
        if (entry.relativePath === "storage/avatars/logo.png") {
          try {
            const body = await readEntryBody(entry.body);
            entries.push({ ...entry, body: new TextEncoder().encode(body) });
            return;
          } catch (error) {
            throw new StorageExportEntrySkippedError("source body failed", { cause: error });
          }
        }
        entries.push(entry);
      },
    });

    expect(summary.objectsCopied).toBe(1);
    expect(downloadAttempts).toBe(2);
    expect(await readEntryBody(entries[1]!.body)).toBe("PNGDATA");
  });

  it("limits concurrent object downloads by estimated in-flight bytes", async () => {
    let activeObjectFetches = 0;
    let maxActiveObjectFetches = 0;
    const objects: StorageExportDiscoveredObject[] = [
      { fullPath: "one.png", metadata: { size: 7 } },
      { fullPath: "two.png", metadata: { size: 7 } },
      { fullPath: "three.png", metadata: { size: 7 } },
    ];

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
          activeObjectFetches += 1;
          maxActiveObjectFetches = Math.max(maxActiveObjectFetches, activeObjectFetches);
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 10);
          });
          activeObjectFetches -= 1;
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
      maxInflightBytes: 10,
      sourceObjectEnumerator: createSourceObjectEnumerator(objects),
      writeFile: async () => {},
    });

    expect(summary.objectsCopied).toBe(3);
    expect(maxActiveObjectFetches).toBe(1);
  });

  it("keeps small object downloads parallel when the byte budget allows it", async () => {
    let activeObjectFetches = 0;
    let maxActiveObjectFetches = 0;
    const objects: StorageExportDiscoveredObject[] = [
      { fullPath: "one.png", metadata: { size: 7 } },
      { fullPath: "two.png", metadata: { size: 7 } },
      { fullPath: "three.png", metadata: { size: 7 } },
    ];

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
          activeObjectFetches += 1;
          maxActiveObjectFetches = Math.max(maxActiveObjectFetches, activeObjectFetches);
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 10);
          });
          activeObjectFetches -= 1;
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
      maxInflightBytes: 21,
      sourceObjectEnumerator: createSourceObjectEnumerator(objects),
      writeFile: async () => {},
    });

    expect(summary.objectsCopied).toBe(3);
    expect(maxActiveObjectFetches).toBeGreaterThan(1);
  });

  it("streams object entries so callers can spool them before archive writes", async () => {
    let objectFetchAttempts = 0;
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
          objectFetchAttempts += 1;
          return new Response("LARGEPNG", {
            status: 200,
            headers: {
              "Content-Type": "image/png",
              "Content-Length": "11",
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
      sourceObjectEnumerator: createSourceObjectEnumerator([
        { fullPath: "large.png", metadata: { size: 11 } },
      ]),
      writeFile: async (entry) => {
        entries.push(entry);
      },
    });

    expect(summary.objectsCopied).toBe(1);
    expect(objectFetchAttempts).toBe(1);
    expect(entries[1]?.body).toBeInstanceOf(ReadableStream);
    expect(await readEntryBody(entries[1]!.body)).toBe("LARGEPNG");
  });

  it("skips failed object exports and continues with later objects", async () => {
    const entries: StorageExportFileEntry[] = [];
    const objects: StorageExportDiscoveredObject[] = [
      { fullPath: "blocked.png", metadata: { size: 7 } },
      { fullPath: "logo.png", metadata: { size: 7 } },
    ];

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

        if (url.includes("/storage/v1/object/avatars/blocked.png")) {
          return new Response("forbidden", { status: 403 });
        }

        if (url.includes("/storage/v1/object/avatars/logo.png")) {
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
      sourceObjectEnumerator: createSourceObjectEnumerator(objects),
      writeFile: async (entry) => {
        entries.push(entry);
      },
    });

    expect(summary.objectsCopied).toBe(1);
    expect(summary.objectsSkippedMissing).toBe(1);
    expect(summary.missingObjects).toMatchObject([
      {
        bucketId: "avatars",
        objectPath: "blocked.png",
        statusCode: 0,
        reason: "source_object_export_failed",
      },
    ]);
    expect(entries.map((entry) => entry.relativePath)).toEqual([
      "storage/buckets.json",
      "storage/avatars/logo.png",
      "storage/missing-objects.csv",
    ]);
  });

  it("propagates archive write failures instead of reporting object skips", async () => {
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

    await expect(
      runStorageExportEngine({
        sourceProjectUrl: "https://source.supabase.co",
        sourceAdminKey: "source-key",
        concurrency: 32,
        sourceObjectEnumerator: createSourceObjectEnumerator(),
        writeFile: async (entry) => {
          if (entry.relativePath === "storage/avatars/logo.png") {
            throw new Error("zip append failed");
          }
        },
      }),
    ).rejects.toThrow("zip append failed");
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
    expect(summary.missingObjects).toEqual([
      {
        bucketId: "avatars",
        objectPath: "ghost.png",
        projectHost: "source.supabase.co",
        projectRole: "source",
        statusCode: 404,
        reason: "source_object_not_found",
      },
    ]);
    expect(entries.map((entry) => entry.relativePath)).toEqual([
      "storage/buckets.json",
      "storage/missing-objects.csv",
    ]);
    expect(await readEntryBody(entries[1]!.body)).toBe(
      "bucket_id,object_path,project_host,project_role,status_code,reason,error\navatars,ghost.png,source.supabase.co,source,404,source_object_not_found,\n",
    );
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
