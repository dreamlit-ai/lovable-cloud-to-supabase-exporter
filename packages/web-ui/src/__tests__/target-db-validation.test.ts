import { describe, expect, it } from "vitest";
import { detectTargetDbPasswordIssue, getTargetDbValidationError } from "../target-db-validation";

const TARGET_DB_HOST = "db.qicvuexedqhfkkyntpeh.supabase.co";
const TARGET_PROJECT_URL = "https://qicvuexedqhfkkyntpeh.supabase.co";

const getValidationError = (targetDbUrlInput: string) =>
  getTargetDbValidationError({
    targetDbUrl: targetDbUrlInput,
    targetDbUrlInput,
    targetProjectUrl: TARGET_PROJECT_URL,
  });

describe("getTargetDbValidationError", () => {
  it("detects the literal Supabase password placeholder", () => {
    expect(
      getValidationError(
        `postgresql://postgres:[YOUR-PASSWORD]@${TARGET_DB_HOST}:5432/postgres?sslmode=require`,
      ),
    ).toContain("Password placeholder detected.");
  });

  it("detects passwords that are still wrapped in brackets", () => {
    expect(
      getValidationError(
        `postgresql://postgres:[hunter2]@${TARGET_DB_HOST}:5432/postgres?sslmode=require`,
      ),
    ).toContain("wrapped in square brackets");
  });

  it("allows passwords that only contain brackets internally", () => {
    expect(
      getValidationError(
        `postgresql://postgres:p[a]ssword@${TARGET_DB_HOST}:5432/postgres?sslmode=require`,
      ),
    ).toBe("");
  });

  it("allows intentionally percent-encoded bracket wrappers for real passwords", () => {
    expect(
      getValidationError(
        `postgresql://postgres:%5Bhunter2%5D@${TARGET_DB_HOST}:5432/postgres?sslmode=require`,
      ),
    ).toBe("");
  });

  it("detects percent-encoded placeholders too", () => {
    expect(
      getValidationError(
        `postgresql://postgres:%5BYOUR-PASSWORD%5D@${TARGET_DB_HOST}:5432/postgres?sslmode=require`,
      ),
    ).toContain("Password placeholder detected.");
  });

  it("ignores brackets outside the password", () => {
    expect(
      detectTargetDbPasswordIssue(
        "postgresql://postgres:%5Bhunter2%5D@[::1]:5432/postgres?tag=[debug]",
      ),
    ).toBeNull();
  });
});
