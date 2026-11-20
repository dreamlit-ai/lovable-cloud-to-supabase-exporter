import { afterEach, expect, it, vi } from "vitest";
import { downloadBackup, prepareArchiveFile } from "../backup-download.js";
import { listArchive, restoreStorageObjectOwners } from "../backup-restore.js";
import { runHelperStorageFlow } from "../export-runner.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  mkdir: vi.fn(),
}));
vi.mock("../backup-download.js", { spy: true });
vi.mock("../backup-restore.js", { spy: true });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("restores owners when every source file is already in Supabase", async () => {
  const env = {
    STORAGE_HELPER_URL: "https://helper.example",
    STORAGE_HELPER_ACCESS_KEY: "helper-key",
    SKIP_EXISTING_TARGET_OBJECTS: "true",
    TARGET_PROJECT_URL: "https://target.example",
    TARGET_ADMIN_KEY: "target-key",
    TARGET_DB_URL: "postgresql://example:user@target.example/postgres",
    BACKUP_STORAGE_BUCKET: "backups",
    BACKUP_STORAGE_PATH: "project.backup",
    PROGRESS_CALLBACK_URL: "https://callback.example",
    PROGRESS_CALLBACK_TOKEN: "callback-key",
    RUN_ID: "storage-retry",
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);

  vi.mocked(downloadBackup).mockResolvedValue({ bytes: 10 });
  vi.mocked(prepareArchiveFile).mockResolvedValue({
    archivePath: "/tmp/exporter-storage-retry-test.backup",
    wasZipped: false,
  });
  vi.mocked(listArchive).mockResolvedValue({
    ok: true,
    listing: "4275; 0 17069 TABLE DATA storage objects supabase_storage_admin",
  });
  const restoreOwners = vi.mocked(restoreStorageObjectOwners);
  restoreOwners.mockResolvedValue({ owned: 1, restored: 1, notFound: 0 });

  const progress: Array<{ phase: string; data: Record<string, unknown> }> = [];
  const bucketCreates: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    switch (url) {
      case env.PROGRESS_CALLBACK_URL:
        progress.push(body);
        return new Response();
      case env.STORAGE_HELPER_URL:
        switch (body.action) {
          case "list_buckets":
            return Response.json({
              ok: true,
              buckets: [{ id: "avatars" }, { id: "videos", file_size_limit: 125 * 1024 * 1024 }],
            });
          case "list_objects":
            return Response.json({
              ok: true,
              entries:
                body.bucket === "avatars" ? [{ kind: "file", name: "logo.png", size: 5 }] : [],
            });
          case "sign":
            return Response.json({
              ok: true,
              expires_in: 600,
              urls: [{ path: "logo.png", signed_url: "https://source.example/logo.png" }],
            });
        }
        break;
      case `${env.TARGET_PROJECT_URL}/storage/v1/bucket`:
        if (init?.method === "GET") return Response.json([{ id: "avatars" }]);
        bucketCreates.push(body);
        return body.file_size_limit
          ? Response.json({ error: "EntityTooLarge" }, { status: 400 })
          : Response.json({});
      case `${env.TARGET_PROJECT_URL}/storage/v1/object/list/avatars`:
        return Response.json([{ id: "old-id", name: "logo.png", metadata: { size: 5 } }]);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  await runHelperStorageFlow();

  expect(bucketCreates).toHaveLength(2);
  expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain("https://source.example/logo.png");
  expect(restoreOwners).toHaveBeenCalledOnce();
  expect(restoreOwners).toHaveBeenCalledWith(
    expect.objectContaining({ archivePath: "/tmp/exporter-storage-retry-test.backup" }),
    expect.objectContaining({ schema: "storage", name: "objects" }),
  );
  expect(progress.find(({ phase }) => phase === "storage_copy.succeeded")?.data).toMatchObject({
    objects_copied: 0,
    objects_skipped_existing: 1,
  });
  expect(progress.at(-1)).toMatchObject({
    phase: "storage.succeeded",
    data: {
      follow_ups: [
        {
          area: "storage",
          text: expect.stringMatching(
            /videos.*125 MB.*Supabase Storage settings.*Retry storage only/,
          ),
        },
      ],
    },
  });
});
