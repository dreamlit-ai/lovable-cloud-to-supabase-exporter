// Planning for restoring a Lovable "Export project data" backup (a
// PostgreSQL custom-format archive) into a fresh Supabase project.
//
// The archive holds the whole source database, including Supabase-managed
// schemas the destination already has. Replaying it wholesale would clash
// with those, so the restore is driven by the archive's table of contents:
// app schemas are restored in full, auth data is loaded into the
// destination's existing auth tables, and a few app-created objects inside
// managed schemas (storage policies, triggers on auth.users) are restored
// one by one so a failure there never blocks the rest.

import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { MANAGED_SCHEMA_NAMES } from "./db-schemas.js";

export type ArchiveHeader = {
  format: string | null;
  compression: string | null;
  dumpedFromVersion: string | null;
  dumpedByVersion: string | null;
  tocEntryCount: number | null;
};

export type TocEntry = {
  id: number;
  line: string;
  desc: string;
  schema: string | null;
  // Everything between the schema and the owner, e.g. "todos" for a table or
  // "objects own photos read" for a policy (table name, then policy name).
  name: string;
  owner: string | null;
};

export type ArchiveCompatibility =
  | { ok: true }
  | {
      ok: false;
      reason: "not_custom_format" | "unreadable_header";
      message: string;
    };

// Descriptions pg_restore prints in its TOC list. Longest first so
// "TABLE DATA" wins over "TABLE".
const TOC_DESCS = [
  "MATERIALIZED VIEW DATA",
  "MATERIALIZED VIEW",
  "SEQUENCE OWNED BY",
  "PUBLICATION TABLES IN SCHEMA",
  "PUBLICATION TABLE",
  "TEXT SEARCH CONFIGURATION",
  "TEXT SEARCH DICTIONARY",
  "TEXT SEARCH PARSER",
  "TEXT SEARCH TEMPLATE",
  "CHECK CONSTRAINT",
  "FOREIGN DATA WRAPPER",
  "FOREIGN TABLE",
  "FK CONSTRAINT",
  "EVENT TRIGGER",
  "ROW SECURITY",
  "SEQUENCE SET",
  "DEFAULT ACL",
  "TABLE ATTACH",
  "INDEX ATTACH",
  "USER MAPPING",
  "LARGE OBJECT",
  "BLOB METADATA",
  "BLOBS",
  "BLOB",
  "TABLE DATA",
  "ACCESS METHOD",
  "OPERATOR CLASS",
  "OPERATOR FAMILY",
  "SERVER",
  "STATISTICS",
  "SUBSCRIPTION",
  "PUBLICATION",
  "CONSTRAINT",
  "CONVERSION",
  "COLLATION",
  "AGGREGATE",
  "PROCEDURE",
  "EXTENSION",
  "FUNCTION",
  "OPERATOR",
  "SEQUENCE",
  "TRIGGER",
  "COMMENT",
  "DEFAULT",
  "ENCODING",
  "DATABASE",
  "LANGUAGE",
  "POLICY",
  "SCHEMA",
  "DOMAIN",
  "INDEX",
  "TABLE",
  "TYPE",
  "VIEW",
  "RULE",
  "CAST",
  "ACL",
];

// Object types that never hold data, so skipping one that fails to restore
// cannot break the data load. Mirrors SKIPPABLE_TOC_TYPES in run-clone.sh.
export const SKIPPABLE_TOC_DESCS = new Set([
  "FUNCTION",
  "PROCEDURE",
  "AGGREGATE",
  "TRIGGER",
  "RULE",
  "COMMENT",
  "INDEX",
  "CONSTRAINT",
  "FK CONSTRAINT",
  "CHECK CONSTRAINT",
  "DEFAULT",
  "VIEW",
  "MATERIALIZED VIEW",
  "MATERIALIZED VIEW DATA",
  "EVENT TRIGGER",
  "PUBLICATION",
  "PUBLICATION TABLE",
  "SUBSCRIPTION",
  "ACL",
  "STATISTICS",
  "POLICY",
]);

const DATA_DESCS = new Set(["TABLE DATA", "SEQUENCE SET"]);
const NEVER_RESTORED_DESCS = new Set([
  "ACL",
  "DEFAULT ACL",
  "SCHEMA",
  "EXTENSION",
  "EVENT TRIGGER",
  "DATABASE",
  "ENCODING",
  "PUBLICATION",
  "SUBSCRIPTION",
  "LARGE OBJECT",
  "BLOB",
  "BLOBS",
  "BLOB METADATA",
]);

