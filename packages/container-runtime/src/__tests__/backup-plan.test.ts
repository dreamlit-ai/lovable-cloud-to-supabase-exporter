import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import {
  checkArchiveCompatibility,
  CopyRowCounter,
  detectBackupContainer,
  findManagedDataGaps,
  ManagedTableAdapter,
  parseArchiveHeader,
  StorageOwnerRowExtractor,
  parseExtensionStatements,
  parseTocLine,
  parseTocList,
  planBackupRestore,
  triggerCallsAppFunction,
} from "../backup-plan";
import { EXCLUDED_DATA_TABLES } from "../db-schemas";

// TOC of a pg_dump --format=custom --compress=zstd archive of a Supabase
// project with a Lovable-style app: RLS-protected tables, a profile trigger
// on auth.users, storage policies, a custom schema, and auth users.
const toc = readFileSync(new URL("./fixtures/supabase-backup-toc.txt", import.meta.url), "utf8");

const lineFor = (pattern: RegExp) => {
  const line = toc.split("\n").find((candidate) => pattern.test(candidate));
  if (!line) throw new Error(`fixture has no line matching ${pattern}`);
  return line;
};

describe("parseArchiveHeader", () => {
  it("reads format, compression, and pg_dump version", () => {
    expect(parseArchiveHeader(toc)).toMatchObject({
      format: "CUSTOM",
      compression: "zstd",
      dumpedByVersion: expect.stringMatching(/^17\./),
    });
  });

  it("rejects non-custom formats but not a newer pg_dump", () => {
    // Lovable's real exports come from pg_dump 18; pg_restore 17 reads them.
    expect(
      checkArchiveCompatibility({
        ...parseArchiveHeader(toc),
        dumpedByVersion: "18.6 (Debian 18.6-3)",
      }),
    ).toEqual({ ok: true });
    expect(checkArchiveCompatibility({ ...parseArchiveHeader(toc), format: "TAR" })).toMatchObject({
      ok: false,
      reason: "not_custom_format",
    });
    expect(checkArchiveCompatibility(parseArchiveHeader("garbage"))).toMatchObject({
      ok: false,
      reason: "unreadable_header",
    });
    expect(checkArchiveCompatibility(parseArchiveHeader(toc))).toEqual({ ok: true });
  });
});

describe("parseTocLine", () => {
  it("splits multi-word descriptions, names with spaces, and missing owners", () => {
    expect(parseTocLine(lineFor(/POLICY storage objects own photos read/))).toMatchObject({
      desc: "POLICY",
      schema: "storage",
      name: "objects own photos read",
      owner: "supabase_storage_admin",
    });
    expect(parseTocLine(lineFor(/TABLE DATA public todos/))).toMatchObject({
      desc: "TABLE DATA",
      schema: "public",
      name: "todos",
    });
    expect(parseTocLine(lineFor(/EXTENSION - pg_net/))).toMatchObject({
      desc: "EXTENSION",
      schema: null,
      name: "pg_net",
      owner: null,
    });
    expect(parseTocLine(lineFor(/SEQUENCE SET public audit_events_id_seq/))).toMatchObject({
      desc: "SEQUENCE SET",
    });
  });

  it("parses every entry in a real archive listing", () => {
    const listedEntries = toc.split("\n").filter((line) => /^\d+;/.test(line));
    expect(listedEntries.length).toBeGreaterThan(500);
    expect(parseTocList(toc)).toHaveLength(listedEntries.length);
  });
});

