import { spawn } from "node:child_process";
import { normalizePostgresUrl } from "./postgres-url.js";
import {
  buildSupabaseSessionPoolerFallbackCandidateUrls,
  isSupabasePoolerTenantOrUserNotFoundMessage,
  parseSupabaseSessionPoolerHostList,
} from "./supabase-session-pooler-url.js";

export const isPostgresPasswordAuthFailureMessage = (text: string): boolean => {
  const message = text.toLowerCase();
  return (
    message.includes("password authentication failed") ||
    message.includes("28p01") ||
    message.includes("authentication failed")
  );
};

export type SupabaseSessionPoolerResolveInput = {
  postgresUrl: string;
  trySelect1: (postgresUrl: string) => Promise<void>;
  preferredPoolerHostsFromEnv?: string | null;
};

export type SupabaseSessionPoolerResolveResult = {
  url: string;
  selectedIndex: number;
};

/**
 * Tries the normalized URL first, then session pooler variants when the hostname is
 * `db.<ref>.supabase.co`. Stops immediately on password authentication failure for the
 * first candidate so wrong credentials are not masked by later attempts.
 */
export const resolveSupabasePostgresUrlWithSessionPoolerFallback = async (
  input: SupabaseSessionPoolerResolveInput,
): Promise<SupabaseSessionPoolerResolveResult> => {
  const normalized = normalizePostgresUrl(input.postgresUrl.trim());
  if (!normalized) {
    throw new Error("Invalid postgres connection URL.");
  }

  const preferred = parseSupabaseSessionPoolerHostList(input.preferredPoolerHostsFromEnv);
  const candidates = buildSupabaseSessionPoolerFallbackCandidateUrls(normalized, {
    preferredPoolerHosts: preferred,
  });

  let lastError: Error | null = null;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      await input.trySelect1(candidate);
      return { url: candidate, selectedIndex: index };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = error instanceof Error ? error : new Error(message);

      if (index === 0 && isPostgresPasswordAuthFailureMessage(message)) {
        throw lastError;
      }
    }
  }

  if (!lastError) {
    throw new Error("Could not connect to Postgres with any candidate URL.");
  }

  if (candidates.length > 1 && isSupabasePoolerTenantOrUserNotFoundMessage(lastError.message)) {
    throw new Error(
      `${lastError.message}\n\n` +
        "The project is not registered on any of the pooler hosts that were tried. " +
        "Copy the exact Session pooler hostname from the Supabase dashboard (Connect → Session mode) and set SUPABASE_SESSION_POOLER_HOSTS to that value only (comma- or newline-separated hostnames, no sentences).",
    );
  }

  throw lastError;
};

export type PsqlSelect1SpawnEnv = NodeJS.ProcessEnv;

export const psqlSelect1ViaSpawn = (postgresUrl: string, env: PsqlSelect1SpawnEnv): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(
      "psql",
      [postgresUrl, "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-Atqc", "SELECT 1;"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env,
      },
    );

    let combined = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      combined += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      combined += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            "psql is required but was not found in PATH. Install PostgreSQL client tools and retry.",
          ),
        );
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${combined}\nexit code: ${code ?? 1}`.trim()));
    });
  });
