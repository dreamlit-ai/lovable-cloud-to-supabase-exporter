import { describe, expect, it, vi } from "vitest";
import { createSourceStorageObjectEnumerator } from "../source-storage-discovery";

describe("createSourceStorageObjectEnumerator", () => {
  it("keeps a prefix batch together across page boundaries", async () => {
    const listObjects = vi.fn(
      async (_bucketId: string, lastObjectPath: string | null, limit: number) => {
        expect(limit).toBe(2);

        if (lastObjectPath === null) {
          return [
            { objectPath: "folder-a/group-1/a.png", metadata: null },
            { objectPath: "folder-a/group-1/b.png", metadata: null },
          ];
        }

        if (lastObjectPath === "folder-a/group-1/b.png") {
          return [
            { objectPath: "folder-a/group-1/c.png", metadata: null },
            { objectPath: "folder-a/group-9/z.png", metadata: null },
          ];
        }

        return [];
      },
    );

    const enumerator = await createSourceStorageObjectEnumerator({
      countObjects: async () => 4,
      listObjects,
      pageSize: 2,
    });

    const batches: Array<{ prefix: string; paths: string[] }> = [];
    await enumerator.forEachBucketObjectBatch("avatars", async (batch) => {
      batches.push({
        prefix: batch.prefix,
        paths: batch.fileObjects.map((item) => item.fullPath),
      });
    });

    expect(enumerator.exactTotalObjects).toBe(4);
    expect(batches).toEqual([
      {
        prefix: "folder-a/group-1/",
        paths: ["folder-a/group-1/a.png", "folder-a/group-1/b.png", "folder-a/group-1/c.png"],
      },
      {
        prefix: "folder-a/group-9/",
        paths: ["folder-a/group-9/z.png"],
      },
    ]);
  });
});
