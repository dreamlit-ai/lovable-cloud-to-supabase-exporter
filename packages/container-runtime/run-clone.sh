#!/bin/sh
set -eu

EXCLUDED_TABLES="auth.schema_migrations,storage.migrations,supabase_functions.migrations,auth.sessions,auth.refresh_tokens,auth.flow_state,auth.one_time_tokens,auth.audit_log_entries,auth.mfa_amr_claims"

WORK_DIR="/tmp/pg-clone"
SCHEMA_SQL="$WORK_DIR/clone-schema.sql"
SCHEMA_SQL_FILTERED="$WORK_DIR/clone-schema.filtered.sql"
SCHEMA_SQL_FILTER_PATTERNS="$WORK_DIR/clone-schema-filter-patterns.txt"
DATA_PIPE="$WORK_DIR/clone-data.pipe"
DATA_DUMP_STDERR="$WORK_DIR/clone-data-dump.stderr"
SOURCE_APP_SCHEMAS_RAW_FILE="$WORK_DIR/source-app-schemas.raw.txt"
SOURCE_APP_SCHEMAS_FILE="$WORK_DIR/source-app-schemas.txt"
SOURCE_APP_SCHEMAS_CUSTOM_FILE="$WORK_DIR/source-app-schemas.custom.txt"
SOURCE_DATA_SCHEMAS_FILE="$WORK_DIR/source-data-schemas.txt"
SOURCE_EXTENSIONS_FILE="$WORK_DIR/source-extensions.txt"
TARGET_EXTENSION_ISSUES_FILE="$WORK_DIR/target-extension-issues.txt"
SOURCE_PGMQ_QUEUES_FILE="$WORK_DIR/source-pgmq-queues.txt"
TARGET_QUEUE_ISSUES_FILE="$WORK_DIR/target-queue-issues.txt"
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
  psql "$psql_url" --no-psqlrc -Atq -v ON_ERROR_STOP=1 -c "$psql_sql"
}

sql_literal() {
  printf "%s" "$1" | sed "s/'/''/g"
}

sql_identifier() {
  printf '"%s"' "$(printf "%s" "$1" | sed 's/"/""/g')"
}

pg_dump_identifier_pattern() {
  sql_identifier "$1"
}