export const parseArchiveHeader = (listOutput: string): ArchiveHeader => {
  const read = (label: string): string | null => {
    const match = listOutput.match(new RegExp(`^;\\s+${label}:\\s*(.+)$`, "m"));
    return match?.[1]?.trim() ?? null;
  };
  const tocEntries = read("TOC Entries");
  return {
    format: read("Format"),
    compression: read("Compression"),
    dumpedFromVersion: read("Dumped from database version"),
    dumpedByVersion: read("Dumped by pg_dump version"),
    tocEntryCount: tocEntries ? Number.parseInt(tocEntries, 10) : null,
  };
};

export const checkArchiveCompatibility = (header: ArchiveHeader): ArchiveCompatibility => {
  if (!header.format) {
    return {
      ok: false,
      reason: "unreadable_header",
      message: "This file isn't a Lovable database backup we can read.",
    };
  }
  if (header.format !== "CUSTOM") {
    return {
      ok: false,
      reason: "not_custom_format",
      message: `This backup uses the ${header.format} format. Upload the .backup file from Lovable's Export project data.`,
    };
  }
  return { ok: true };
};

export const parseTocLine = (line: string): TocEntry | null => {
  const match = line.match(/^(\d+);\s+\d+\s+\d+\s+(.*)$/);
  if (!match?.[1] || match[2] === undefined) return null;
  const rest = match[2];
  const desc = TOC_DESCS.find(
    (candidate) => rest === candidate || rest.startsWith(`${candidate} `),
  );
  if (!desc) return null;
  // Owner is the last space-separated token; some entries (extensions,
  // comments on extensions) have none and end with a trailing space.
  const afterDesc = rest.slice(desc.length + 1);
  const tokens = afterDesc.split(" ");
  const schemaToken = tokens.shift() ?? "-";
  const owner = tokens.length > 1 ? (tokens.pop() ?? null) : null;
  return {
    id: Number.parseInt(match[1], 10),
    line,
    desc,
    schema: schemaToken === "-" ? null : schemaToken,
    name: tokens.join(" ").trim(),
    owner: owner === "" ? null : owner,
  };
};

export const parseTocList = (listOutput: string): TocEntry[] =>
  listOutput
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith(";"))
    .map(parseTocLine)
    .filter((entry): entry is TocEntry => entry !== null);

const isManagedSchema = (schema: string): boolean =>
  MANAGED_SCHEMA_NAMES.has(schema) || schema.startsWith("pg_");

export type BackupRestorePlan = {
  // Non-managed schemas, created on the destination before anything else.
  appSchemas: string[];
  extensionEntries: TocEntry[];
  schemaEntries: TocEntry[];
  dataEntries: TocEntry[];
  // Restored after data so they read the loaded rows.
  materializedViewRefreshEntries: TocEntry[];
  storagePolicyEntries: TocEntry[];
  // Candidates only: kept when their SQL calls a function in an app schema.
  authTriggerEntries: TocEntry[];
  // Reported, not restored.
  storageObjectsDataEntry: TocEntry | null;
  cronJobDataEntry: TocEntry | null;
  vaultSecretsDataEntry: TocEntry | null;
  skippedDataTables: string[];
};

