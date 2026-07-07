export type AuthUserMigrationConfig = {
  usersTable?: string;
  idColumn?: string;
  emailColumn?: string;
  firstNameColumn?: string;
  lastNameColumn?: string;
  avatarColumn?: string;
};

export type NormalizedAuthUserMigrationConfig = {
  usersTable: string;
  idColumn: string;
  emailColumn: string;
  firstNameColumn: string;
  lastNameColumn: string;
  avatarColumn: string;
};

export type AuthUserMigrationSummary = {
  migrated: number;
  skipped_no_email: number;
  skipped_duplicate: number;
};

export const DEFAULT_AUTH_USER_MIGRATION_CONFIG: NormalizedAuthUserMigrationConfig = {
  usersTable: "users",
  idColumn: "id",
  emailColumn: "email",
  firstNameColumn: "first_name",
  lastNameColumn: "last_name",
  avatarColumn: "profile_image_url",
};

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/u;
const RELATION_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?$/u;

const quoteSqlIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const quoteSqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const normalizeIdentifier = (
  value: string | undefined,
  fallback: string,
  label: string,
): string => {
  const normalized = value?.trim() || fallback;
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a valid unquoted Postgres identifier.`);
  }
  return normalized;
};

const normalizeRelation = (value: string | undefined, fallback: string): string => {
  const normalized = value?.trim() || fallback;
  if (!RELATION_PATTERN.test(normalized)) {
    throw new Error("usersTable must be a valid table name or schema-qualified table name.");
  }
  return normalized;
};

export const normalizeAuthUserMigrationConfig = (
  config: AuthUserMigrationConfig = {},
): NormalizedAuthUserMigrationConfig => ({
  usersTable: normalizeRelation(config.usersTable, DEFAULT_AUTH_USER_MIGRATION_CONFIG.usersTable),
  idColumn: normalizeIdentifier(
    config.idColumn,
    DEFAULT_AUTH_USER_MIGRATION_CONFIG.idColumn,
    "idColumn",
  ),
  emailColumn: normalizeIdentifier(
    config.emailColumn,
    DEFAULT_AUTH_USER_MIGRATION_CONFIG.emailColumn,
    "emailColumn",
  ),
  firstNameColumn: normalizeIdentifier(
    config.firstNameColumn,
    DEFAULT_AUTH_USER_MIGRATION_CONFIG.firstNameColumn,
    "firstNameColumn",
  ),
  lastNameColumn: normalizeIdentifier(
    config.lastNameColumn,
    DEFAULT_AUTH_USER_MIGRATION_CONFIG.lastNameColumn,
    "lastNameColumn",
  ),
  avatarColumn: normalizeIdentifier(
    config.avatarColumn,
    DEFAULT_AUTH_USER_MIGRATION_CONFIG.avatarColumn,
    "avatarColumn",
  ),
});

const relationSql = (relation: string): string => {
  const parts = relation.split(".");
  const schema = parts.length === 2 ? parts[0] : "public";
  const table = parts.length === 2 ? parts[1] : parts[0];
  return `${quoteSqlIdentifier(schema!)}.${quoteSqlIdentifier(table!)}`;
};

export const buildAuthUserMigrationSql = (config: AuthUserMigrationConfig = {}): string => {
  const normalized = normalizeAuthUserMigrationConfig(config);
  const sourceRelation = relationSql(normalized.usersTable);
  const idColumn = quoteSqlLiteral(normalized.idColumn);
  const emailColumn = quoteSqlLiteral(normalized.emailColumn);
  const firstNameColumn = quoteSqlLiteral(normalized.firstNameColumn);
  const lastNameColumn = quoteSqlLiteral(normalized.lastNameColumn);
  const avatarColumn = quoteSqlLiteral(normalized.avatarColumn);

  return `
BEGIN;

WITH source_rows AS (
  SELECT
    NULLIF(btrim(to_jsonb(source_user)->>${emailColumn}), '') AS email,
    NULLIF(to_jsonb(source_user)->>${idColumn}, '') AS source_user_id,
    NULLIF(to_jsonb(source_user)->>${firstNameColumn}, '') AS first_name,
    NULLIF(to_jsonb(source_user)->>${lastNameColumn}, '') AS last_name,
    NULLIF(to_jsonb(source_user)->>${avatarColumn}, '') AS avatar_url,
    COALESCE(NULLIF(to_jsonb(source_user)->>'created_at', '')::timestamptz, now()) AS created_at
  FROM ${sourceRelation} AS source_user
),
normalized_rows AS (
  SELECT
    source_rows.*,
    lower(source_rows.email) AS email_key
  FROM source_rows
),
skipped_no_email AS (
  SELECT COUNT(*)::int AS count
  FROM normalized_rows
  WHERE email IS NULL
),
candidate_rows AS (
  SELECT *
  FROM normalized_rows
  WHERE email IS NOT NULL
),
deduped_rows AS (
  SELECT DISTINCT ON (email_key) *
  FROM candidate_rows
  ORDER BY email_key, created_at, source_user_id NULLS LAST
),
source_duplicate AS (
  SELECT (COUNT(*) - COUNT(DISTINCT email_key))::int AS count
  FROM candidate_rows
),
already_existing AS (
  SELECT COUNT(*)::int AS count
  FROM deduped_rows d
  WHERE EXISTS (
    SELECT 1
    FROM auth.users u
    WHERE lower(u.email) = d.email_key
  )
),
to_insert AS (
  SELECT
    d.*,
    gen_random_uuid() AS auth_user_id
  FROM deduped_rows d
  WHERE NOT EXISTS (
    SELECT 1
    FROM auth.users u
    WHERE lower(u.email) = d.email_key
  )
),
inserted_users AS (
  INSERT INTO auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    confirmation_token,
    recovery_token,
    email_change,
    email_change_token_new,
    email_change_token_current,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at
  )
  SELECT
    '00000000-0000-0000-0000-000000000000'::uuid,
    auth_user_id,
    'authenticated',
    'authenticated',
    email,
    NULL,
    now(),
    '',
    '',
    '',
    '',
    '',
    jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
    jsonb_build_object(
      'first_name', first_name,
      'last_name', last_name,
      'avatar_url', avatar_url,
      'source_user_id', source_user_id
    ),
    created_at,
    now()
  FROM to_insert
  RETURNING id, email
),
inserted_identities AS (
  INSERT INTO auth.identities (
    id,
    user_id,
    provider_id,
    provider,
    identity_data,
    created_at,
    updated_at
  )
  SELECT
    gen_random_uuid(),
    id,
    id::text,
    'email',
    jsonb_build_object('sub', id::text, 'email', email, 'email_verified', true),
    now(),
    now()
  FROM inserted_users
  RETURNING id
)
SELECT json_build_object(
  'migrated', (SELECT COUNT(*)::int FROM inserted_users),
  'skipped_no_email', (SELECT count FROM skipped_no_email),
  'skipped_duplicate',
    (SELECT count FROM source_duplicate) + (SELECT count FROM already_existing)
)::text;

COMMIT;
`.trim();
};

export const parseAuthUserMigrationSummary = (raw: string): AuthUserMigrationSummary => {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const migrated = Number(parsed.migrated);
  const skippedNoEmail = Number(parsed.skipped_no_email);
  const skippedDuplicate = Number(parsed.skipped_duplicate);
  if (
    !Number.isFinite(migrated) ||
    !Number.isFinite(skippedNoEmail) ||
    !Number.isFinite(skippedDuplicate)
  ) {
    throw new Error("Auth user migration returned invalid counts.");
  }
  return {
    migrated,
    skipped_no_email: skippedNoEmail,
    skipped_duplicate: skippedDuplicate,
  };
};