trim_csv_item() {
  printf "%s" "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

is_managed_schema() {
  schema_name="$1"

  case "$schema_name" in
    pg_*|information_schema|auth|storage|extensions|vault|net|pgmq|graphql|graphql_public|realtime|supabase_functions|supabase_migrations|_realtime|cron|pgbouncer|pgsodium|pgsodium_masks)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
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

flush_data_dump_stderr() {
  if [ -s "$DATA_DUMP_STDERR" ]; then
    cat "$DATA_DUMP_STDERR" >&2
  fi
}

dump_failure_looks_restore_induced() {
  if [ ! -s "$DATA_DUMP_STDERR" ]; then
    return 0
  fi

  if grep -Eiv '(^|[^[:alnum:]_])broken pipe([^[:alnum:]_]|$)' "$DATA_DUMP_STDERR" >/dev/null; then
    return 1
  fi

  return 0
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

schema_values_sql_from_file() {
  schema_file="$1"
  first=1

  while IFS= read -r schema_name; do
    schema_name="$(trim_csv_item "$schema_name")"
    if [ -z "$schema_name" ]; then
      continue
    fi

    schema_sql="$(sql_literal "$schema_name")"
    if [ "$first" -eq 1 ]; then
      printf "('%s')" "$schema_sql"
      first=0
    else
      printf ",('%s')" "$schema_sql"
    fi
  done < "$schema_file"

  if [ "$first" -eq 1 ]; then
    printf "('public')"
  fi
}

csv_values_sql() {
  csv_value="$1"
  old_ifs="$IFS"
  IFS=","
  first=1

  for raw_item in $csv_value; do
    item="$(trim_csv_item "$raw_item")"
    if [ -z "$item" ]; then
      continue
    fi

    item_sql="$(sql_literal "$item")"
    if [ "$first" -eq 1 ]; then
      printf "('%s')" "$item_sql"
      first=0
    else
      printf ",('%s')" "$item_sql"
    fi
  done

  IFS="$old_ifs"

  if [ "$first" -eq 1 ]; then
    printf "('')"
  fi
}

list_source_app_schemas() {
  psql_query "$SOURCE_DB_URL" "
    /* lovable_exporter_app_schemas */
    WITH managed_schema(name) AS (
      VALUES
        ('information_schema'),
        ('auth'),
        ('storage'),
        ('extensions'),
        ('vault'),
        ('net'),
        ('pgmq'),
        ('graphql'),
        ('graphql_public'),
        ('realtime'),
        ('supabase_functions'),
        ('supabase_migrations'),
        ('_realtime'),
        ('cron'),
        ('pgbouncer'),
        ('pgsodium'),
        ('pgsodium_masks')
    ),
    candidate_schema AS (
      SELECT n.oid, n.nspname
      FROM pg_namespace n
      WHERE n.nspname !~ '^pg_'
        AND NOT EXISTS (
          SELECT 1
          FROM managed_schema m
          WHERE m.name = n.nspname
        )
    ),
    app_schema AS (
      SELECT 'public' AS name
      UNION
      SELECT n.nspname
      FROM candidate_schema n
      WHERE EXISTS (
          SELECT 1
          FROM pg_class c
          WHERE c.relnamespace = n.oid
            AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
            AND NOT EXISTS (
              SELECT 1
              FROM pg_depend d
              WHERE d.classid = 'pg_class'::regclass
                AND d.objid = c.oid
                AND d.refclassid = 'pg_extension'::regclass
                AND d.deptype = 'e'
            )
        )
        OR EXISTS (
          SELECT 1
          FROM pg_proc p
          WHERE p.pronamespace = n.oid
            AND NOT EXISTS (
              SELECT 1
              FROM pg_depend d
              WHERE d.classid = 'pg_proc'::regclass
                AND d.objid = p.oid
                AND d.refclassid = 'pg_extension'::regclass
                AND d.deptype = 'e'
            )
        )
        OR EXISTS (
          SELECT 1
          FROM pg_type t
          WHERE t.typnamespace = n.oid
            AND t.typtype IN ('c', 'd', 'e', 'm', 'r')
            AND (
              t.typrelid = 0::oid
              OR NOT EXISTS (
                SELECT 1
                FROM pg_depend d
                WHERE d.classid = 'pg_class'::regclass
                  AND d.objid = t.typrelid
                  AND d.refclassid = 'pg_extension'::regclass
                  AND d.deptype = 'e'
              )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM pg_depend d
              WHERE d.classid = 'pg_type'::regclass
                AND d.objid = t.oid
                AND d.refclassid = 'pg_extension'::regclass
                AND d.deptype = 'e'
            )
        )
    )
    SELECT name
    FROM app_schema
    ORDER BY CASE WHEN name = 'public' THEN 0 ELSE 1 END, name;
  "
}

normalize_source_app_schemas() {
  : > "$SOURCE_APP_SCHEMAS_CUSTOM_FILE"

  while IFS= read -r raw_schema; do
    schema="$(trim_csv_item "$raw_schema")"
    if [ -z "$schema" ]; then
      continue
    fi
    if [ "$schema" = "public" ]; then
      continue
    fi
    if is_managed_schema "$schema"; then
      continue
    fi
    printf "%s\n" "$schema" >> "$SOURCE_APP_SCHEMAS_CUSTOM_FILE"
  done < "$SOURCE_APP_SCHEMAS_RAW_FILE"

  {
    printf "public\n"
    sort -u "$SOURCE_APP_SCHEMAS_CUSTOM_FILE"
  } > "$SOURCE_APP_SCHEMAS_FILE"
}

build_source_data_schemas() {
  {
    cat "$SOURCE_APP_SCHEMAS_FILE"
    printf "auth\n"
  } | awk 'NF > 0 && !seen[$0]++ { print }' > "$SOURCE_DATA_SCHEMAS_FILE"
}

log_source_app_schema_inventory() {
  schema_count="$(wc -l < "$SOURCE_APP_SCHEMAS_FILE" | tr -d '[:space:]')"
  schema_list="$(
    awk '
      NF > 0 {
        if (items == "") {
          items = $0
        } else {
          items = items ", " $0
        }
      }
      END { print items }
    ' "$SOURCE_APP_SCHEMAS_FILE"
  )"

  if [ -z "$schema_list" ]; then
    echo "[clone] source app schemas detected (0): none"
    return
  fi

  echo "[clone] source app schemas detected ($schema_count): $schema_list"
}

discover_source_app_schemas() {
  echo "[clone] inspect source schemas"
  if ! list_source_app_schemas > "$SOURCE_APP_SCHEMAS_RAW_FILE"; then
    echo "[clone] source schema inspection failed." >&2
    exit 41
  fi

  normalize_source_app_schemas
  build_source_data_schemas
  log_source_app_schema_inventory
}

build_schema_sql_filter_patterns() {
  while IFS= read -r raw_schema; do
    schema="$(trim_csv_item "$raw_schema")"
    if [ -z "$schema" ]; then
      continue
    fi

    schema_ident="$(sql_identifier "$schema")"
    printf "CREATE SCHEMA %s;\n" "$schema"
    printf "CREATE SCHEMA %s;\n" "$schema_ident"
  done < "$SOURCE_APP_SCHEMAS_FILE"
}

filter_schema_sql() {
  build_schema_sql_filter_patterns > "$SCHEMA_SQL_FILTER_PATTERNS"
  awk '
    NR == FNR {
      patterns[$0] = 1
      next
    }
    {
      for (pattern in patterns) {
        if ($0 == pattern || index($0, pattern) == 1) {
          next
        }
      }
      print
    }
  ' "$SCHEMA_SQL_FILTER_PATTERNS" "$SCHEMA_SQL"
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

  lt_schemas_values="$(schema_values_sql_from_file "$SOURCE_DATA_SCHEMAS_FILE")"
  lt_excludes_values="$(csv_values_sql "$EXCLUDED_TABLES")"

  psql_query "$lt_url" "
    WITH schemas(name) AS (VALUES $lt_schemas_values),
    excludes(name) AS (VALUES $lt_excludes_values)
    SELECT t.table_schema || '.' || t.table_name
    FROM information_schema.tables t
    JOIN schemas s ON s.name = t.table_schema
    LEFT JOIN excludes e ON e.name = (t.table_schema || '.' || t.table_name)
    WHERE t.table_type = 'BASE TABLE'
      AND e.name IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_depend d ON d.classid = 'pg_class'::regclass
          AND d.objid = c.oid
          AND d.refclassid = 'pg_extension'::regclass
          AND d.deptype = 'e'
        WHERE n.nspname = t.table_schema
          AND c.relname = t.table_name
      )
      AND NOT has_table_privilege(current_user, format('%I.%I', t.table_schema, t.table_name), '$lt_privilege')
    ORDER BY 1;
  "
}

