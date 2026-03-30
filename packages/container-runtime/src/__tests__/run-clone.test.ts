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
needs_stdin=1
prev=""
for arg in "$@"; do
  if [ "$prev" = "-f" ]; then
    file="$arg"
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
  cat "$file" >/dev/null
  exit 0
fi

if [ "$needs_stdin" -eq 0 ]; then
  exit 0
fi

stdin_contents="$(cat)"
printf '%s' "$stdin_contents" >"$TEST_PSQL_STDIN"
import_path="$(printf '%s\\n' "$stdin_contents" | sed -n 's/^\\\\i //p' | head -n 1)"
if [ -n "$import_path" ]; then
  cat "$import_path" >"$TEST_DATA_CAPTURE"
fi
`,
  );

  writeExecutable(
    path.join(binDir, "pg_dump"),
    `#!/bin/sh
set -eu
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
  printf 'CREATE SCHEMA public;\\nCREATE TABLE public.demo(id int);\\n' >"$file"
  exit 0
fi

if [ -p "$file" ]; then
  printf 'INSERT INTO public.demo VALUES (1);\\n' >"$file"
  exit 0
fi

printf 'pg_dump: error: could not write to file: No space left on device\\n' >&2
exit 1
`,
  );
};

const runCloneScenario = (scriptUnderTest: string, tempDir: string) => {
  const binDir = path.join(tempDir, "bin");
  const logsDir = path.join(tempDir, "logs");
  const capturePath = path.join(logsDir, "data.sql");
  const stdinPath = path.join(logsDir, "stdin.txt");
  const psqlLogPath = path.join(logsDir, "psql.log");

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
      TEST_PSQL_LOG: psqlLogPath,
      TEST_PSQL_STDIN: stdinPath,
    },
    encoding: "utf8",
  });

  return {
    result,
    capturePath,
    stdinPath,
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
  });
});
