import { describe, expect, it } from "vitest";
import { buildStorageMissingObjectsCsv } from "../storage-missing";

describe("buildStorageMissingObjectsCsv", () => {
  it("neutralizes spreadsheet formula prefixes before CSV escaping", () => {
    expect(
      buildStorageMissingObjectsCsv([
        {
          bucketId: "=avatars",
          objectPath: '+HYPERLINK("https://example.com","open")',
          projectHost: "source.example",
          projectRole: "source",
          statusCode: 0,
          reason: "source_object_export_failed",
          error: "\tcmd",
        },
        {
          bucketId: "-private",
          objectPath: "@payload",
          projectHost: "source.example",
          projectRole: "source",
          statusCode: 404,
          reason: "source_object_not_found",
        },
      ]),
    ).toBe(
      [
        "bucket_id,object_path,project_host,project_role,status_code,reason,error",
        "'-private,'@payload,source.example,source,404,source_object_not_found,",
        `'=avatars,"'+HYPERLINK(""https://example.com"",""open"")",source.example,source,0,source_object_export_failed,'\tcmd`,
        "",
      ].join("\n"),
    );
  });
});