list_required_extensions() {
  db_url="$1"

  psql_query "$db_url" "
    SELECT e.extname || '|' || n.nspname
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname <> 'plpgsql'
    ORDER BY 1;
  "
}

installed_extension_schema() {
  db_url="$1"
  extension_name="$2"
  extension_name_sql="$(sql_literal "$extension_name")"

  psql_query "$db_url" "
    SELECT n.nspname
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = '$extension_name_sql'
    LIMIT 1;
  "
}

record_extension_issue() {
  extension_name="$1"
  expected_schema="$2"
  installed_schema="$3"

  if [ -n "$installed_schema" ]; then
    printf "extension %s in schema %s (currently installed in schema %s)\n" \
      "$extension_name" \
      "$expected_schema" \
      "$installed_schema" >> "$TARGET_EXTENSION_ISSUES_FILE"
    return
  fi

  printf "extension %s in schema %s\n" "$extension_name" "$expected_schema" >> "$TARGET_EXTENSION_ISSUES_FILE"
}

log_source_extension_inventory() {
  if [ ! -s "$SOURCE_EXTENSIONS_FILE" ]; then
    echo "[clone] source extensions detected (0): none"
    return
  fi

  extension_count="$(wc -l < "$SOURCE_EXTENSIONS_FILE" | tr -d '[:space:]')"
  extension_list="$(
    awk -F'|' '
      NF >= 2 {
        item = $1 " in " $2
        if (items == "") {
          items = item
        } else {
          items = items ", " item
        }
      }
      END { print items }
    ' "$SOURCE_EXTENSIONS_FILE"
  )"

  echo "[clone] source extensions detected ($extension_count): $extension_list"
}

