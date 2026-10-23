import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStorageHelperClient,
  createStorageHelperCopySource,
  discoverStorageHelperObjects,
} from "../storage-helper-source";

// Contract between the helper route that Lovable adds to the app
// (storage-helper/migration-helper.ts) and the client the runner uses.
const HELPER_SOURCE = path.resolve(__dirname, "../../../../storage-helper/migration-helper.ts");
const ACCESS_KEY = "contract-test-access-key-0123456789";

type HelperModule = {
  handleMigrationHelperRequest: (request: Request, admin: unknown) => Promise<Response>;
};

const files = [
  "users/u1/a.png",
  "users/u1/b.png",
  "users/u2/c.png",
  "top.png",
  ...Array.from({ length: 12 }, (_, index) => `bulk/${String(index).padStart(2, "0")}.jpg`),
];

// Folder-level listing like Supabase Storage's list(), with a small page
// size so paging is exercised.
const fakeSupabaseStorage = {
  storage: {
    listBuckets: async () => ({
      data: [{ id: "photos", name: "photos", public: false, file_size_limit: null }],
      error: null,
    }),
    from: (bucket: string) => ({
      list: async (prefix: string, options: { limit: number; offset: number }) => {
        const base = prefix ? `${prefix}/` : "";
        const names = new Map<string, boolean>();
        for (const file of files) {
          if (!file.startsWith(base)) continue;
          const rest = file.slice(base.length);
          const slash = rest.indexOf("/");
          names.set(slash === -1 ? rest : rest.slice(0, slash), slash !== -1);
        }
        const page = [...names.entries()]
          .sort(([left], [right]) => (left < right ? -1 : 1))
          .slice(options.offset, options.offset + Math.min(options.limit, 5));
        return {
          data: page.map(([name, isFolder]) =>
            isFolder
              ? { name, id: null }
              : { name, id: `${bucket}/${name}`, metadata: { size: 3, mimetype: "image/png" } },
          ),
          error: null,
        };
      },
      createSignedUrls: async (paths: string[], expiresIn: number) => ({
        data: paths.map((filePath) => ({
          path: filePath,
          signedUrl: files.includes(filePath)
            ? `https://src.supabase.co/storage/v1/object/sign/${bucket}/${filePath}?token=t&ttl=${expiresIn}`
            : "",
          error: files.includes(filePath) ? null : "Object not found",
        })),
        error: null,
      }),
    }),
  },
};

let helper: HelperModule;
let tempDir: string;

beforeAll(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), "helper-contract-"));
  const source = readFileSync(HELPER_SOURCE, "utf8");
  if (!source.includes('"replace-with-your-long-random-access-key"')) {
    throw new Error("migration-helper.ts no longer has the access key placeholder");
  }
  const modulePath = path.join(tempDir, "migration-helper.ts");
  writeFileSync(
    modulePath,
    source.replace('"replace-with-your-long-random-access-key"', JSON.stringify(ACCESS_KEY)),
  );
  helper = (await import(pathToFileURL(modulePath).href)) as HelperModule;
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const clientFor = (accessKey: string) =>
  createStorageHelperClient({
    helperUrl: "https://app.lovable.app/api/public/migration-helper",
    accessKey,
    fetchImpl: async (input, init) =>
      helper.handleMigrationHelperRequest(new Request(String(input), init), fakeSupabaseStorage),
  });

describe("migration helper contract", () => {
  it("lists every file through paging and nested folders", async () => {
    const manifest = await discoverStorageHelperObjects(clientFor(ACCESS_KEY));
    expect(manifest.totalObjects).toBe(files.length);
    expect(manifest.objectsByBucket.get("photos")?.map((object) => object.path)).toEqual(
      [...files].sort(),
    );
    expect(manifest.buckets).toEqual([expect.objectContaining({ id: "photos", public: false })]);
  });

  it("hands out signed URLs and reports missing files", async () => {
    const client = clientFor(ACCESS_KEY);
    const manifest = await discoverStorageHelperObjects(client);
    manifest.objectsByBucket.get("photos")?.push({ path: "zz-gone.png", size: 1, mimetype: null });
    const source = await createStorageHelperCopySource({ client, manifest });

    const download = await source.resolveDownload("photos", "users/u1/a.png");
    expect(download).toMatchObject({
      kind: "request",
      url: expect.stringContaining("/object/sign/photos/users/u1/a.png"),
      headers: {},
    });
    await expect(source.resolveDownload("photos", "zz-gone.png")).resolves.toMatchObject({
      kind: "missing",
    });
  });

  it("rejects a wrong access key without retrying", async () => {
    await expect(clientFor("wrong-key").ping()).rejects.toThrow(
      "The migration helper rejected the access key.",
    );
  });

  it("refuses keys too short to protect the files", async () => {
    const source = readFileSync(HELPER_SOURCE, "utf8");
    const modulePath = path.join(tempDir, "short-key-helper.ts");
    writeFileSync(
      modulePath,
      source.replace('"replace-with-your-long-random-access-key"', JSON.stringify("short-key")),
    );
    const shortKeyHelper = (await import(pathToFileURL(modulePath).href)) as HelperModule;
    const response = await shortKeyHelper.handleMigrationHelperRequest(
      new Request("https://app/api", {
        method: "POST",
        headers: { "x-access-key": "short-key" },
        body: JSON.stringify({ action: "ping" }),
      }),
      fakeSupabaseStorage,
    );
    expect(response.status).toBe(401);
  });

  it("refuses to run with the placeholder key left in place", async () => {
    const source = readFileSync(HELPER_SOURCE, "utf8");
    const modulePath = path.join(tempDir, "placeholder-helper.ts");
    writeFileSync(modulePath, source);
    const placeholder = (await import(pathToFileURL(modulePath).href)) as HelperModule;
    const response = await placeholder.handleMigrationHelperRequest(
      new Request("https://app/api", {
        method: "POST",
        headers: { "x-access-key": "replace-with-your-long-random-access-key" },
        body: JSON.stringify({ action: "ping" }),
      }),
      fakeSupabaseStorage,
    );
    expect(response.status).toBe(401);
  });
});
