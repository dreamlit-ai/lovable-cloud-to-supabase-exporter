import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const DEFAULT_STORAGE_COPY_CONCURRENCY = 8;
export const MIN_STORAGE_COPY_CONCURRENCY = 1;
export const MAX_STORAGE_COPY_CONCURRENCY = 8;

export const DEFAULT_DOCKER_IMAGE = "lovable-cloud-to-supabase-exporter-runtime:local";
const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONTAINER_CONTEXT = path.resolve(CLI_DIR, "../../..");
export const DEFAULT_CONTAINER_DOCKERFILE = path.resolve(
  CLI_DIR,
  "../../container-runtime/Dockerfile",
);

export const MAX_EVENTS = 200;
export const MAX_REQUEST_BYTES = 64 * 1024;

export const LOVABLE_DOCS_URL = "https://docs.lovable.dev";

export type ParsedArgs = {
  positionals: string[];
  flags: Record<string, string | boolean>;
};

export const parseArgs = (argv: string[]): ParsedArgs => {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const keyValue = token.slice(2);
    if (!keyValue) continue;

    if (keyValue.includes("=")) {
      const [key, ...rest] = keyValue.split("=");
      flags[key] = rest.join("=");
      continue;
    }

    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags[keyValue] = true;
      continue;
    }

    flags[keyValue] = next;
    i += 1;
  }

  return { positionals, flags };
};

export const getStringFlag = (
  flags: Record<string, string | boolean>,
  key: string,
): string | null => {
  const value = flags[key];
  return typeof value === "string" ? value : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isScalar = (value: unknown): boolean =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

const formatScalar = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  return String(value);
};

const renderHuman = (value: unknown, indent = 0): string[] => {
  const pad = " ".repeat(indent);

  if (isScalar(value)) {
    return [`${pad}${formatScalar(value)}`];
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}(none)`];
    const lines: string[] = [];
    for (const item of value) {
      if (isScalar(item)) {
        lines.push(`${pad}- ${formatScalar(item)}`);
        continue;
      }
      lines.push(`${pad}-`);
      lines.push(...renderHuman(item, indent + 2));
    }
    return lines;
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${pad}(empty)`];
    const lines: string[] = [];
    for (const [key, item] of entries) {
      if (isScalar(item)) {
        lines.push(`${pad}${key}: ${formatScalar(item)}`);
      } else {
        lines.push(`${pad}${key}:`);
        lines.push(...renderHuman(item, indent + 2));
      }
    }
    return lines;
  }

  return [`${pad}${String(value)}`];
};

export const print = (payload: unknown, asJson: boolean): void => {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${renderHuman(payload).join("\n")}\n`);
};

export type ProcessResult = {
  code: number;
  output: string;
  timedOut: boolean;
};

export const runProcess = async (
  command: string,
  args: string[],
  timeoutSeconds?: number,
): Promise<ProcessResult> => {
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let output = "";
    let timedOut = false;

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      reject(error);
    });

    let timeoutHandle: NodeJS.Timeout | null = null;
    let killHandle: NodeJS.Timeout | null = null;

    if (timeoutSeconds && timeoutSeconds > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killHandle = setTimeout(() => {
          child.kill("SIGKILL");
        }, 3000);
      }, timeoutSeconds * 1000);
    }

    child.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);
      resolve({
        code: code ?? 1,
        output,
        timedOut,
      });
    });
  });
};

export const buildContainerImage = async (
  image: string,
  context: string,
  dockerfile: string,
): Promise<void> => {
  const result = await runProcess("docker", ["build", "-f", dockerfile, "-t", image, context]);
  if (result.code !== 0) {
    throw new Error(
      `Container build failed. Run 'docker build -f ${dockerfile} -t ${image} ${context}' and retry.\n${result.output}`,
    );
  }
};
