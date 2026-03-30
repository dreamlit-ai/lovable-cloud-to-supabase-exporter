#!/bin/sh
set -eu

APP_SCHEMA="public"
DATA_SCHEMAS="public,auth"
EXCLUDED_TABLES="auth.schema_migrations,storage.migrations,supabase_functions.migrations,auth.sessions,auth.refresh_tokens,auth.flow_state,auth.one_time_tokens,auth.audit_log_entries"

WORK_DIR="/tmp/pg-clone"
SCHEMA_SQL="$WORK_DIR/clone-schema.sql"
SCHEMA_SQL_FILTERED="$WORK_DIR/clone-schema.filtered.sql"
DATA_PIPE="$WORK_DIR/clone-data.pipe"
LOG_VERBOSITY="${LOG_VERBOSITY:-normal}"

require_env() {
  key="$1"
  eval "value=\${$key:-}"
  if [ -z "$value" ]; then
    echo "[clone] missing required env: $key" >&2
    exit 1
  fi
}

print_table_list_and_exit() {
  label="$1"
  list="$2"
  exit_code="$3"

  echo "[clone] $label" >&2
  printf "%s\n" "$list" | while IFS= read -r table; do
    if [ -n "$table" ]; then
      echo "[clone]   - $table" >&2
    fi
  done
  exit "$exit_code"
}

psql_query() {
  psql_url="$1"
  psql_sql="$2"
  psql "$psql_url" -Atq -v ON_ERROR_STOP=1 -c "$psql_sql"
}

trim_csv_item() {
  printf "%s" "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

now_epoch_s() {
  date +%s
}

elapsed_ms() {
  started_at="$1"
  printf "%s" $((($(now_epoch_s) - started_at) * 1000))
}

tmp_free_kb() {
  value=$(df -Pk /tmp 2>/dev/null | awk 'NR==2 {print $4}' || true)
  if [ -n "$value" ]; then
    printf "%s" "$value"
    return
  fi

  printf "unknown"
}

work_dir_kb() {
  if [ ! -d "$WORK_DIR" ]; then
    printf "0"
    return
  fi

  value=$(du -sk "$WORK_DIR" 2>/dev/null | awk '{print $1}' || true)
  if [ -n "$value" ]; then
    printf "%s" "$value"
    return
  fi

  printf "unknown"
}

file_bytes() {
  file_path="$1"
  if [ ! -f "$file_path" ]; then
    printf "missing"
    return
  fi

  wc -c < "$file_path" | tr -d '[:space:]'
}

path_kind() {
  path_value="$1"

  if [ -p "$path_value" ]; then
    printf "fifo"
    return
  fi

  if [ -f "$path_value" ]; then
    printf "file"
    return
  fi

  if [ -e "$path_value" ]; then
    printf "other"
    return
  fi

  printf "missing"
}

log_diag() {
  echo "[clone][diag] $*" >&2
}

log_resource_snapshot() {
  stage="$1"
  log_diag "stage=$stage tmp_free_kb=$(tmp_free_kb) work_dir_kb=$(work_dir_kb)"

  if [ "$LOG_VERBOSITY" = "debug" ]; then
    log_diag \
      "stage=$stage schema_bytes=$(file_bytes "$SCHEMA_SQL") schema_filtered_bytes=$(file_bytes "$SCHEMA_SQL_FILTERED") data_pipe_kind=$(path_kind "$DATA_PIPE")"
  fi
}

log_stage_result() {
  stage="$1"
  started_at="$2"
  log_diag \
    "stage=$stage elapsed_ms=$(elapsed_ms "$started_at") tmp_free_kb=$(tmp_free_kb) work_dir_kb=$(work_dir_kb)"

  if [ "$LOG_VERBOSITY" = "debug" ]; then
    log_diag \
      "stage=$stage schema_bytes=$(file_bytes "$SCHEMA_SQL") schema_filtered_bytes=$(file_bytes "$SCHEMA_SQL_FILTERED") data_pipe_kind=$(path_kind "$DATA_PIPE")"
  fi
}

build_data_dump_filters() {
  old_ifs="$IFS"
  IFS=","

  for raw_schema in $DATA_SCHEMAS; do
    schema="$(trim_csv_item "$raw_schema")"
    if [ -n "$schema" ]; then
      set -- "$@" "--schema=$schema"
    fi
  done

  for raw_table in $EXCLUDED_TABLES; do
    table="$(trim_csv_item "$raw_table")"
    if [ -n "$table" ]; then
      set -- "$@" "--exclude-table=$table"
    fi
  done

  IFS="$old_ifs"
  printf "%s\n" "$@"
}

list_tables_missing_privilege() {
  lt_url="$1"
  lt_privilege="$2"

  case "$lt_privilege" in
    SELECT|INSERT)
      ;;
    *)
      echo "[clone] unsupported privilege check: $lt_privilege" >&2
      exit 1
      ;;
  esac

  psql_query "$lt_url" "
    WITH schemas AS (
      SELECT trim(x) AS name
      FROM unnest(string_to_array('$DATA_SCHEMAS', ',')) AS x
      WHERE trim(x) <> ''
    ),
    excludes AS (
      SELECT trim(x) AS name
      FROM unnest(string_to_array('$EXCLUDED_TABLES', ',')) AS x
      WHERE trim(x) <> ''
    )
    SELECT t.table_schema || '.' || t.table_name
    FROM information_schema.tables t
    JOIN schemas s ON s.name = t.table_schema
    LEFT JOIN excludes e ON e.name = (t.table_schema || '.' || t.table_name)
    WHERE t.table_type = 'BASE TABLE'
      AND e.name IS NULL
      AND NOT has_table_privilege(current_user, format('%I.%I', t.table_schema, t.table_name), '$lt_privilege')
    ORDER BY 1;
  "
}