describe("planBackupRestore", () => {
  const plan = planBackupRestore(parseTocList(toc), { excludeDataTables: EXCLUDED_DATA_TABLES });
  const names = (entries: { desc: string; schema: string | null; name: string }[]) =>
    entries.map((entry) => `${entry.desc} ${entry.schema ?? "-"} ${entry.name}`);

  it("treats public and custom non-managed schemas as app schemas", () => {
    expect(plan.appSchemas).toEqual(["public", "app_private"]);
  });

  it("restores app objects but no Supabase-managed schema objects", () => {
    const schemaEntries = names(plan.schemaEntries);
    expect(schemaEntries).toEqual(
      expect.arrayContaining([
        "TABLE public todos",
        "TABLE public profiles",
        "TYPE public todo_priority",
        "VIEW public open_todos",
        "POLICY public todos own todos",
        "ROW SECURITY public todos",
        "FUNCTION public handle_new_user()",
        "TABLE app_private settings",
        "FK CONSTRAINT public todos todos_user_id_fkey",
      ]),
    );
    expect(
      plan.schemaEntries.every((entry) => ["public", "app_private"].includes(entry.schema ?? "")),
    ).toBe(true);
    expect(plan.schemaEntries.some((entry) => entry.desc === "ACL")).toBe(false);
  });

  it("loads app data and auth accounts, skipping session and log tables", () => {
    const data = names(plan.dataEntries);
    expect(data).toEqual(
      expect.arrayContaining([
        "TABLE DATA public todos",
        "TABLE DATA public profiles",
        "TABLE DATA app_private settings",
        "TABLE DATA auth users",
        "TABLE DATA auth identities",
        "SEQUENCE SET public audit_events_id_seq",
      ]),
    );
    expect(data).not.toContain("TABLE DATA auth sessions");
    expect(data).not.toContain("TABLE DATA auth refresh_tokens");
    expect(data).not.toContain("TABLE DATA storage objects");
    expect(data).not.toContain("TABLE DATA vault secrets");
    expect(data.some((entry) => entry.includes(" realtime "))).toBe(false);
    expect(plan.skippedDataTables).toContain("auth.sessions");
  });

  it("picks out app-created objects in managed schemas for selective restore", () => {
    expect(names(plan.storagePolicyEntries)).toEqual(
      expect.arrayContaining([
        "POLICY storage objects own photos read",
        "POLICY storage objects own photos write",
      ]),
    );
    expect(names(plan.authTriggerEntries)).toEqual(["TRIGGER auth users on_auth_user_created"]);
    expect(plan.storageObjectsDataEntry?.name).toBe("objects");
  });
});

describe("triggerCallsAppFunction", () => {
  it("keeps triggers that call app functions only", () => {
    const sql =
      "CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();";
    expect(triggerCallsAppFunction(sql, ["public"])).toBe(true);
    expect(
      triggerCallsAppFunction(sql.replace("public.handle_new_user", "auth.something"), ["public"]),
    ).toBe(false);
    expect(triggerCallsAppFunction(sql.replace("public.", '"My App".'), ["public", "My App"])).toBe(
      true,
    );
  });
});

describe("parseExtensionStatements", () => {
  it("reads extension names and schemas from rendered SQL", () => {
    expect(
      parseExtensionStatements(
        'CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;\nCREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;\nCREATE EXTENSION IF NOT EXISTS plpgsql WITH SCHEMA pg_catalog;',
      ),
    ).toEqual([
      { name: "pg_net", schema: "extensions" },
      { name: "uuid-ossp", schema: "extensions" },
    ]);
  });
});

describe("CopyRowCounter", () => {
  it("counts COPY rows per table across chunk boundaries and passes data through", async () => {
    const sql = [
      "SET statement_timeout = 0;",
      "COPY public.todos (id, title) FROM stdin;",
      "1\tBuy milk",
      "2\tLine one\\nline two",
      "\\.",
      'COPY "app_private"."My Settings" (key) FROM stdin;',
      "\\.",
      "COPY auth.users (id) FROM stdin;",
      "a",
      "b",
      "c",
      "\\.",
      "SELECT pg_catalog.setval('public.audit_events_id_seq', 25, true);",
      "",
    ].join("\n");
    const chunks = sql.match(/[\s\S]{1,7}/g) ?? [];
    const counter = new CopyRowCounter();
    let passedThrough = "";
    await pipeline(
      Readable.from(chunks.map((chunk) => Buffer.from(chunk))),
      counter,
      new Writable({
        write(chunk, _encoding, callback) {
          passedThrough += chunk.toString();
          callback();
        },
      }),
    );

    expect(passedThrough).toBe(sql);
    expect(Object.fromEntries(counter.counts)).toEqual({
      "public.todos": 2,
      "app_private.My Settings": 0,
      "auth.users": 3,
    });
  });
});

