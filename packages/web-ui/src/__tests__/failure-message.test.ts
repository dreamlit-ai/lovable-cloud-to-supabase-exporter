import { describe, expect, it } from "vitest";
import { buildFailureMessage } from "../failure-message";
import type { MigrationJobRecord } from "../job-polling";

const baseFailedRecord: MigrationJobRecord = {
  status: "failed",
  run_id: "run-1",
  started_at: "2026-06-01T00:00:00.000Z",
  finished_at: "2026-06-01T00:01:00.000Z",
  error: null,
  events: [],
  debug: {},
};

describe("buildFailureMessage", () => {
  it("prefers the restore excerpt for schema restore failures", () => {
    const record: MigrationJobRecord = {
      ...baseFailedRecord,
      error: "Supabase could not create one of the database objects.",
      debug: {
        failure_class: "schema_restore_failed",
        failure_hint: "Start with a fresh or reset Supabase project, then try again.",
        error_excerpt:
          'psql:/tmp/pg-clone/clone-schema.filtered.sql:308: ERROR: schema "private" does not exist',
        psql_diagnostic: "Supabase could not create one of the database objects.",
      },
    };

    expect(
      buildFailureMessage(record, "Supabase could not create one of the database objects."),
    ).toContain('ERROR: schema "private" does not exist');
  });
});
