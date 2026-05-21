import { getTargetDbValidationError } from "./target-db-validation";

const DEFAULT_TARGET_CONNECTION_TEST_TIMEOUT_MS = 10000;

export type TargetConnectionTestResult =
  | {
      ok: true;
      message: string;
    }
  | {
      ok: false;
      message: string;
    };

type TargetConnectionTestOptions = {
  targetDbUrl: string;
  targetDbUrlInput: string;
  targetProjectUrl: string;
  targetAdminKey: string;
  timeoutMs?: number;
};

const validateHttpUrl = (value: string): string | null => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
};

export async function testTargetConnection({
  targetDbUrl,
  targetDbUrlInput,
  targetProjectUrl,
  targetAdminKey,
  timeoutMs = DEFAULT_TARGET_CONNECTION_TEST_TIMEOUT_MS,
}: TargetConnectionTestOptions): Promise<TargetConnectionTestResult> {
  const trimmedDbUrlInput = targetDbUrlInput.trim();
  const trimmedDbUrl = targetDbUrl.trim();
  const trimmedProjectUrl = targetProjectUrl.trim();
  const trimmedAdminKey = targetAdminKey.trim();

  if (!trimmedDbUrlInput) {
    return { ok: false, message: "Connection string is required." };
  }

  if (!trimmedAdminKey) {
    return { ok: false, message: "Secret API key is required." };
  }

  const validationError = getTargetDbValidationError({
    targetDbUrl: trimmedDbUrl,
    targetDbUrlInput: trimmedDbUrlInput,
    targetProjectUrl: trimmedProjectUrl,
  });

  if (validationError) {
    return { ok: false, message: validationError };
  }

  const projectUrl = validateHttpUrl(trimmedProjectUrl);
  if (!projectUrl) {
    return {
      ok: false,
      message: "Paste a Supabase direct connection or session pooler connection string.",
    };
  }

  const requestUrl = new URL("/rest/v1/", projectUrl).toString();
  const controller = new AbortController();
  let didTimeout = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  try {
    const responsePromise = fetch(requestUrl, {
      method: "GET",
      headers: {
        apikey: trimmedAdminKey,
        Authorization: `Bearer ${trimmedAdminKey}`,
      },
      signal: controller.signal,
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => {
          didTimeout = true;
          controller.abort();
          reject(new Error("target-connection-test-timeout"));
        },
        Math.max(1, timeoutMs),
      );
    });

    const response = await Promise.race([responsePromise, timeoutPromise]);

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        message:
          "Secret API key rejected. Create a new secret key for this Supabase project and try again.",
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        message: `Supabase connection test failed with status ${response.status}.`,
      };
    }

    return {
      ok: true,
      message: "Connected",
    };
  } catch {
    if (didTimeout) {
      return {
        ok: false,
        message: "Supabase connection test timed out. Check the project and try again.",
      };
    }

    return {
      ok: false,
      message: "Could not reach Supabase. Check the connection string project ref and try again.",
    };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
