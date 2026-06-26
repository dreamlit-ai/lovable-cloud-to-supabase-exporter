export const JOB_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

export const isValidJobId = (jobId: string): boolean => JOB_ID_PATTERN.test(jobId);

export const JOB_ROUTE_ACTIONS = [
  "start-db",
  "start-storage",
  "start-export",
  "start-download",
  "start-target-db-test",
  "test-target-admin-key",
  "status",
  "summary",
  "artifact-access",
  "artifact",
  "container-callback",
] as const;

export type JobRouteAction = (typeof JOB_ROUTE_ACTIONS)[number];

export const WORKER_JOB_ROUTE_ACTIONS = [
  "start-storage",
  "start-export",
  "start-download",
  "start-target-db-test",
  "test-target-admin-key",
  "status",
  "summary",
  "artifact-access",
  "artifact",
  "container-callback",
] as const satisfies readonly JobRouteAction[];

export type WorkerJobRouteAction = (typeof WORKER_JOB_ROUTE_ACTIONS)[number];

export type ParsedJobAction = {
  jobId: string;
  action: JobRouteAction;
};

const escapeRegexLiteral = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const parseJobActionPath = (
  pathname: string,
  actions: readonly JobRouteAction[] = JOB_ROUTE_ACTIONS,
): ParsedJobAction | null => {
  const actionPattern = actions.map(escapeRegexLiteral).join("|");
  const match = pathname.match(new RegExp(`^/jobs/([^/]+)/(${actionPattern})$`));
  if (!match) return null;

  let jobId: string;
  try {
    jobId = decodeURIComponent(match[1] ?? "");
  } catch {
    return null;
  }

  if (!isValidJobId(jobId)) return null;

  return {
    jobId,
    action: (match[2] ?? "") as JobRouteAction,
  };
};