export const planBackupRestore = (
  entries: TocEntry[],
  options: { excludeDataTables: Iterable<string> },
): BackupRestorePlan => {
  const excluded = new Set(options.excludeDataTables);
  const appSchemas = new Set<string>(["public"]);
  for (const entry of entries) {
    if (entry.desc === "SCHEMA" && !isManagedSchema(entry.name)) appSchemas.add(entry.name);
  }
  const isApp = (entry: TocEntry) => entry.schema !== null && appSchemas.has(entry.schema);
  const tableName = (entry: TocEntry) => `${entry.schema}.${entry.name}`;
  const findData = (schema: string, name: string) =>
    entries.find(
      (entry) => entry.desc === "TABLE DATA" && entry.schema === schema && entry.name === name,
    ) ?? null;

  const plan: BackupRestorePlan = {
    appSchemas: [...appSchemas].sort((left, right) =>
      left === "public" ? -1 : right === "public" ? 1 : left.localeCompare(right),
    ),
    extensionEntries: entries.filter((entry) => entry.desc === "EXTENSION"),
    schemaEntries: [],
    dataEntries: [],
    materializedViewRefreshEntries: [],
    storagePolicyEntries: [],
    authTriggerEntries: [],
    storageObjectsDataEntry: findData("storage", "objects"),
    cronJobDataEntry: findData("cron", "job"),
    vaultSecretsDataEntry: findData("vault", "secrets"),
    skippedDataTables: [],
  };

  for (const entry of entries) {
    if (NEVER_RESTORED_DESCS.has(entry.desc)) continue;

    if (entry.desc === "MATERIALIZED VIEW DATA") {
      if (isApp(entry)) plan.materializedViewRefreshEntries.push(entry);
      continue;
    }

    if (DATA_DESCS.has(entry.desc)) {
      const appData = isApp(entry);
      const authData = entry.schema === "auth" && entry.desc === "TABLE DATA";
      if ((appData || authData) && !excluded.has(tableName(entry))) {
        plan.dataEntries.push(entry);
      } else if ((appData || authData) && entry.desc === "TABLE DATA") {
        plan.skippedDataTables.push(tableName(entry));
      }
      continue;
    }

    if (isApp(entry)) {
      plan.schemaEntries.push(entry);
      continue;
    }

    if (
      entry.desc === "POLICY" &&
      entry.schema === "storage" &&
      (entry.name.startsWith("objects ") || entry.name.startsWith("buckets "))
    ) {
      plan.storagePolicyEntries.push(entry);
      continue;
    }

    if (entry.desc === "TRIGGER" && entry.schema === "auth") {
      plan.authTriggerEntries.push(entry);
    }
  }

  return plan;
};

export const buildRestoreList = (entries: TocEntry[]): string =>
  `${entries.map((entry) => entry.line).join("\n")}\n`;

const quoteIdentifierPattern = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;

// True when a CREATE TRIGGER statement runs a function in one of the app
// schemas, i.e. the app created it (Supabase's own auth schema has none).
export const triggerCallsAppFunction = (triggerSql: string, appSchemas: string[]): boolean => {
  const match = triggerSql.match(
    new RegExp(String.raw`EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(${quoteIdentifierPattern})\.`, "i"),
  );
  if (!match?.[1]) return false;
  const schema = match[1].startsWith('"') ? match[1].slice(1, -1).replaceAll('""', '"') : match[1];
  return appSchemas.includes(schema);
};

export type ExtensionRequirement = { name: string; schema: string };

export const parseExtensionStatements = (sql: string): ExtensionRequirement[] => {
  const pattern = new RegExp(
    String.raw`CREATE EXTENSION IF NOT EXISTS (${quoteIdentifierPattern}) WITH SCHEMA (${quoteIdentifierPattern})`,
    "g",
  );
  const unquote = (value: string) =>
    value.startsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value;
  return [...sql.matchAll(pattern)]
    .filter((match) => match[1] && match[2])
    .map((match) => ({ name: unquote(match[1] as string), schema: unquote(match[2] as string) }))
    .filter((extension) => extension.name !== "plpgsql");
};

const COPY_NAME_PART = String.raw`(?:"(?:[^"]|"")+"|[^\s".]+)`;
const COPY_START_PATTERN = new RegExp(
  String.raw`^COPY (${COPY_NAME_PART}(?:\.${COPY_NAME_PART})?) (?:\(.*\) )?FROM stdin;$`,
);

// Counts rows per table while pg_restore's plain SQL streams through to
// psql. COPY text format keeps each row on one line (embedded newlines are
// escaped), and a line of "\." ends the block.
export class CopyRowCounter extends Transform {
  readonly counts = new Map<string, number>();
  private pending = "";
  private activeTable: string | null = null;
  // Keeps multi-byte characters split across chunks intact.
  private decoder = new StringDecoder("utf8");

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const text = this.pending + this.decoder.write(chunk);
    const lines = text.split("\n");
    this.pending = lines.pop() ?? "";
    for (const line of lines) this.countLine(line);
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    this.pending += this.decoder.end();
    if (this.pending) this.countLine(this.pending);
    this.pending = "";
    callback();
  }

  private countLine(line: string): void {
    if (this.activeTable === null) {
      const match = line.match(COPY_START_PATTERN);
      if (match?.[1]) {
        this.activeTable = normalizeQualifiedName(match[1]);
        this.counts.set(this.activeTable, this.counts.get(this.activeTable) ?? 0);
      }
      return;
    }
    if (line === "\\.") {
      this.activeTable = null;
      return;
    }
    this.counts.set(this.activeTable, (this.counts.get(this.activeTable) ?? 0) + 1);
  }
}

