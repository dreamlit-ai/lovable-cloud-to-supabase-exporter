import { normalizePostgresUrl } from "@dreamlit/lovable-cloud-to-supabase-exporter-core";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { trimOrNull } from "./inputs.js";
import { print } from "./utils.js";

type SourceEdgePayload = {
  supabase_db_url?: unknown;
  service_role_key?: unknown;
  error?: unknown;
  message?: unknown;
};

export type SourceEdgeInput = {
  sourceEdgeFunctionUrl: string;
  sourceEdgeFunctionAccessKey: string;
};

export type SourceEdgeResolved = {
  sourceDbUrl: string;
  sourceAdminKey: string | null;
};

const asPayload = (value: unknown): SourceEdgePayload | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as SourceEdgePayload;
};

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const asPostgresUrl = (value: unknown): string | null => {
  const raw = asNonEmptyString(value);
  if (!raw) return null;
  return normalizePostgresUrl(raw);
};

const parseEdgePayload = (raw: string): SourceEdgePayload | null => {
  if (!raw.trim()) return {};
  try {
    return asPayload(JSON.parse(raw));
  } catch {
    return null;
  }
};

const payloadErrorMessage = (payload: SourceEdgePayload | null): string | null => {
  if (!payload) return null;
  const direct = asNonEmptyString(payload.error);
  if (direct) return direct;
  return asNonEmptyString(payload.message);
};

export const edgeFunctionOrigin = (edgeFunctionUrl: string): string => {
  const parsed = new URL(edgeFunctionUrl);
  return `${parsed.protocol}//${parsed.host}`;
};

export const resolveSourceFromEdgeFunction = async (
  input: SourceEdgeInput,
): Promise<SourceEdgeResolved> => {
  let response: Response;
  try {
    response = await fetch(input.sourceEdgeFunctionUrl, {
      method: "POST",
      headers: {
        "x-access-key": input.sourceEdgeFunctionAccessKey,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
  } catch {
    throw new Error(
      "Could not call Lovable Cloud edge function. Confirm source_edge_function_url, source_edge_function_access_key, and network access, then retry.",
    );
  }

  const raw = await response.text();
  const payload = parseEdgePayload(raw);
  if (payload === null) {
    throw new Error("Lovable Cloud edge function returned invalid JSON.");
  }

  if (!response.ok) {
    throw new Error(
      payloadErrorMessage(payload) ??
        "Lovable Cloud edge function request failed. Check source_edge_function_url and source_edge_function_access_key.",
    );
  }

  const sourceDbUrl = asPostgresUrl(payload.supabase_db_url);
  if (!sourceDbUrl) {
    throw new Error(
      "Lovable Cloud edge function response is missing supabase_db_url or it is not a valid postgres URL.",
    );
  }

  return {
    sourceDbUrl,
    sourceAdminKey: asNonEmptyString(payload.service_role_key),
  };
};

const randomAccessKey = (): string => randomBytes(24).toString("hex");

const accessKeyPlaceholder = "replace-with-your-long-random-access-key";
const sourceTemplateCandidates = [
  new URL("./edge-function/index.ts", import.meta.url),
  new URL("../../../edge-function/index.ts", import.meta.url),
];

const loadEdgeFunctionTemplate = async (): Promise<string> => {
  let lastError: unknown = null;

  for (const candidate of sourceTemplateCandidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Unable to load edge function template. Last error: ${lastError instanceof Error ? lastError.message : "unknown"}`,
  );
};

const withAccessKey = (source: string, accessKey: string): string => {
  const pattern = /const ACCESS_KEY = ["']replace-with-your-long-random-access-key["'];/;
  const replaced = source.replace(pattern, `const ACCESS_KEY = ${JSON.stringify(accessKey)};`);

  if (replaced === source) {
    throw new Error(`Template is missing ACCESS_KEY placeholder (${accessKeyPlaceholder}).`);
  }

  return replaced;
};

export const runEdgeSetup = async (
  accessKeyArg: string | null,
  outPath: string | null,
  asJson: boolean,
): Promise<void> => {
  const accessKey = trimOrNull(accessKeyArg) ?? randomAccessKey();
  const template = await loadEdgeFunctionTemplate();
  const source = withAccessKey(template, accessKey);

  let writtenPath: string | null = null;
  if (outPath) {
    const absolute = path.resolve(process.cwd(), outPath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, source, "utf8");
    writtenPath = absolute;
  }

  const payload = {
    access_key: accessKey,
    output_path: writtenPath,
    next_steps: [
      "Deploy this edge function as migrate-helper to your Lovable Cloud project.",
      "Set secret: supabase secrets set SUPABASE_DB_URL=postgresql://... --project-ref <source-project-ref>",
      "Set secret: supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<service-role-key> --project-ref <source-project-ref>",
      `Call this function with header: x-access-key: ${accessKey}`,
    ],
    source,
  };

  if (asJson) {
    print(payload, true);
    return;
  }

  process.stdout.write(`Generated access key: ${accessKey}\n`);
  if (writtenPath) {
    process.stdout.write(`Wrote edge function to: ${writtenPath}\n`);
  }
  process.stdout.write("\nEdge function source:\n\n");
  process.stdout.write(source);
  process.stdout.write("\n\nNext steps:\n");
  for (const step of payload.next_steps) {
    process.stdout.write(`- ${step}\n`);
  }
};
