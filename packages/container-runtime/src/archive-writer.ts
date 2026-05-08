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
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (typeof (body as NodeJS.ReadableStream).pipe === "function") {
    return body as Readable;
  }
  return Readable.fromWeb(body as unknown as WebReadableStream<Uint8Array>);
};

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

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
  private readonly pendingEntries: Array<{ resolve: () => void; reject: (error: Error) => void }> =
    [];
  private error: Error | null = null;
  private finalized = false;

  private constructor(output: Writable) {
    this.output = output;
    this.outputFinished = finished(this.output)
      .then(() => undefined)
      .catch((error) => {
        throw this.rememberError(error);
      });
    void this.outputFinished.catch(() => undefined);

    this.archive.on("error", (error) => {
      this.rejectPendingEntries(this.rememberError(error));
    });
    this.archive.on("entry", () => {
      this.pendingEntries.shift()?.resolve();
    });
    this.output.on("error", (error) => {
      this.rejectPendingEntries(this.rememberError(error));
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

  appendEntry(entry: ZipArtifactEntryInput): Promise<void> {
    this.assertHealthy();
    const source = toArchiveSource(entry.body);
    const completed = new Promise<void>((resolve, reject) => {
      this.pendingEntries.push({ resolve, reject });
    });

    if (source instanceof Readable) {
      source.once("error", (error) => {
        this.fail(error);
      });
    }

    try {
      this.archive.append(source, { name: entry.name });
    } catch (error) {
      const pending = this.pendingEntries.pop();
      const normalized = this.rememberError(error);
      pending?.reject(normalized);
    }

    return completed;
  }

  appendText(name: string, contents: string): Promise<void> {
    return this.appendEntry({ name, body: contents });
  }

  async finalize(): Promise<void> {
    this.assertHealthy();
    this.finalized = true;
    await Promise.all([this.archive.finalize(), this.outputFinished]);
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

  private fail(error: unknown): void {
    const normalized = this.rememberError(error);
    this.rejectPendingEntries(normalized);
    this.archive.abort();
    this.output.destroy(normalized);
  }

  private rememberError(error: unknown): Error {
    if (!this.error) {
      this.error = toError(error);
    }
    return this.error;
  }

  private rejectPendingEntries(error: Error): void {
    for (const pending of this.pendingEntries.splice(0)) {
      pending.reject(error);
    }
  }
}