// Columns of a Supabase-managed table (auth.*) in the destination, keyed by
// column name; true marks a generated column the database fills itself.
export type DestinationTableColumns = Map<string, Map<string, boolean>>;

export type ManagedTableAdjustment = {
  table: string;
  rows: number;
  // The destination has no such table, so its rows were left out.
  tableMissing: boolean;
  // Archive columns the destination lacks (or generates itself).
  droppedColumns: string[];
  // Non-empty values in dropped, non-generated columns: data that didn't move.
  lostValues: number;
};

// Auth data the destination's auth version has no place for. Empty leftover
// tables and columns aren't gaps.
export const findManagedDataGaps = (
  adjustments: ManagedTableAdjustment[],
): ManagedTableAdjustment[] =>
  adjustments.filter(
    (adjustment) => (adjustment.tableMissing && adjustment.rows > 0) || adjustment.lostValues > 0,
  );

const COPY_WITH_COLUMNS_PATTERN = new RegExp(
  String.raw`^COPY (${COPY_NAME_PART}(?:\.${COPY_NAME_PART})?) \((.*)\) FROM stdin;$`,
);

const parseColumnList = (list: string): string[] =>
  (list.match(/"(?:[^"]|"")+"|[^,\s]+/g) ?? []).map((column) =>
    column.startsWith('"') ? column.slice(1, -1).replaceAll('""', '"') : column,
  );

// Lovable's Supabase can run a newer auth version than the destination, so
// the archive may hold auth tables or columns the destination doesn't have.
// This rewrites pg_restore's COPY blocks for those managed tables so the load
// succeeds, and records what was left out so callers can tell an empty
// leftover table apart from real data that didn't move.
export class ManagedTableAdapter extends Transform {
  readonly adjustments = new Map<string, ManagedTableAdjustment>();
  private pending = "";
  private decoder = new StringDecoder("utf8");
  private active: {
    adjustment: ManagedTableAdjustment | null;
    keep: boolean[] | null;
    lost: boolean[];
    drop: boolean;
  } | null = null;

  constructor(
    private readonly destination: DestinationTableColumns,
    private readonly managedSchemas: ReadonlySet<string>,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const text = this.pending + this.decoder.write(chunk);
    const lines = text.split("\n");
    this.pending = lines.pop() ?? "";
    const out = lines.map((line) => this.adaptLine(line)).filter((line) => line !== null);
    callback(null, out.length > 0 ? Buffer.from(`${out.join("\n")}\n`) : undefined);
  }

  override _flush(callback: TransformCallback): void {
    this.pending += this.decoder.end();
    const last = this.pending ? this.adaptLine(this.pending) : null;
    this.pending = "";
    callback(null, last === null ? undefined : Buffer.from(last));
  }

  private adaptLine(line: string): string | null {
    const active = this.active;
    if (active === null) return this.startCopy(line);
    if (line === "\\.") {
      this.active = null;
      return active.drop ? null : line;
    }
    if (active.adjustment) active.adjustment.rows += 1;
    if (active.drop) return null;
    if (!active.keep || !active.adjustment) return line;
    const fields = line.split("\t");
    const kept: string[] = [];
    fields.forEach((field, index) => {
      if (active.keep?.[index]) {
        kept.push(field);
      } else if (active.lost[index] && field !== "\\N" && active.adjustment) {
        active.adjustment.lostValues += 1;
      }
    });
    return kept.join("\t");
  }

