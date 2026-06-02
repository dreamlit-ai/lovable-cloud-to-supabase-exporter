export const MANAGED_SCHEMA_NAMES = new Set([
  "information_schema",
  "auth",
  "storage",
  "extensions",
  "vault",
  "net",
  "pgmq",
  "graphql",
  "graphql_public",
  "realtime",
  "supabase_functions",
  "supabase_migrations",
  "_realtime",
  "cron",
  "pgbouncer",
  "pgsodium",
  "pgsodium_masks",
]);

export const APP_SCHEMA_DISCOVERY_SQL = `
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
`.trim();

export const isManagedSchemaName = (schema: string): boolean =>
  schema.startsWith("pg_") || MANAGED_SCHEMA_NAMES.has(schema);

export const normalizeAppSchemas = (schemas: Iterable<string>): string[] => {
  const customSchemas = new Set<string>();

  for (const schema of schemas) {
    const trimmed = schema.trim();
    if (!trimmed || trimmed === "public" || isManagedSchemaName(trimmed)) continue;
    customSchemas.add(trimmed);
  }

  return ["public", ...[...customSchemas].sort((left, right) => left.localeCompare(right))];
};

export const parseAppSchemaRows = (raw: string): string[] =>
  normalizeAppSchemas(raw.split(/\r?\n/u));

export const getDataDumpSchemas = (appSchemas: Iterable<string>): string[] => {
  const schemas = normalizeAppSchemas(appSchemas);
  return schemas.includes("auth") ? schemas : [...schemas, "auth"];
};

export const toPgDumpSchemaArgs = (schemas: Iterable<string>): string[] =>
  [...schemas].map((schema) => `--schema=${toPgDumpIdentifierPattern(schema)}`);

export const toPgDumpIdentifierPattern = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

export const formatSchemaInventory = (schemas: readonly string[]): string => {
  if (schemas.length === 0) return "source app schemas detected (0): none";
  return `source app schemas detected (${schemas.length}): ${schemas.join(", ")}`;
};
