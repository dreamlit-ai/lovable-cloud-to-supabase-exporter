import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { normalizeContainerCallbackBody } from "@dreamlit/lovable-cloud-to-supabase-exporter-core";
import { asErrorMessage, isRecord, nowIso } from "./inputs.js";
import { pushEvent, updateJob } from "./jobs.js";
import { MAX_REQUEST_BYTES } from "./utils.js";

export type LocalContainerCallbackSession = {
  callbackToken: string;
  callbackUrl: string;
  close: () => Promise<void>;
  runId: string;
};

const CALLBACK_HOST = "127.0.0.1";
const CONTAINER_CALLBACK_HOST = "host.docker.internal";
const CALLBACK_PATH = "/container-callback";

const writeJson = (res: ServerResponse, status: number, payload: unknown): void => {
  res.statusCode = status;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload, null, 2));
};

const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
  let body = "";
  let bodyBytes = 0;
  for await (const chunk of req) {
    const text = chunk.toString("utf8");
    body += text;
    bodyBytes += Buffer.byteLength(text, "utf8");
    if (bodyBytes > MAX_REQUEST_BYTES) {
      throw new Error("request_too_large");
    }
  }

  if (!body.trim()) return {};

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("invalid_json");
  }
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;

const isJobStatus = (value: unknown): value is "idle" | "running" | "succeeded" | "failed" =>
  value === "idle" || value === "running" || value === "succeeded" || value === "failed";

export const startLocalContainerCallbackServer = async (
  jobId: string,
): Promise<LocalContainerCallbackSession> => {
  const runId = `run-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const callbackToken = randomBytes(24).toString("hex");

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        writeJson(res, 204, {});
        return;
      }

      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname !== CALLBACK_PATH) {
        writeJson(res, 404, { error: "Invalid migration route." });
        return;
      }

      if (req.method !== "POST") {
        writeJson(res, 405, { error: "Use POST for this action." });
        return;
      }

      const parsedBody = asRecord(await readJsonBody(req));
      const callbackBody = parsedBody ? normalizeContainerCallbackBody(parsedBody) : null;

      if (!callbackBody) {
        writeJson(res, 400, { error: "Invalid callback payload." });
        return;
      }

      if (callbackBody.callback_token !== callbackToken) {
        writeJson(res, 401, { error: "Invalid callback token." });
        return;
      }

      if (callbackBody.run_id !== runId) {
        writeJson(res, 409, { error: "Callback run_id does not match active job run." });
        return;
      }

      await updateJob(jobId, (current) => {
        if (current.run_id !== runId) return current;

        const nextDebug =
          current.debug && callbackBody.debug_patch
            ? {
                ...current.debug,
                ...callbackBody.debug_patch,
              }
            : current.debug;
        const nextStatus =
          callbackBody.status && isJobStatus(callbackBody.status)
            ? callbackBody.status
            : current.status;
        const nextFinishedAt =
          callbackBody.status === "succeeded" || callbackBody.status === "failed"
            ? (callbackBody.finished_at ?? nowIso())
            : current.finished_at;
        const nextError = callbackBody.error !== undefined ? callbackBody.error : current.error;

        return pushEvent(
          {
            ...current,
            status: nextStatus,
            finished_at: nextFinishedAt,
            error: nextError,
            debug: nextDebug,
          },
          {
            level: callbackBody.level!,
            phase: callbackBody.phase!,
            message: callbackBody.message!,
            data: callbackBody.data,
          },
        );
      });

      writeJson(res, 202, { ok: true });
    } catch (error) {
      const message = asErrorMessage(error);
      if (message === "request_too_large") {
        writeJson(res, 413, {
          error: "Request is too large. Reduce payload size and try again.",
        });
        return;
      }
      if (message === "invalid_json") {
        writeJson(res, 400, {
          error: "Invalid JSON body. Fix payload and try again.",
        });
        return;
      }
      writeJson(res, 500, {
        error: "Migration callback service failed. Retry in a moment.",
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, CALLBACK_HOST, () => resolve());
  });

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address.port !== "number") {
    throw new Error("Could not allocate local callback port.");
  }

  let closePromise: Promise<void> | null = null;

  return {
    callbackToken,
    callbackUrl: `http://${CONTAINER_CALLBACK_HOST}:${address.port}${CALLBACK_PATH}`,
    runId,
    close: async () => {
      if (closePromise) return closePromise;
      closePromise = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      return closePromise;
    },
  };
};
