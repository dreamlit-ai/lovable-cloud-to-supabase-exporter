import type { ApiRequestOptions, JobRecord, MigrationSummary, StartBody } from "./types.js";
import { buildMigrationSummary } from "./summary.js";

const authHeaders = (token?: string): Record<string, string> =>
  token
    ? {
        Authorization: `Bearer ${token}`,
      }
    : {};

const jsonHeaders = (token?: string): Record<string, string> => ({
  ...authHeaders(token),
  "Content-Type": "application/json",
});

const parseJson = async <T>(response: Response): Promise<T> => {
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : ({} as T);
};

const assertOk = async (response: Response): Promise<void> => {
  if (response.ok) return;
  const body = await response.text();
  throw new Error(body || `Request failed with status ${response.status}`);
};

export const startExport = async (
  options: ApiRequestOptions,
  body: StartBody,
): Promise<unknown> => {
  const response = await fetch(
    `${options.baseUrl}/jobs/${encodeURIComponent(options.jobId)}/start-export`,
    {
      method: "POST",
      headers: jsonHeaders(options.bearerToken),
      body: JSON.stringify(body),
    },
  );
  await assertOk(response);
  return parseJson(response);
};

export const getJobStatus = async (
  options: ApiRequestOptions,
): Promise<JobRecord & { summary: MigrationSummary }> => {
  const response = await fetch(
    `${options.baseUrl}/jobs/${encodeURIComponent(options.jobId)}/status`,
    {
      method: "GET",
      headers: authHeaders(options.bearerToken),
    },
  );
  await assertOk(response);
  const status = await parseJson<JobRecord & { summary?: MigrationSummary }>(response);
  return {
    ...status,
    summary: status.summary ?? buildMigrationSummary(status),
  };
};
