import { spawn } from "node:child_process";
import {
  createSourceStorageObjectEnumerator,
  type SourceStorageObjectEnumerator,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core/source-storage-discovery";

const STORAGE_OBJECT_QUERY_BATCH_SIZE = 2000;

type SourceStorageObjectRow = {
  object_path: unknown;
  metadata?: unknown;
};

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const quoteSqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const parseSourceStorageObjectRows = (
  raw: string,
): Array<{ objectPath: string; metadata: Record<string, unknown> | null }> =>
  raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SourceStorageObjectRow)
    .map((row) => {
      const objectPath = asNonEmptyString(row.object_path);
      if (!objectPath) {
        throw new Error("Source storage object query returned a row without object_path.");
      }
      return {
        objectPath,
        metadata:
          row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
            ? (row.metadata as Record<string, unknown>)
            : null,
      };
    });

const runPsqlQueryCapture = async (sourceDbUrl: string, sql: string): Promise<string> =>
  await new Promise<string>((resolve, reject) => {
    const child = spawn(
      "psql",
      [sourceDbUrl, "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-Atqc", sql],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PGCONNECT_TIMEOUT: "10",
        },
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            "psql is required for source storage discovery but was not found in PATH. Install PostgreSQL client tools and retry.",
          ),
        );
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error((stderr || stdout || `psql exited with code ${code ?? 1}`).trim()));
    });
  });

const countSourceStorageObjectsFromDb = async (sourceDbUrl: string): Promise<number> => {
  const raw = await runPsqlQueryCapture(
    sourceDbUrl,
    "SELECT COUNT(*)::bigint FROM storage.objects;",
  );
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("Source storage object count query returned an invalid result.");
  }
  return parsed;
};

const listSourceStorageObjectsFromDb = async (
  sourceDbUrl: string,
  bucketId: string,
  lastObjectPath: string | null,
  limit = STORAGE_OBJECT_QUERY_BATCH_SIZE,
): Promise<Array<{ objectPath: string; metadata: Record<string, unknown> | null }>> => {
  const afterClause = lastObjectPath ? `AND name > ${quoteSqlLiteral(lastObjectPath)}` : "";
  const sql = `SELECT json_build_object('object_path', name, 'metadata', metadata)::text
FROM storage.objects
WHERE bucket_id = ${quoteSqlLiteral(bucketId)}
  ${afterClause}
ORDER BY name
LIMIT ${Math.max(1, Math.trunc(limit))};`;

  const raw = await runPsqlQueryCapture(sourceDbUrl, sql);
  return raw.trim() ? parseSourceStorageObjectRows(raw) : [];
};

export const resolveSourceDbObjectEnumerator = async (
  sourceDbUrl: string,
): Promise<SourceStorageObjectEnumerator> =>
  await createSourceStorageObjectEnumerator({
    countObjects: async () => countSourceStorageObjectsFromDb(sourceDbUrl),
    listObjects: async (bucketId, lastObjectPath, limit) =>
      listSourceStorageObjectsFromDb(sourceDbUrl, bucketId, lastObjectPath, limit),
    pageSize: STORAGE_OBJECT_QUERY_BATCH_SIZE,
  });