ensure_target_extension() {
  extension_name="$1"
  extension_schema="$2"
  extension_name_ident="$(sql_identifier "$extension_name")"
  extension_schema_ident="$(sql_identifier "$extension_schema")"

  echo "[clone] prepare target extension: $extension_name in schema $extension_schema"
  if ! psql "$TARGET_DB_URL" --no-psqlrc -v ON_ERROR_STOP=1 -c "CREATE SCHEMA IF NOT EXISTS $extension_schema_ident; CREATE EXTENSION IF NOT EXISTS $extension_name_ident WITH SCHEMA $extension_schema_ident;" >/dev/null; then
    record_extension_issue "$extension_name" "$extension_schema" ""
    return 1
  fi

  echo "[clone] prepared target extension: $extension_name in schema $extension_schema"
  return 0
}

prepare_target_app_schemas() {
  echo "[clone] prepare target app schemas"

  while IFS= read -r raw_schema; do
    schema="$(trim_csv_item "$raw_schema")"
    if [ -z "$schema" ]; then
      continue
    fi

    schema_ident="$(sql_identifier "$schema")"
    if ! psql "$TARGET_DB_URL" --no-psqlrc -v ON_ERROR_STOP=1 -c "CREATE SCHEMA IF NOT EXISTS $schema_ident;" >/dev/null; then
      echo "[clone] target app schema setup failed." >&2
      exit 43
    fi
  done < "$SOURCE_APP_SCHEMAS_FILE"
}

list_required_pgmq_queue_relations() {
  db_url="$1"
  app_schema_values="$(schema_values_sql_from_file "$SOURCE_APP_SCHEMAS_FILE")"

  psql_query "$db_url" "
    WITH app_schemas(name) AS (VALUES $app_schema_values),
    app_relations AS (
      SELECT c.oid
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN app_schemas s ON s.name = n.nspname
    ),
    app_dependent_objects AS (
      SELECT 'pg_class'::regclass AS classid, c.oid AS objid
      FROM app_relations c
      UNION ALL
      SELECT 'pg_proc'::regclass, p.oid
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN app_schemas s ON s.name = n.nspname
      UNION ALL
      SELECT 'pg_rewrite'::regclass, r.oid
      FROM pg_rewrite r
      JOIN app_relations c ON c.oid = r.ev_class
      UNION ALL
      SELECT 'pg_attrdef'::regclass, a.oid
      FROM pg_attrdef a
      JOIN app_relations c ON c.oid = a.adrelid
      UNION ALL
      SELECT 'pg_constraint'::regclass, con.oid
      FROM pg_constraint con
      LEFT JOIN app_relations c ON c.oid = con.conrelid
      LEFT JOIN pg_namespace n ON n.oid = con.connamespace
      LEFT JOIN app_schemas s ON s.name = n.nspname
      WHERE c.oid IS NOT NULL OR s.name IS NOT NULL
      UNION ALL
      SELECT 'pg_trigger'::regclass, tr.oid
      FROM pg_trigger tr
      JOIN app_relations c ON c.oid = tr.tgrelid
      WHERE NOT tr.tgisinternal
      UNION ALL
      SELECT 'pg_policy'::regclass, pol.oid
      FROM pg_policy pol
      JOIN app_relations c ON c.oid = pol.polrelid
    )
    SELECT DISTINCT q.relname
    FROM pg_depend d
    JOIN app_dependent_objects o ON o.classid = d.classid AND o.objid = d.objid
    JOIN pg_class q ON d.refclassid = 'pg_class'::regclass AND d.refobjid = q.oid
    JOIN pg_namespace n ON n.oid = q.relnamespace
    WHERE n.nspname = 'pgmq'
      AND q.relkind IN ('r', 'p')
      AND q.relname LIKE 'q\_%' ESCAPE '\'
    ORDER BY q.relname;
  "
}

