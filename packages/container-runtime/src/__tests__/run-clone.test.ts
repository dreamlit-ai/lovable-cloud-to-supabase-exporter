import { mkdtempSync, chmodSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const scriptPath = path.join(packageRoot, "run-clone.sh");

const tempDirs: string[] = [];

const writeExecutable = (filePath: string, contents: string) => {
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
};

const legacyCloneScript = `#!/bin/sh
set -eu

WORK_DIR="/tmp/pg-clone"
SCHEMA_SQL="$WORK_DIR/clone-schema.sql"
SCHEMA_SQL_FILTERED="$WORK_DIR/clone-schema.filtered.sql"
DATA_SQL="$WORK_DIR/clone-data.sql"

require_env() {
  key="$1"
  value="$(printenv "$key" || true)"
  if [ -z "$value" ]; then
    exit 1
  fi
}

require_env "SOURCE_DB_URL"
require_env "TARGET_DB_URL"

mkdir -p "$WORK_DIR"

echo "[clone] dump schema"
pg_dump "$SOURCE_DB_URL" --format=plain --schema-only --schema=public --no-owner --no-acl --file="$SCHEMA_SQL"
sed -e '/^CREATE SCHEMA public;$/d' -e '/^COMMENT ON SCHEMA public IS /d' "$SCHEMA_SQL" > "$SCHEMA_SQL_FILTERED"

echo "[clone] dump data"
if ! pg_dump "$SOURCE_DB_URL" --format=plain --data-only --schema=public --schema=auth --no-owner --no-acl --file="$DATA_SQL"; then
  echo "[clone] data dump failed." >&2
  exit 42
fi

echo "[clone] restore schema"
psql "$TARGET_DB_URL" --single-transaction -v ON_ERROR_STOP=1 -f "$SCHEMA_SQL_FILTERED"
psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -c "BEGIN; SET session_replication_role=replica; SHOW session_replication_role; ROLLBACK;" 1>/dev/null

echo "[clone] restore data"
if ! psql "$TARGET_DB_URL" --single-transaction -v ON_ERROR_STOP=1 <<EOF; then
SET session_replication_role=replica;
\\i $DATA_SQL
EOF
  echo "[clone] data restore failed." >&2
  exit 44
fi

echo "[clone] completed"
`;

const installFakePostgresTools = (binDir: string) => {
  writeExecutable(
    path.join(binDir, "psql"),
    `#!/bin/sh
set -eu
mkdir -p "$(dirname "$TEST_PSQL_LOG")"
printf '%s\\n' "$*" >>"$TEST_PSQL_LOG"
file=""
sql=""
needs_stdin=1
prev=""
psql_url="\${1:-}"
for arg in "$@"; do
  if [ "$prev" = "-f" ]; then
    file="$arg"
  fi
  if [ "$prev" = "-c" ]; then
    sql="$arg"
  fi
  case "$arg" in
    -c)
      needs_stdin=0
      ;;
    --file=*)
      file="\${arg#--file=}"
      ;;
  esac
  prev="$arg"
done

if [ -n "$file" ]; then
  if [ -n "\${TEST_SCHEMA_RESTORE_CAPTURE:-}" ]; then
    cp "$file" "$TEST_SCHEMA_RESTORE_CAPTURE"
  fi
  cat "$file" >/dev/null
  if [ "\${TEST_FAIL_SCHEMA_RESTORE:-0}" = "1" ]; then
    echo 'psql:/tmp/pg-clone/clone-schema.filtered.sql:2: ERROR: type "vector" does not exist' >&2
    exit 1
  fi
  exit 0
fi

if [ "$needs_stdin" -eq 0 ]; then
  case "$sql" in
    *"lovable_exporter_app_schemas"*)
      printf '%s\\n' "\${TEST_SOURCE_APP_SCHEMAS:-public}" | sed '/^$/d'
      exit 0
      ;;
    *"WHERE e.extname <> 'plpgsql'"*)
      case "$psql_url" in
        *source.example*)
          printf '%s\\n' "\${TEST_SOURCE_EXTENSIONS:-}" | sed '/^$/d'
          ;;
        *target.example*)
          printf '%s\\n' "\${TEST_TARGET_EXTENSIONS:-}" | sed '/^$/d'
          ;;
      esac
      exit 0
      ;;
    *"WHERE e.extname = '"*)
      extension_name="$(printf '%s\\n' "$sql" | sed -n "s/.*WHERE e.extname = '\\([^']*\\)'.*/\\1/p" | head -n 1)"
      {
        printf '%s\\n' "\${TEST_TARGET_EXTENSIONS:-}"
        if [ -f "\${TEST_CREATED_EXTENSIONS_FILE:-/dev/null}" ]; then
          cat "$TEST_CREATED_EXTENSIONS_FILE"
        fi
      } | awk -F'|' -v ext="$extension_name" '$1 == ext { print $2; exit }'
      exit 0
      ;;
    *"CREATE SCHEMA IF NOT EXISTS"*"CREATE EXTENSION IF NOT EXISTS"*)
      if [ "\${TEST_FAIL_EXTENSION_CREATE:-0}" = "1" ]; then
        echo 'ERROR: could not create extension' >&2
        exit 1
      fi
      extension_name="$(printf '%s\\n' "$sql" | sed -n 's/.*CREATE EXTENSION IF NOT EXISTS "\\([^"]*\\)".*/\\1/p' | head -n 1)"
      extension_schema="$(printf '%s\\n' "$sql" | sed -n 's/.*WITH SCHEMA "\\([^"]*\\)".*/\\1/p' | head -n 1)"
      if [ -n "$extension_name" ] && [ -n "$extension_schema" ] && [ -n "\${TEST_CREATED_EXTENSIONS_FILE:-}" ]; then
        printf '%s|%s\\n' "$extension_name" "$extension_schema" >>"$TEST_CREATED_EXTENSIONS_FILE"
      fi
      exit 0
      ;;
    *"n.nspname = 'pgmq'"*"relname LIKE"*)
      case "$psql_url" in
        *source.example*)
          printf '%s\\n' "\${TEST_SOURCE_PGMQ_QUEUES:-}" | sed '/^$/d'
          ;;
        *target.example*)
          printf '%s\\n' "\${TEST_TARGET_PGMQ_QUEUES:-}" | sed '/^$/d'
          ;;
      esac
      exit 0
      ;;
    *"n.nspname = 'pgmq'"*"c.relname = '"*)
      queue_relation="$(printf '%s\\n' "$sql" | sed -n "s/.*c.relname = '\\([^']*\\)'.*/\\1/p" | head -n 1)"
      printf '%s\\n' "\${TEST_TARGET_PGMQ_QUEUES:-}" | awk -v rel="$queue_relation" '$0 == rel { print 1; exit }'
      exit 0
      ;;
  esac
  exit 0
fi

stdin_contents="$(cat)"
printf '%s' "$stdin_contents" >"$TEST_PSQL_STDIN"
import_path="$(printf '%s\\n' "$stdin_contents" | sed -n 's/^\\\\i //p' | head -n 1)"
if [ -n "$import_path" ]; then
  imported_contents="$(cat "$import_path")"
  printf '%s' "$imported_contents" >"$TEST_DATA_CAPTURE"
  if [ "\${TEST_PSQL_FAIL_ON_PARTIAL:-0}" = "1" ]; then
    case "$imported_contents" in
      *';')
        ;;
      *)
        echo 'psql: error: input ended unexpectedly' >&2
        exit 1
        ;;
    esac
  fi
fi
`,
  );

  writeExecutable(
    path.join(binDir, "pg_dump"),
    `#!/bin/sh
set -eu
mkdir -p "$(dirname "$TEST_PGDUMP_LOG")"
printf '%s\\n' "$*" >>"$TEST_PGDUMP_LOG"
file=""
schema_only=0
for arg in "$@"; do
  case "$arg" in
    --file=*)
      file="\${arg#--file=}"
      ;;
    --schema-only)
      schema_only=1
      ;;
  esac
done

if [ "$schema_only" -eq 1 ]; then
  printf '%s\\n' "\${TEST_PGDUMP_SCHEMA_SQL:-CREATE SCHEMA public;
CREATE TABLE public.demo(id int);}" >"$file"
  exit 0
fi

if [ -p "$file" ]; then
  if [ "\${TEST_PGDUMP_MODE:-success}" = "partial_failure" ]; then
    printf 'INSERT INTO public.demo VALUES (1)' >"$file"
    echo 'pg_dump: error: lost source connection during data dump' >&2
    exit 1
  fi
  printf 'INSERT INTO public.demo VALUES (1);\\n' >"$file"
  exit 0
fi

printf 'pg_dump: error: could not write to file: No space left on device\\n' >&2
exit 1
`,
  );
};

const runCloneScenario = (
  scriptUnderTest: string,
  tempDir: string,
  extraEnv: Record<string, string> = {},
) => {
  const binDir = path.join(tempDir, "bin");
  const logsDir = path.join(tempDir, "logs");
  const capturePath = path.join(logsDir, "data.sql");
  const stdinPath = path.join(logsDir, "stdin.txt");
  const psqlLogPath = path.join(logsDir, "psql.log");
  const pgDumpLogPath = path.join(logsDir, "pg-dump.log");
  const schemaRestoreCapturePath = path.join(logsDir, "schema-restore.sql");
  const createdExtensionsPath = path.join(logsDir, "created-extensions.txt");

  mkdirSync(binDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  installFakePostgresTools(binDir);

  const result = spawnSync("sh", [scriptUnderTest], {
    cwd: tempDir,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      SOURCE_DB_URL: "postgresql://source.example/db",
      TARGET_DB_URL: "postgresql://target.example/db",
      TEST_DATA_CAPTURE: capturePath,
      TEST_PGDUMP_MODE: "success",
      TEST_PSQL_LOG: psqlLogPath,
      TEST_PGDUMP_LOG: pgDumpLogPath,
      TEST_SCHEMA_RESTORE_CAPTURE: schemaRestoreCapturePath,
      TEST_PSQL_FAIL_ON_PARTIAL: "0",
      TEST_PSQL_STDIN: stdinPath,
      TEST_CREATED_EXTENSIONS_FILE: createdExtensionsPath,
      ...extraEnv,
    },
    encoding: "utf8",
  });

  return {
    result,
    capturePath,
    stdinPath,
    psqlLogPath,
    pgDumpLogPath,
    schemaRestoreCapturePath,
    createdExtensionsPath,
  };
};

describe("run-clone.sh", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reproduces the legacy disk-space failure and passes with the current script", () => {
    const legacyTempDir = mkdtempSync(path.join(tmpdir(), "run-clone-legacy-"));
    tempDirs.push(legacyTempDir);

    const legacyScriptPath = path.join(legacyTempDir, "legacy-run-clone.sh");
    writeExecutable(legacyScriptPath, legacyCloneScript);

    const legacyRun = runCloneScenario(legacyScriptPath, legacyTempDir);
    expect(legacyRun.result.status).toBe(42);
    expect(legacyRun.result.stderr).toContain("No space left on device");
    expect(legacyRun.result.stderr).toContain("[clone] data dump failed.");

    const fixedTempDir = mkdtempSync(path.join(tmpdir(), "run-clone-fixed-"));
    tempDirs.push(fixedTempDir);

    const fixedRun = runCloneScenario(scriptPath, fixedTempDir);
    expect(fixedRun.result.status).toBe(0);
    expect(fixedRun.result.stderr).not.toContain("No space left on device");
    expect(fixedRun.result.stderr).toContain("[clone][diag] stage=clone.start");
    expect(fixedRun.result.stderr).toContain("[clone][diag] stage=dump_data.done");
    expect(fixedRun.result.stderr).not.toContain("postgresql://");
    expect(readFileSync(fixedRun.stdinPath, "utf8")).toContain("\\i /tmp/pg-clone/clone-data.pipe");
    expect(readFileSync(fixedRun.capturePath, "utf8")).toContain(
      "INSERT INTO public.demo VALUES (1);",
    );
  }, 10_000);

  it("reports data dump failures before restore failures when the FIFO stream is truncated", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "run-clone-partial-"));
    tempDirs.push(tempDir);

    const partialRun = runCloneScenario(scriptPath, tempDir, {
      TEST_PGDUMP_MODE: "partial_failure",
      TEST_PSQL_FAIL_ON_PARTIAL: "1",
    });

    expect(partialRun.result.status).toBe(42);
    expect(partialRun.result.stderr).toContain("lost source connection during data dump");
    expect(partialRun.result.stderr).toContain("[clone] data dump failed.");
    expect(partialRun.result.stderr).not.toContain("[clone] data restore failed.");
  }, 10_000);

  it("includes discovered custom app schemas in schema and data dump args", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "run-clone-custom-schema-"));
    tempDirs.push(tempDir);

    const run = runCloneScenario(scriptPath, tempDir, {
      TEST_SOURCE_APP_SCHEMAS: "public\nprivate",
    });

    expect(run.result.status).toBe(0);
    expect(run.result.stdout).toContain("[clone] source app schemas detected (2): public, private");

    const pgDumpLines = readFileSync(run.pgDumpLogPath, "utf8").trim().split("\n");
    const schemaDump = pgDumpLines.find((line) => line.includes("--schema-only")) ?? "";
    const dataDump = pgDumpLines.find((line) => line.includes("--data-only")) ?? "";

    expect(schemaDump).toContain('--schema="public"');
    expect(schemaDump).toContain('--schema="private"');
    expect(schemaDump).not.toContain('--schema="auth"');
    expect(dataDump).toContain('--schema="public"');
    expect(dataDump).toContain('--schema="private"');
    expect(dataDump).toContain('--schema="auth"');
  }, 10_000);

  it("does not include Supabase-managed schemas from source schema discovery", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "run-clone-managed-schema-"));
    tempDirs.push(tempDir);

    const run = runCloneScenario(scriptPath, tempDir, {
      TEST_SOURCE_APP_SCHEMAS: [
        "public",
        "private",
        "storage",
        "extensions",
        "pg_catalog",
        "cron",
        "_realtime",
      ].join("\n"),
    });

    expect(run.result.status).toBe(0);
    expect(run.result.stdout).toContain("[clone] source app schemas detected (2): public, private");

    const pgDumpLog = readFileSync(run.pgDumpLogPath, "utf8");
    expect(pgDumpLog).toContain('--schema="private"');
    expect(pgDumpLog).not.toContain('--schema="storage"');
    expect(pgDumpLog).not.toContain('--schema="extensions"');
    expect(pgDumpLog).not.toContain('--schema="pg_catalog"');
    expect(pgDumpLog).not.toContain('--schema="cron"');
    expect(pgDumpLog).not.toContain('--schema="_realtime"');
  }, 10_000);

  it("pre-creates custom app schemas and filters their schema boilerplate before restore", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "run-clone-extension-custom-schema-"));
    tempDirs.push(tempDir);

    const run = runCloneScenario(scriptPath, tempDir, {
      TEST_SOURCE_APP_SCHEMAS: "public\nprivate",
      TEST_SOURCE_EXTENSIONS: "hstore|private",
      TEST_PGDUMP_SCHEMA_SQL: [
        "CREATE SCHEMA public;",
        "CREATE SCHEMA private;",
        "COMMENT ON SCHEMA private IS 'app schema';",
        "CREATE TABLE private.demo(id int);",
      ].join("\n"),
    });

    expect(run.result.status).toBe(0);
    const psqlLog = readFileSync(run.psqlLogPath, "utf8");
    expect(psqlLog).toContain('CREATE SCHEMA IF NOT EXISTS "private";');
    expect(psqlLog).toContain('CREATE EXTENSION IF NOT EXISTS "hstore" WITH SCHEMA "private"');

    const restoredSchemaSql = readFileSync(run.schemaRestoreCapturePath, "utf8");
    expect(restoredSchemaSql).not.toContain("CREATE SCHEMA private;");
    expect(restoredSchemaSql).toContain("COMMENT ON SCHEMA private IS 'app schema';");
    expect(restoredSchemaSql).toContain("CREATE TABLE private.demo(id int);");
  }, 10_000);

  it("keeps multiline custom schema comments intact while filtering schema creation", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "run-clone-multiline-schema-comment-"));
    tempDirs.push(tempDir);

    const run = runCloneScenario(scriptPath, tempDir, {
      TEST_SOURCE_APP_SCHEMAS: "public\nprivate",
      TEST_PGDUMP_SCHEMA_SQL: [
        "CREATE SCHEMA private;",
        "COMMENT ON SCHEMA private IS 'first",
        "second';",
        "CREATE TABLE private.demo(id int);",
      ].join("\n"),
    });

    expect(run.result.status).toBe(0);

    const restoredSchemaSql = readFileSync(run.schemaRestoreCapturePath, "utf8");
    expect(restoredSchemaSql).not.toContain("CREATE SCHEMA private;");
    expect(restoredSchemaSql).toContain("COMMENT ON SCHEMA private IS 'first\nsecond';");
    expect(restoredSchemaSql).toContain("CREATE TABLE private.demo(id int);");
  }, 10_000);

  it("creates every source-enabled extension in the source schema before restoring schema", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "run-clone-extensions-"));
    tempDirs.push(tempDir);

    const run = runCloneScenario(scriptPath, tempDir, {
      TEST_SOURCE_EXTENSIONS: ["hstore|public", "pg_trgm|public", "postgis|public"].join("\n"),
    });

    expect(run.result.status).toBe(0);
    const psqlLog = readFileSync(run.psqlLogPath, "utf8");
    expect(psqlLog).toContain('CREATE EXTENSION IF NOT EXISTS "hstore" WITH SCHEMA "public"');
    expect(psqlLog).toContain('CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public"');
    expect(psqlLog).toContain('CREATE EXTENSION IF NOT EXISTS "postgis" WITH SCHEMA "public"');
    expect(readFileSync(run.createdExtensionsPath, "utf8")).toContain("hstore|public");
    expect(readFileSync(run.createdExtensionsPath, "utf8")).toContain("pg_trgm|public");
    expect(readFileSync(run.createdExtensionsPath, "utf8")).toContain("postgis|public");
  }, 10_000);

  it("continues when a source-enabled extension cannot be created on target", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "run-clone-missing-extension-"));
    tempDirs.push(tempDir);

    const run = runCloneScenario(scriptPath, tempDir, {
      TEST_FAIL_EXTENSION_CREATE: "1",
      TEST_SOURCE_EXTENSIONS: "hstore|public",
    });

    expect(run.result.status).toBe(0);
    expect(run.result.stderr).toContain("target extension setup incomplete; continuing migration");
    expect(run.result.stderr).toContain("extension hstore in schema public");
    expect(readFileSync(run.psqlLogPath, "utf8")).toContain(
      'CREATE EXTENSION IF NOT EXISTS "hstore" WITH SCHEMA "public"',
    );
    expect(run.result.stdout).toContain("[clone] dump schema");
  }, 10_000);

  it("continues when a source-enabled extension is installed in the wrong schema", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "run-clone-extension-schema-"));
    tempDirs.push(tempDir);

    const run = runCloneScenario(scriptPath, tempDir, {
      TEST_SOURCE_EXTENSIONS: "unaccent|public",
      TEST_TARGET_EXTENSIONS: "unaccent|extensions",
    });

    expect(run.result.status).toBe(0);
    expect(run.result.stderr).toContain("target extension setup incomplete; continuing migration");
    expect(run.result.stderr).toContain(
      "extension unaccent in schema public (currently installed in schema extensions)",
    );
    expect(readFileSync(run.psqlLogPath, "utf8")).not.toContain(
      'CREATE EXTENSION IF NOT EXISTS "unaccent" WITH SCHEMA "public"',
    );
    expect(run.result.stdout).toContain("[clone] dump schema");
  }, 10_000);

  it("continues when source pgmq queues are missing from target", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "run-clone-missing-pgmq-queue-"));
    tempDirs.push(tempDir);

    const run = runCloneScenario(scriptPath, tempDir, {
      TEST_SOURCE_EXTENSIONS: "pgmq|pgmq",
      TEST_TARGET_EXTENSIONS: "pgmq|pgmq",
      TEST_SOURCE_PGMQ_QUEUES: "q_webhook_jobs",
    });

    expect(run.result.status).toBe(0);
    expect(run.result.stderr).toContain("Supabase Queue webhook_jobs");
    expect(run.result.stderr).toContain("pgmq.q_webhook_jobs");
    expect(run.result.stdout).toContain("[clone] dump schema");
  }, 10_000);

  it("reports restore failures after non-blocking extension warnings", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "run-clone-warning-then-restore-failure-"));
    tempDirs.push(tempDir);

    const run = runCloneScenario(scriptPath, tempDir, {
      TEST_FAIL_EXTENSION_CREATE: "1",
      TEST_FAIL_SCHEMA_RESTORE: "1",
      TEST_SOURCE_EXTENSIONS: "vector|extensions",
    });

    expect(run.result.status).toBe(43);
    expect(run.result.stderr).toContain("target extension setup incomplete; continuing migration");
    expect(run.result.stderr).toContain("extension vector in schema extensions");
    expect(run.result.stderr).toContain('ERROR: type "vector" does not exist');
    expect(run.result.stderr).toContain("[clone] schema restore failed.");
  }, 10_000);
});