  private startCopy(line: string): string | null {
    if (!line.startsWith("COPY ")) return line;
    const match = line.match(COPY_WITH_COLUMNS_PATTERN);
    if (!match?.[1] || match[2] === undefined) {
      if (COPY_START_PATTERN.test(line)) {
        this.active = { adjustment: null, keep: null, lost: [], drop: false };
      }
      return line;
    }
    const table = normalizeQualifiedName(match[1]);
    const schema = table.slice(0, table.indexOf("."));
    if (!this.managedSchemas.has(schema)) {
      this.active = { adjustment: null, keep: null, lost: [], drop: false };
      return line;
    }
    const columns = parseColumnList(match[2]);
    const destinationColumns = this.destination.get(table);
    if (!destinationColumns) {
      const adjustment = this.track(table, { tableMissing: true, droppedColumns: [] });
      this.active = { adjustment, keep: null, lost: [], drop: true };
      return null;
    }
    const keep = columns.map((column) => destinationColumns.get(column) === false);
    if (keep.every(Boolean)) {
      this.active = { adjustment: null, keep: null, lost: [], drop: false };
      return line;
    }
    const adjustment = this.track(table, {
      tableMissing: false,
      droppedColumns: columns.filter((_, index) => !keep[index]),
    });
    // Generated columns are recomputed by the destination, so dropping them
    // loses nothing.
    const lost = columns.map((column) => !destinationColumns.has(column));
    this.active = { adjustment, keep, lost, drop: false };
    const keptColumns = columns.filter((_, index) => keep[index]).map(quoteColumn);
    return `COPY ${match[1]} (${keptColumns.join(", ")}) FROM stdin;`;
  }

  private track(
    table: string,
    detail: Pick<ManagedTableAdjustment, "tableMissing" | "droppedColumns">,
  ): ManagedTableAdjustment {
    const adjustment = this.adjustments.get(table) ?? { table, rows: 0, lostValues: 0, ...detail };
    this.adjustments.set(table, adjustment);
    return adjustment;
  }
}

// Turns pg_restore's COPY block for storage.objects into rows of
// "bucket_id, name, owner, owner_id" (still in COPY text format), so file
// owners can be restored after the files are copied. Uploads made with the
// secret key have no owner, which breaks access rules that check it.
export class StorageOwnerRowExtractor extends Transform {
  rows = 0;
  private pending = "";
  private decoder = new StringDecoder("utf8");
  private indexes: number[] | null = null;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const text = this.pending + this.decoder.write(chunk);
    const lines = text.split("\n");
    this.pending = lines.pop() ?? "";
    const out = lines.map((line) => this.extract(line)).filter((line) => line !== null);
    callback(null, out.length > 0 ? Buffer.from(`${out.join("\n")}\n`) : undefined);
  }

  override _flush(callback: TransformCallback): void {
    this.pending += this.decoder.end();
    const last = this.pending ? this.extract(this.pending) : null;
    this.pending = "";
    callback(null, last === null ? undefined : Buffer.from(`${last}\n`));
  }

  private extract(line: string): string | null {
    if (this.indexes === null) {
      const match = line.match(COPY_WITH_COLUMNS_PATTERN);
      if (
        match?.[1] &&
        match[2] !== undefined &&
        normalizeQualifiedName(match[1]) === "storage.objects"
      ) {
        const columns = parseColumnList(match[2]);
        this.indexes = ["bucket_id", "name", "owner", "owner_id"].map((column) =>
          columns.indexOf(column),
        );
      }
      return null;
    }
    if (line === "\\.") {
      this.indexes = null;
      return null;
    }
    const fields = line.split("\t");
    const [bucket, name, owner, ownerId] = this.indexes.map((index) =>
      index >= 0 ? (fields[index] ?? "\\N") : "\\N",
    );
    if (owner === "\\N" && ownerId === "\\N") return null;
    this.rows += 1;
    return [bucket, name, owner, ownerId].join("\t");
  }
}

const quoteColumn = (column: string): string =>
  /^[a-z_][a-z0-9_]*$/.test(column) ? column : `"${column.replaceAll('"', '""')}"`;

// "public"."My Table" -> public.My Table, matching the TOC's naming.
export const normalizeQualifiedName = (name: string): string => {
  const parts = name.match(/"(?:[^"]|"")+"|[^.]+/g) ?? [name];
  return parts
    .map((part) => (part.startsWith('"') ? part.slice(1, -1).replaceAll('""', '"') : part))
    .join(".");
};

export type ZipDetection = "zip" | "archive" | "unknown";

// Lovable sometimes wraps the backup in a ZIP. Custom-format archives start
// with "PGDMP"; ZIP files with "PK\x03\x04".
export const detectBackupContainer = (firstBytes: Uint8Array): ZipDetection => {
  const text = String.fromCharCode(...firstBytes.slice(0, 5));
  if (text === "PGDMP") return "archive";
  if (
    firstBytes[0] === 0x50 &&
    firstBytes[1] === 0x4b &&
    firstBytes[2] === 0x03 &&
    firstBytes[3] === 0x04
  ) {
    return "zip";
  }
  return "unknown";
};