describe("CopyRowCounter with non-ASCII names", () => {
  it("counts a table whose name is split mid-character across chunks", async () => {
    const sql = Buffer.from('COPY public."tâches" (id) FROM stdin;\n1\n2\n\\.\n');
    const splitAt = sql.indexOf(Buffer.from("â")) + 1;
    const counter = new CopyRowCounter();
    await pipeline(
      Readable.from([sql.subarray(0, splitAt), sql.subarray(splitAt)]),
      counter,
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    );
    expect(Object.fromEntries(counter.counts)).toEqual({ "public.tâches": 2 });
  });
});

describe("detectBackupContainer", () => {
  it("recognizes custom archives and ZIP wrappers", () => {
    expect(detectBackupContainer(new TextEncoder().encode("PGDMP\u0001"))).toBe("archive");
    expect(detectBackupContainer(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0]))).toBe("zip");
    expect(detectBackupContainer(new TextEncoder().encode("-- SQL"))).toBe("unknown");
  });
});

describe("ManagedTableAdapter", () => {
  const adapt = async (sql: string) => {
    const destination = new Map([
      // Older auth: no "expires_at" on one_time_tokens; "confirmed_at" is generated.
      [
        "auth.one_time_tokens",
        new Map([
          ["id", false],
          ["token_hash", false],
        ]),
      ],
      [
        "auth.users",
        new Map([
          ["id", false],
          ["email", false],
          ["confirmed_at", true],
        ]),
      ],
    ]);
    const adapter = new ManagedTableAdapter(destination, new Set(["auth"]));
    let output = "";
    await pipeline(
      // Small chunks exercise lines split across chunk boundaries.
      Readable.from((sql.match(/[\s\S]{1,5}/g) ?? []).map((chunk) => Buffer.from(chunk))),
      adapter,
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          output += chunk.toString("utf8");
          callback();
        },
      }),
    );
    return { output, adjustments: [...adapter.adjustments.values()] };
  };

  it("passes app tables and matching auth tables through unchanged", async () => {
    const sql = [
      "BEGIN;",
      "COPY public.todos (id, expires_at) FROM stdin;",
      "1\t2026-01-01",
      "\\.",
      "COPY auth.users (id, email) FROM stdin;",
      "u1\ta@example.com",
      "\\.",
      "COMMIT;",
      "",
    ].join("\n");
    const { output, adjustments } = await adapt(sql);
    expect(output).toBe(sql);
    expect(adjustments).toEqual([]);
  });

  it("leaves out auth tables the destination lacks and counts their rows", async () => {
    const { output, adjustments } = await adapt(
      [
        "COPY auth.webauthn_credentials (id, user_id) FROM stdin;",
        "c1\tu1",
        "c2\tu1",
        "\\.",
        "COPY auth.scim_users (id) FROM stdin;",
        "\\.",
        "SELECT 1;",
        "",
      ].join("\n"),
    );
    expect(output).toBe("SELECT 1;\n");
    expect(adjustments).toEqual([
      {
        table: "auth.webauthn_credentials",
        rows: 2,
        tableMissing: true,
        droppedColumns: [],
        lostValues: 0,
      },
      { table: "auth.scim_users", rows: 0, tableMissing: true, droppedColumns: [], lostValues: 0 },
    ]);
  });

  it("drops missing and generated columns, counting only real lost values", async () => {
    const { output, adjustments } = await adapt(
      [
        "COPY auth.one_time_tokens (id, token_hash, expires_at) FROM stdin;",
        "t1\th1\t\\N",
        "t2\th2\t2026-01-01 00:00:00+00",
        "\\.",
        "COPY auth.users (id, confirmed_at, email) FROM stdin;",
        "u1\t2026-01-01 00:00:00+00\ta@example.com",
        "\\.",
        "",
      ].join("\n"),
    );
    expect(output).toBe(
      [
        "COPY auth.one_time_tokens (id, token_hash) FROM stdin;",
        "t1\th1",
        "t2\th2",
        "\\.",
        "COPY auth.users (id, email) FROM stdin;",
        "u1\ta@example.com",
        "\\.",
        "",
      ].join("\n"),
    );
    expect(adjustments).toEqual([
      {
        table: "auth.one_time_tokens",
        rows: 2,
        tableMissing: false,
        droppedColumns: ["expires_at"],
        lostValues: 1,
      },
      {
        table: "auth.users",
        rows: 1,
        tableMissing: false,
        droppedColumns: ["confirmed_at"],
        lostValues: 0,
      },
    ]);
  });
});

