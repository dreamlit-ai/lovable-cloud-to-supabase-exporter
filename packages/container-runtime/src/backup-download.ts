// Fetches the Lovable backup into the container and unwraps it when Lovable
// delivered it inside a ZIP.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { open, readdir, statfs, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { detectBackupContainer } from "./backup-plan.js";

const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAY_MS = 1000;
const PROGRESS_INTERVAL_MS = 2000;
// Abort when no bytes arrive for this long, so a stalled connection retries
// instead of hanging until the container's hard timeout.
const DOWNLOAD_STALL_TIMEOUT_MS = 120_000;

export class BackupDownloadError extends Error {
  reason:
    | "download_failed"
    | "not_enough_disk"
    | "unrecognized_file"
    | "zip_without_backup"
    | "unzip_failed";

  constructor(reason: BackupDownloadError["reason"], message: string) {
    super(message);
    this.name = "BackupDownloadError";
    this.reason = reason;
  }
}

export const freeDiskBytes = async (directory: string): Promise<number | null> => {
  try {
    const stats = await statfs(directory);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export const downloadBackup = async (input: {
  // Re-resolved per attempt so expiring signed URLs are refreshed on retry.
  // Errors from it propagate unchanged, so callers keep their own messages.
  resolveUrl: () => Promise<string>;
  destination: string;
  onProgress?: (progress: { bytesDownloaded: number; bytesTotal: number | null }) => void;
  fetchImpl?: typeof fetch;
}): Promise<{ bytes: number }> => {
  const fetchImpl = input.fetchImpl ?? fetch;
  let lastError = "";
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    const url = await input.resolveUrl();
    const stall = new AbortController();
    let stallTimer = setTimeout(() => stall.abort(), DOWNLOAD_STALL_TIMEOUT_MS);
    const resetStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => stall.abort(), DOWNLOAD_STALL_TIMEOUT_MS);
    };
    try {
      const response = await fetchImpl(url, { signal: stall.signal });
      if (!response.ok || !response.body) {
        lastError = `HTTP ${response.status}`;
        if (response.status < 500 && response.status !== 429 && response.status !== 408) break;
      } else {
        const lengthHeader = Number.parseInt(response.headers.get("content-length") ?? "", 10);
        const bytesTotal = Number.isFinite(lengthHeader) ? lengthHeader : null;
        const free = await freeDiskBytes(path.dirname(input.destination));
        // The ZIP case needs room for the extracted copy too.
        if (bytesTotal !== null && free !== null && free < bytesTotal * 2.1) {
          throw new BackupDownloadError(
            "not_enough_disk",
            "This backup is too large for the migration runner. Contact us and we'll help you move it.",
          );
        }
        let bytesDownloaded = 0;
        let lastProgressAt = 0;
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            resetStallTimer();
            bytesDownloaded += chunk.length;
            const now = Date.now();
            if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
              lastProgressAt = now;
              input.onProgress?.({ bytesDownloaded, bytesTotal });
            }
            callback(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
          meter,
          createWriteStream(input.destination),
        );
        if (bytesTotal !== null && bytesDownloaded !== bytesTotal) {
          lastError = `downloaded ${bytesDownloaded} of ${bytesTotal} bytes`;
        } else {
          input.onProgress?.({ bytesDownloaded, bytesTotal });
          return { bytes: bytesDownloaded };
        }
      }
    } catch (error) {
      if (error instanceof BackupDownloadError) throw error;
      lastError = stall.signal.aborted
        ? "the download stalled"
        : error instanceof Error
          ? error.message
          : String(error);
    } finally {
      clearTimeout(stallTimer);
    }
    if (attempt < DOWNLOAD_ATTEMPTS) await sleep(attempt * DOWNLOAD_RETRY_DELAY_MS);
  }
  throw new BackupDownloadError(
    "download_failed",
    `Could not download the backup (${lastError || "unknown error"}).`,
  );
};

const readFirstBytes = async (filePath: string, count = 8): Promise<Uint8Array> => {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(count);
    const { bytesRead } = await handle.read(buffer, 0, count, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

const run = (command: string, args: string[]): Promise<{ code: number; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });

const listFilesRecursive = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
};

// Returns the path of a custom-format archive, extracting it from a ZIP if
// needed. Picks the largest archive inside the ZIP when there are several.
export const prepareArchiveFile = async (
  downloadedPath: string,
  workDir: string,
): Promise<{ archivePath: string; wasZipped: boolean }> => {
  const kind = detectBackupContainer(await readFirstBytes(downloadedPath));
  if (kind === "archive") return { archivePath: downloadedPath, wasZipped: false };
  if (kind === "unknown") {
    throw new BackupDownloadError(
      "unrecognized_file",
      "This file isn't a Lovable database backup. Upload the .backup file from Export project data.",
    );
  }

  const extractDir = path.join(workDir, "backup-unzipped");
  const unzip = await run("unzip", ["-qq", "-o", downloadedPath, "-d", extractDir]);
  if (unzip.code !== 0) {
    throw new BackupDownloadError("unzip_failed", "Could not open the ZIP file.");
  }
  const candidates: Array<{ filePath: string; size: number }> = [];
  for (const filePath of await listFilesRecursive(extractDir)) {
    if (detectBackupContainer(await readFirstBytes(filePath)) === "archive") {
      candidates.push({ filePath, size: (await stat(filePath)).size });
    }
  }
  const largest = candidates.sort((left, right) => right.size - left.size)[0];
  if (!largest) {
    throw new BackupDownloadError(
      "zip_without_backup",
      "The ZIP file doesn't contain a database backup.",
    );
  }
  return { archivePath: largest.filePath, wasZipped: true };
};
