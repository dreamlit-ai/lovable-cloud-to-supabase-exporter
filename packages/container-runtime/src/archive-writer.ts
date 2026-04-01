import archiver from "archiver";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

export type ZipArtifactEntryInput = {
  name: string;
  body: string | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array> | NodeJS.ReadableStream;
};

const toArchiveSource = (body: ZipArtifactEntryInput["body"]): string | Buffer | Readable => {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (typeof (body as NodeJS.ReadableStream).pipe === "function") {
    return body as Readable;
  }
  return Readable.fromWeb(body as unknown as WebReadableStream<Uint8Array>);
};

const shouldKeepSchemaLine = (line: string): boolean =>
  line !== "CREATE SCHEMA public;" && !line.startsWith("COMMENT ON SCHEMA public IS ");

export const createSchemaSqlFilterStream = (): Transform => {
  let pending = "";

  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";

      for (const line of lines) {
        if (!shouldKeepSchemaLine(line)) continue;
        this.push(`${line}\n`);
      }

      callback();
    },
    flush(callback) {
      if (pending && shouldKeepSchemaLine(pending)) {
        this.push(pending);
      }
      pending = "";
      callback();
    },
  });
};

export class ZipArtifactWriter {
  private readonly archive = archiver("zip", {
    forceZip64: true,
    zlib: { level: 6 },
  });

  private readonly output: Writable;
  private readonly outputFinished: Promise<void>;
  private error: Error | null = null;
  private finalized = false;

  private constructor(output: Writable) {
    this.output = output;
    this.outputFinished = finished(this.output).then(() => undefined);

    this.archive.on("error", (error) => {
      this.error = error;
    });
    this.output.on("error", (error) => {
      this.error = error instanceof Error ? error : new Error(String(error));
    });

    this.archive.pipe(this.output);
  }

  static async createFile(artifactOutputPath: string): Promise<ZipArtifactWriter> {
    await mkdir(path.dirname(artifactOutputPath), { recursive: true });
    return new ZipArtifactWriter(createWriteStream(artifactOutputPath));
  }

  static createWritable(output: Writable): ZipArtifactWriter {
    return new ZipArtifactWriter(output);
  }

  appendEntry(entry: ZipArtifactEntryInput): void {
    this.assertHealthy();
    this.archive.append(toArchiveSource(entry.body), { name: entry.name });
  }

  appendText(name: string, contents: string): void {
    this.appendEntry({ name, body: contents });
  }

  async finalize(): Promise<void> {
    this.assertHealthy();
    this.finalized = true;
    await this.archive.finalize();
    await this.outputFinished;
    this.assertHealthy();
  }

  abort(): void {
    if (this.finalized) return;
    this.finalized = true;
    this.archive.abort();
    this.output.destroy();
  }

  bytesWritten(): number {
    return this.archive.pointer();
  }

  private assertHealthy(): void {
    if (this.error) {
      throw this.error;
    }
  }
}
