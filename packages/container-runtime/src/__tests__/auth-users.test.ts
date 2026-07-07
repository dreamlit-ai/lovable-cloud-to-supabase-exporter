import { describe, expect, it } from "vitest";
import { buildAuthUserMigrationSql } from "../auth-users";

describe("buildAuthUserMigrationSql", () => {
  it("builds the default public.users migration SQL", () => {
    const sql = buildAuthUserMigrationSql();

    expect(sql).toContain('FROM "public"."users" AS source_user');
    expect(sql).toContain("NULLIF(btrim(to_jsonb(source_user)->>'email'), '') AS email");
    expect(sql).toContain("NULLIF(to_jsonb(source_user)->>'id', '') AS source_user_id");
    expect(sql).toContain("'00000000-0000-0000-0000-000000000000'::uuid");
    expect(sql).toContain("jsonb_build_object('provider', 'email'");
    expect(sql).toContain("'source_user_id', source_user_id");
    expect(sql).toContain("email_change_token_current");
    expect(sql).toContain("SELECT json_build_object(");
    expect(sql).toContain("COMMIT;");
  });

  it("uses custom schema-qualified table and profile columns", () => {
    const sql = buildAuthUserMigrationSql({
      usersTable: "app_accounts.members",
      idColumn: "legacy_id",
      emailColumn: "login_email",
      firstNameColumn: "given_name",
      lastNameColumn: "family_name",
      avatarColumn: "avatar_url",
    });

    expect(sql).toContain('FROM "app_accounts"."members" AS source_user');
    expect(sql).toContain("to_jsonb(source_user)->>'legacy_id'");
    expect(sql).toContain("to_jsonb(source_user)->>'login_email'");
    expect(sql).toContain("to_jsonb(source_user)->>'given_name'");
    expect(sql).toContain("to_jsonb(source_user)->>'family_name'");
    expect(sql).toContain("to_jsonb(source_user)->>'avatar_url'");
  });

  it("rejects unsafe identifiers", () => {
    expect(() =>
      buildAuthUserMigrationSql({
        usersTable: "public.users; drop table auth.users",
      }),
    ).toThrow("usersTable");
    expect(() =>
      buildAuthUserMigrationSql({
        emailColumn: "email); drop table auth.users",
      }),
    ).toThrow("emailColumn");
  });
});