target_has_pgmq_queue_relation() {
  queue_relation="$1"
  queue_relation_sql="$(sql_literal "$queue_relation")"

  psql_query "$TARGET_DB_URL" "
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'pgmq'
      AND c.relname = '$queue_relation_sql'
      AND c.relkind IN ('r', 'p')
    LIMIT 1;
  "
}

print_extension_setup_warnings() {
  echo "[clone][warn] target extension setup incomplete; continuing migration." >&2

  if [ -s "$TARGET_EXTENSION_ISSUES_FILE" ]; then
    while IFS= read -r issue; do
      if [ -n "$issue" ]; then
        echo "[clone][warn]   - $issue" >&2
      fi
    done < "$TARGET_EXTENSION_ISSUES_FILE"
  fi

  if [ -s "$TARGET_QUEUE_ISSUES_FILE" ]; then
    while IFS= read -r issue; do
      if [ -n "$issue" ]; then
        echo "[clone][warn]   - $issue" >&2
      fi
    done < "$TARGET_QUEUE_ISSUES_FILE"
  fi

  echo "[clone][warn] If restore fails, prepare these in Supabase, reset the target database if needed, then retry." >&2
}

prepare_target_extension_dependencies() {
  : > "$TARGET_EXTENSION_ISSUES_FILE"
  : > "$TARGET_QUEUE_ISSUES_FILE"

  echo "[clone] inspect extensions"
  if ! list_required_extensions "$SOURCE_DB_URL" > "$SOURCE_EXTENSIONS_FILE"; then
    echo "[clone] source extension inspection failed." >&2
    exit 41
  fi
  log_source_extension_inventory

  while IFS='|' read -r extension_name extension_schema; do
    if [ -z "$extension_name" ] || [ -z "$extension_schema" ]; then
      continue
    fi

    target_schema="$(installed_extension_schema "$TARGET_DB_URL" "$extension_name")"

    if [ -z "$target_schema" ]; then
      ensure_target_extension "$extension_name" "$extension_schema" || continue
      target_schema="$(installed_extension_schema "$TARGET_DB_URL" "$extension_name")"
    fi

    if [ "$target_schema" != "$extension_schema" ]; then
      record_extension_issue "$extension_name" "$extension_schema" "$target_schema"
    fi
  done < "$SOURCE_EXTENSIONS_FILE"

  if list_required_pgmq_queue_relations "$SOURCE_DB_URL" > "$SOURCE_PGMQ_QUEUES_FILE"; then
    while IFS= read -r queue_relation; do
      if [ -z "$queue_relation" ]; then
        continue
      fi

      if [ -z "$(target_has_pgmq_queue_relation "$queue_relation")" ]; then
        queue_name="${queue_relation#q_}"
        printf "Supabase Queue %s (creates pgmq.%s)\n" "$queue_name" "$queue_relation" >> "$TARGET_QUEUE_ISSUES_FILE"
      fi
    done < "$SOURCE_PGMQ_QUEUES_FILE"
  fi

  if [ -s "$TARGET_EXTENSION_ISSUES_FILE" ] || [ -s "$TARGET_QUEUE_ISSUES_FILE" ]; then
    print_extension_setup_warnings
  fi
}