describe("findManagedDataGaps", () => {
  it("ignores empty leftover tables and generated columns, keeps real data", () => {
    const base = { droppedColumns: [], lostValues: 0, tableMissing: false, rows: 0 };
    const emptyMissing = { ...base, table: "auth.scim_users", tableMissing: true };
    const generatedOnly = {
      ...base,
      table: "auth.users",
      rows: 3,
      droppedColumns: ["confirmed_at"],
    };
    const passkeys = { ...base, table: "auth.webauthn_credentials", tableMissing: true, rows: 2 };
    const lostColumn = {
      ...base,
      table: "auth.one_time_tokens",
      rows: 2,
      droppedColumns: ["expires_at"],
      lostValues: 1,
    };
    expect(findManagedDataGaps([emptyMissing, generatedOnly, passkeys, lostColumn])).toEqual([
      passkeys,
      lostColumn,
    ]);
  });
});

describe("StorageOwnerRowExtractor", () => {
  it("keeps bucket, name, and owners for owned files only, across chunks", async () => {
    const sql = [
      "COPY public.todos (id) FROM stdin;",
      "1",
      "\\.",
      "COPY storage.objects (id, bucket_id, name, owner, created_at, owner_id) FROM stdin;",
      "o1\tphotos\tuser-a/cat\\tdog.png\t11111111-1111-1111-1111-111111111111\t2026-01-01\tuser-a",
      "o2\tpublic\tlogo.png\t\\N\t2026-01-01\t\\N",
      "\\.",
      "",
    ].join("\n");
    const extractor = new StorageOwnerRowExtractor();
    let output = "";
    await pipeline(
      Readable.from((sql.match(/[\s\S]{1,6}/g) ?? []).map((chunk) => Buffer.from(chunk))),
      extractor,
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          output += chunk.toString("utf8");
          callback();
        },
      }),
    );
    // COPY escapes (the \t inside the name) pass through untouched.
    expect(output).toBe(
      "photos\tuser-a/cat\\tdog.png\t11111111-1111-1111-1111-111111111111\tuser-a\n",
    );
    expect(extractor.rows).toBe(1);
  });

  it("fills owner_id with null for older storage versions", async () => {
    const extractor = new StorageOwnerRowExtractor();
    let output = "";
    await pipeline(
      Readable.from([
        Buffer.from(
          "COPY storage.objects (bucket_id, name, owner) FROM stdin;\nb\tf.png\t22222222-2222-2222-2222-222222222222\n\\.\n",
        ),
      ]),
      extractor,
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          output += chunk.toString("utf8");
          callback();
        },
      }),
    );
    expect(output).toBe("b\tf.png\t22222222-2222-2222-2222-222222222222\t\\N\n");
  });
});
