import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ZipArtifactWriter, createSchemaSqlFilterStream } from "../archive-writer.js";

const tempDirs: string[] = [];
const hasUnzip = spawnSync("sh", ["-lc", "command -v unzip >/dev/null 2>&1"]).status === 0;

const readFilteredText = async (input: string): Promise<string> => {
  const filter = createSchemaSqlFilterStream();
  const chunks: string[] = [];

  return await new Promise<string>((resolve, reject) => {
    filter.on("data", (chunk: Buffer | string) => {
      chunks.push(chunk.toString());
    });
    filter.on("end", () => {
      resolve(chunks.join(""));
    });
    filter.on("error", reject);
    filter.end(input);
  });
};

describe("archive-writer", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filters public schema boilerplate out of streamed schema dumps", async () => {
    const filtered = await readFilteredText(
      [
        "CREATE SCHEMA public;",
        "CREATE TABLE public.demo(id int);",
        "COMMENT ON SCHEMA public IS 'standard public schema';",
        "ALTER TABLE public.demo ENABLE ROW LEVEL SECURITY;",
        "",
      ].join("\n"),
    );

    expect(filtered).toBe(
      [
        "CREATE TABLE public.demo(id int);",
        "ALTER TABLE public.demo ENABLE ROW LEVEL SECURITY;",
        "",
      ].join("\n"),
    );
  });

  it.runIf(hasUnzip)("writes readable zip artifacts from text and streamed entries", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "zip-artifact-"));
    tempDirs.push(tempDir);

    const artifactPath = path.join(tempDir, "artifact.zip");
    const writer = await ZipArtifactWriter.createFile(artifactPath);
    writer.appendText("manifest.json", "hello\n");
    writer.appendEntry({
      name: "storage/avatars/logo.txt",
      body: Readable.from(["streamed-data"]),
    });

    await writer.finalize();

    const manifest = spawnSync("unzip", ["-p", artifactPath, "manifest.json"], {
      encoding: "utf8",
    });
    expect(manifest.status).toBe(0);
    expect(manifest.stdout).toBe("hello\n");

    const objectEntry = spawnSync("unzip", ["-p", artifactPath, "storage/avatars/logo.txt"], {
      encoding: "utf8",
    });
    expect(objectEntry.status).toBe(0);
    expect(objectEntry.stdout).toBe("streamed-data");
    expect(writer.bytesWritten()).toBeGreaterThan(0);
  });
});