require_env "SOURCE_DB_URL"
require_env "TARGET_DB_URL"

: "${PGSSLMODE:=require}"
export PGSSLMODE

mkdir -p "$WORK_DIR"
log_resource_snapshot "clone.start"

discover_source_app_schemas

SOURCE_NONSELECT_TABLES=$(list_tables_missing_privilege "$SOURCE_DB_URL" "SELECT")
if [ -n "$SOURCE_NONSELECT_TABLES" ]; then
  print_table_list_and_exit "source is missing SELECT on required tables:" "$SOURCE_NONSELECT_TABLES" 42
fi

TARGET_NONINSERT_TABLES=$(list_tables_missing_privilege "$TARGET_DB_URL" "INSERT")
if [ -n "$TARGET_NONINSERT_TABLES" ]; then
  print_table_list_and_exit "target is missing INSERT on required tables:" "$TARGET_NONINSERT_TABLES" 44
fi

prepare_target_app_schemas
prepare_target_extension_dependencies

echo "[clone] dump schema"
DUMP_SCHEMA_STARTED_AT=$(now_epoch_s)
log_resource_snapshot "dump_schema.start"
set --
while IFS= read -r raw_schema; do
  schema="$(trim_csv_item "$raw_schema")"
  if [ -n "$schema" ]; then
    set -- "$@" "--schema=$(pg_dump_identifier_pattern "$schema")"
  fi
done < "$SOURCE_APP_SCHEMAS_FILE"
if ! pg_dump "$SOURCE_DB_URL" \
  --format=plain \
  --schema-only \
  "$@" \
  --no-owner \
  --no-acl \
  --file="$SCHEMA_SQL"; then
  log_stage_result "dump_schema.failed" "$DUMP_SCHEMA_STARTED_AT"
  echo "[clone] schema dump failed." >&2
  exit 41
fi

if ! filter_schema_sql > "$SCHEMA_SQL_FILTERED"; then
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
rm -f "$DATA_DUMP_STDERR"
set --
while IFS= read -r raw_schema; do
  schema="$(trim_csv_item "$raw_schema")"
  if [ -n "$schema" ]; then
    set -- "$@" "--schema=$(pg_dump_identifier_pattern "$schema")"
  fi
done < "$SOURCE_DATA_SCHEMAS_FILE"
old_ifs="$IFS"
IFS=","
for raw_table in $EXCLUDED_TABLES; do
  table="$(trim_csv_item "$raw_table")"
  if [ -n "$table" ]; then
    set -- "$@" "--exclude-table=$table"
  fi
done
IFS="$old_ifs"
if pg_dump "$SOURCE_DB_URL" \
  --format=plain \
  --data-only \
  "$@" \
  --no-owner \
  --no-acl \
  --file="$DATA_PIPE" \
  2>"$DATA_DUMP_STDERR"; then
  DUMP_STATUS=0
  flush_data_dump_stderr
  log_stage_result "dump_data.done" "$DUMP_DATA_STARTED_AT"
else
  DUMP_STATUS=$?
  flush_data_dump_stderr
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
  if [ "$DUMP_STATUS" -ne 0 ] && ! dump_failure_looks_restore_induced; then
    echo "[clone] data dump failed." >&2
    exit 42
  fi

  echo "[clone] data restore failed." >&2
  exit 44
fi

if [ "$DUMP_STATUS" -ne 0 ]; then
  echo "[clone] data dump failed." >&2
  exit 42
fi

echo "[clone] completed"
log_resource_snapshot "clone.completed"