require_env "SOURCE_DB_URL"
require_env "TARGET_DB_URL"

export PGSSLMODE=require

mkdir -p "$WORK_DIR"
log_resource_snapshot "clone.start"

set -- $(build_data_dump_filters)

SOURCE_NONSELECT_TABLES=$(list_tables_missing_privilege "$SOURCE_DB_URL" "SELECT")
if [ -n "$SOURCE_NONSELECT_TABLES" ]; then
  print_table_list_and_exit "source is missing SELECT on required tables:" "$SOURCE_NONSELECT_TABLES" 42
fi

TARGET_NONINSERT_TABLES=$(list_tables_missing_privilege "$TARGET_DB_URL" "INSERT")
if [ -n "$TARGET_NONINSERT_TABLES" ]; then
  print_table_list_and_exit "target is missing INSERT on required tables:" "$TARGET_NONINSERT_TABLES" 44
fi

echo "[clone] dump schema"
DUMP_SCHEMA_STARTED_AT=$(now_epoch_s)
log_resource_snapshot "dump_schema.start"
if ! pg_dump "$SOURCE_DB_URL" \
  --format=plain \
  --schema-only \
  --schema="$APP_SCHEMA" \
  --no-owner \
  --no-acl \
  --file="$SCHEMA_SQL"; then
  log_stage_result "dump_schema.failed" "$DUMP_SCHEMA_STARTED_AT"
  echo "[clone] schema dump failed." >&2
  exit 41
fi

if ! sed \
  -e '/^CREATE SCHEMA public;$/d' \
  -e '/^COMMENT ON SCHEMA public IS /d' \
  "$SCHEMA_SQL" > "$SCHEMA_SQL_FILTERED"; then
  log_stage_result "dump_schema.failed" "$DUMP_SCHEMA_STARTED_AT"
  echo "[clone] failed to build filtered schema SQL." >&2
  exit 41
fi
log_stage_result "dump_schema.done" "$DUMP_SCHEMA_STARTED_AT"

echo "[clone] restore schema"
RESTORE_SCHEMA_STARTED_AT=$(now_epoch_s)
log_resource_snapshot "restore_schema.start"
if ! psql "$TARGET_DB_URL" \
  --single-transaction \
  -v ON_ERROR_STOP=1 \
  -f "$SCHEMA_SQL_FILTERED"; then
  log_stage_result "restore_schema.failed" "$RESTORE_SCHEMA_STARTED_AT"
  echo "[clone] schema restore failed." >&2
  exit 43
fi
log_stage_result "restore_schema.done" "$RESTORE_SCHEMA_STARTED_AT"

if ! psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -c "BEGIN; SET session_replication_role=replica; SHOW session_replication_role; ROLLBACK;" 1>/dev/null; then
  log_resource_snapshot "restore_schema.replica_check_failed"
  echo "[clone] target role cannot set session_replication_role=replica." >&2
  exit 46
fi

rm -f "$DATA_PIPE"
if ! mkfifo "$DATA_PIPE"; then
  log_resource_snapshot "dump_data.pipe_create_failed"
  echo "[clone] failed to create data pipe." >&2
  exit 42
fi
log_resource_snapshot "dump_data.pipe_ready"

cleanup_data_pipe() {
  rm -f "$DATA_PIPE"
}

trap cleanup_data_pipe EXIT HUP INT TERM

echo "[clone] restore data"
RESTORE_DATA_STARTED_AT=$(now_epoch_s)
log_resource_snapshot "restore_data.start"
(
  psql "$TARGET_DB_URL" \
    --single-transaction \
    -v ON_ERROR_STOP=1 \
    <<EOF
SET session_replication_role=replica;
\i $DATA_PIPE
EOF
) &
PSQL_PID=$!

# Stream the data dump through a FIFO so large exports do not exhaust the container disk.
echo "[clone] dump data"
DUMP_DATA_STARTED_AT=$(now_epoch_s)
log_resource_snapshot "dump_data.start"
if pg_dump "$SOURCE_DB_URL" \
  --format=plain \
  --data-only \
  "$@" \
  --no-owner \
  --no-acl \
  --file="$DATA_PIPE"; then
  DUMP_STATUS=0
  log_stage_result "dump_data.done" "$DUMP_DATA_STARTED_AT"
else
  DUMP_STATUS=$?
  log_stage_result "dump_data.failed" "$DUMP_DATA_STARTED_AT"
fi

if wait "$PSQL_PID"; then
  PSQL_STATUS=0
  log_stage_result "restore_data.done" "$RESTORE_DATA_STARTED_AT"
else
  PSQL_STATUS=$?
  log_stage_result "restore_data.failed" "$RESTORE_DATA_STARTED_AT"
fi

trap - EXIT HUP INT TERM
cleanup_data_pipe

if [ "$PSQL_STATUS" -ne 0 ]; then
  echo "[clone] data restore failed." >&2
  exit 44
fi

if [ "$DUMP_STATUS" -ne 0 ]; then
  echo "[clone] data dump failed." >&2
  exit 42
fi

echo "[clone] completed"
log_resource_snapshot "clone.completed"
