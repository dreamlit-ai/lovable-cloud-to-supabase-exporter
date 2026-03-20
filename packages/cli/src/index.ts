#!/usr/bin/env node

import {
  buildMigrationSummary,
  type MigrationSummary,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core";
import {
  getMigrationStatus,
  getMigrationSummary,
  startDbMigration,
  startDownloadMigration,
  startExportMigration,
  startStorageMigration,
} from "./actions.js";
import { runApiServer } from "./api-server.js";
import { artifactExists, artifactFilePath } from "./artifacts.js";
import { runEdgeSetup } from "./edge.js";
import { asErrorMessage, fail, parsePort, toBooleanFlag, trimOrNull } from "./inputs.js";
import { startLocalContainerCallbackServer } from "./local-callback-server.js";
import {
  DEFAULT_CONTAINER_CONTEXT,
  DEFAULT_CONTAINER_DOCKERFILE,
  DEFAULT_DOCKER_IMAGE,
  getStringFlag,
  LOVABLE_DOCS_URL,
  type ParsedArgs,
  parseArgs,
  print,
} from "./utils.js";

const HELP_TEXT = `
Usage:
  lovable-cloud-to-supabase-exporter setup edge-function [--access-key <key>] [--out <path>] [--json]
  lovable-cloud-to-supabase-exporter export run [--job-id <id>] --source-edge-function-url <url> --source-edge-function-access-key <key> --target-db-url <url> --target-project-url <url> --target-admin-key <key> [--source-project-url <url>] --confirm-target-blank [--storage-copy-concurrency <n>] [--hard-timeout-seconds <n>] [--docker-image <tag>] [--container-context <dir>] [--dockerfile <path>] [--skip-build]
  lovable-cloud-to-supabase-exporter export download [--job-id <id>] --source-edge-function-url <url> --source-edge-function-access-key <key> [--source-project-url <url>] [--storage-copy-concurrency <n>] [--hard-timeout-seconds <n>] [--docker-image <tag>] [--container-context <dir>] [--dockerfile <path>] [--skip-build]
  lovable-cloud-to-supabase-exporter job status --job-id <id> [--json]

Advanced:
  lovable-cloud-to-supabase-exporter serve [--host <host>] [--port <port>] [--token <token>] [--docker-image <tag>] [--container-context <dir>] [--dockerfile <path>] [--skip-build]
  lovable-cloud-to-supabase-exporter db clone --job-id <id> --source-edge-function-url <url> --source-edge-function-access-key <key> --target-db-url <url> [--confirm-target-blank] [--docker-image <tag>] [--container-context <dir>] [--dockerfile <path>]
  lovable-cloud-to-supabase-exporter storage copy --job-id <id> --source-edge-function-url <url> --source-edge-function-access-key <key> [--source-project-url <url>] --target-project-url <url> --target-admin-key <key>
  lovable-cloud-to-supabase-exporter job summary --job-id <id> [--json]

Notes:
  --job-id is optional for export commands; status output includes summary.
  --source-project-url is optional and derives from --source-edge-function-url when omitted.
`;

type CommandContext = {
  args: ParsedArgs;
  asJson: boolean;
};

type CommandHandler = (ctx: CommandContext) => Promise<void>;

const isLoopbackHost = (host: string): boolean => {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
};

const sourceEdgeFunctionAccessKeyFlag = (args: ParsedArgs): string | null =>
  trimOrNull(getStringFlag(args.flags, "source-edge-function-access-key")) ??
  trimOrNull(getStringFlag(args.flags, "source-edge-function-token"));

const edgeSetupAccessKeyFlag = (args: ParsedArgs): string | null =>
  trimOrNull(getStringFlag(args.flags, "access-key")) ??
  trimOrNull(getStringFlag(args.flags, "token"));

const rawDbStartFromFlags = (args: ParsedArgs) => ({
  source_edge_function_url: getStringFlag(args.flags, "source-edge-function-url"),
  source_edge_function_access_key: sourceEdgeFunctionAccessKeyFlag(args),
  target_db_url: getStringFlag(args.flags, "target-db-url"),
  confirm_target_blank: args.flags["confirm-target-blank"],
  hard_timeout_seconds: trimOrNull(getStringFlag(args.flags, "hard-timeout-seconds")),
});

const rawStorageStartFromFlags = (args: ParsedArgs) => ({
  source_edge_function_url: getStringFlag(args.flags, "source-edge-function-url"),
  source_edge_function_access_key: sourceEdgeFunctionAccessKeyFlag(args),
  source_project_url: getStringFlag(args.flags, "source-project-url"),
  target_project_url: getStringFlag(args.flags, "target-project-url"),
  target_admin_key: getStringFlag(args.flags, "target-admin-key"),
  storage_copy_concurrency: getStringFlag(args.flags, "storage-copy-concurrency"),
});

const rawExportStartFromFlags = (args: ParsedArgs) => ({
  source_edge_function_url: getStringFlag(args.flags, "source-edge-function-url"),
  source_edge_function_access_key: sourceEdgeFunctionAccessKeyFlag(args),
  target_db_url: getStringFlag(args.flags, "target-db-url"),
  confirm_target_blank: args.flags["confirm-target-blank"],
  source_project_url: getStringFlag(args.flags, "source-project-url"),
  target_project_url: getStringFlag(args.flags, "target-project-url"),
  target_admin_key: getStringFlag(args.flags, "target-admin-key"),
  storage_copy_concurrency: getStringFlag(args.flags, "storage-copy-concurrency"),
  hard_timeout_seconds: trimOrNull(getStringFlag(args.flags, "hard-timeout-seconds")),
});

const rawDownloadStartFromFlags = (args: ParsedArgs) => ({
  source_edge_function_url: getStringFlag(args.flags, "source-edge-function-url"),
  source_edge_function_access_key: sourceEdgeFunctionAccessKeyFlag(args),
  source_project_url: getStringFlag(args.flags, "source-project-url"),
  storage_copy_concurrency: getStringFlag(args.flags, "storage-copy-concurrency"),
  hard_timeout_seconds: trimOrNull(getStringFlag(args.flags, "hard-timeout-seconds")),
});

const handleServe: CommandHandler = async ({ args }) => {
  const host = trimOrNull(getStringFlag(args.flags, "host")) ?? "127.0.0.1";
  const port = parsePort(trimOrNull(getStringFlag(args.flags, "port")));
  const token =
    trimOrNull(getStringFlag(args.flags, "token")) ??
    trimOrNull(process.env.LOVABLE_EXPORTER_API_BEARER_TOKEN ?? null);
  if (!isLoopbackHost(host) && !token) {
    fail(
      "Refusing to bind non-loopback host without auth token. Set --token (or LOVABLE_EXPORTER_API_BEARER_TOKEN).",
    );
  }

  await runApiServer({
    host,
    port,
    token,
    dbOptions: {
      dockerImage: trimOrNull(getStringFlag(args.flags, "docker-image")) ?? DEFAULT_DOCKER_IMAGE,
      containerContext:
        trimOrNull(getStringFlag(args.flags, "container-context")) ?? DEFAULT_CONTAINER_CONTEXT,
      dockerfile:
        trimOrNull(getStringFlag(args.flags, "dockerfile")) ?? DEFAULT_CONTAINER_DOCKERFILE,
      skipBuild: toBooleanFlag(args.flags["skip-build"]),
    },
  });
};

const handleEdgeSetup: CommandHandler = async ({ args, asJson }) => {
  await runEdgeSetup(
    edgeSetupAccessKeyFlag(args),
    trimOrNull(getStringFlag(args.flags, "out")),
    asJson,
  );
};

const handleDbClone: CommandHandler = async ({ args, asJson }) => {
  const jobId = trimOrNull(getStringFlag(args.flags, "job-id")) ?? `job-${Date.now()}`;
  const status = await startDbMigration(jobId, rawDbStartFromFlags(args), {
    dockerImage: trimOrNull(getStringFlag(args.flags, "docker-image")) ?? DEFAULT_DOCKER_IMAGE,
    containerContext:
      trimOrNull(getStringFlag(args.flags, "container-context")) ?? DEFAULT_CONTAINER_CONTEXT,
    dockerfile: trimOrNull(getStringFlag(args.flags, "dockerfile")) ?? DEFAULT_CONTAINER_DOCKERFILE,
    skipBuild: toBooleanFlag(args.flags["skip-build"]),
  });

  if (status.ok === false) {
    fail(status.error);
    return;
  }

  const dbStatus = status.value;
  print(
    {
      job_id: jobId,
      status: dbStatus.status,
      error: dbStatus.error,
      hint:
        dbStatus.status === "failed"
          ? (dbStatus.debug?.failure_hint ?? "Inspect job summary and retry.")
          : "",
    },
    asJson,
  );
};

const handleStorageCopy: CommandHandler = async ({ args, asJson }) => {
  const jobId = trimOrNull(getStringFlag(args.flags, "job-id")) ?? `job-${Date.now()}`;
  const status = await startStorageMigration(jobId, rawStorageStartFromFlags(args));
  if (status.ok === false) {
    fail(status.error);
    return;
  }

  const storageStatus = status.value;

  print(
    {
      job_id: jobId,
      status: storageStatus.status,
      error: storageStatus.error,
    },
    asJson,
  );
};

const handleExportRun: CommandHandler = async ({ args, asJson }) => {
  const jobId = trimOrNull(getStringFlag(args.flags, "job-id")) ?? `job-${Date.now()}`;
  const callbackSession = await startLocalContainerCallbackServer(jobId);

  try {
    const status = await startExportMigration(jobId, rawExportStartFromFlags(args), {
      dockerImage: trimOrNull(getStringFlag(args.flags, "docker-image")) ?? DEFAULT_DOCKER_IMAGE,
      containerContext:
        trimOrNull(getStringFlag(args.flags, "container-context")) ?? DEFAULT_CONTAINER_CONTEXT,
      dockerfile:
        trimOrNull(getStringFlag(args.flags, "dockerfile")) ?? DEFAULT_CONTAINER_DOCKERFILE,
      skipBuild: toBooleanFlag(args.flags["skip-build"]),
      callbackUrl: callbackSession.callbackUrl,
      callbackToken: callbackSession.callbackToken,
      runId: callbackSession.runId,
    });

    if (status.ok === false) {
      fail(status.error);
      return;
    }

    const exportStatus = status.value;

    print(
      {
        job_id: jobId,
        status: exportStatus.status,
        error: exportStatus.error,
        hint:
          exportStatus.status === "failed"
            ? (exportStatus.debug?.failure_hint ?? "Inspect job summary and retry.")
            : "",
        summary: buildMigrationSummary(exportStatus),
      },
      asJson,
    );
  } finally {
    await callbackSession.close();
  }
};

const handleExportDownload: CommandHandler = async ({ args, asJson }) => {
  const jobId = trimOrNull(getStringFlag(args.flags, "job-id")) ?? `job-${Date.now()}`;
  const callbackSession = await startLocalContainerCallbackServer(jobId);

  try {
    const status = await startDownloadMigration(jobId, rawDownloadStartFromFlags(args), {
      dockerImage: trimOrNull(getStringFlag(args.flags, "docker-image")) ?? DEFAULT_DOCKER_IMAGE,
      containerContext:
        trimOrNull(getStringFlag(args.flags, "container-context")) ?? DEFAULT_CONTAINER_CONTEXT,
      dockerfile:
        trimOrNull(getStringFlag(args.flags, "dockerfile")) ?? DEFAULT_CONTAINER_DOCKERFILE,
      skipBuild: toBooleanFlag(args.flags["skip-build"]),
      callbackUrl: callbackSession.callbackUrl,
      callbackToken: callbackSession.callbackToken,
      runId: callbackSession.runId,
    });

    if (status.ok === false) {
      fail(status.error);
      return;
    }

    const downloadStatus = status.value;

    print(
      {
        job_id: jobId,
        status: downloadStatus.status,
        error: downloadStatus.error,
        hint:
          downloadStatus.status === "failed"
            ? (downloadStatus.debug?.failure_hint ?? "Inspect job summary and retry.")
            : "",
        artifact_path:
          downloadStatus.status === "succeeded" && (await artifactExists(jobId))
            ? artifactFilePath(jobId)
            : null,
        summary: buildMigrationSummary(downloadStatus),
      },
      asJson,
    );
  } finally {
    await callbackSession.close();
  }
};

const handleJobStatus: CommandHandler = async ({ args, asJson }) => {
  const jobId =
    trimOrNull(getStringFlag(args.flags, "job-id")) ??
    fail("Missing --job-id. Provide a job id and try again.");

  const status = await getMigrationStatus(jobId);
  print(
    {
      ...status,
      job_id: jobId,
      summary: buildMigrationSummary(status),
    },
    asJson,
  );
};

const handleJobSummary: CommandHandler = async ({ args, asJson }) => {
  const jobId =
    trimOrNull(getStringFlag(args.flags, "job-id")) ??
    fail("Missing --job-id. Provide a job id and try again.");

  const summary: MigrationSummary = await getMigrationSummary(jobId);
  print(
    {
      job_id: jobId,
      summary,
      lovable_docs: LOVABLE_DOCS_URL,
    },
    asJson,
  );
};

const COMMANDS: Record<string, CommandHandler> = {
  serve: handleServe,
  "export run": handleExportRun,
  "export download": handleExportDownload,
  "setup edge-function": handleEdgeSetup,
  "db clone": handleDbClone,
  "storage copy": handleStorageCopy,
  "job status": handleJobStatus,
  "job summary": handleJobSummary,
};

const commandKey = (positionals: string[]): string | null => {
  const [group, action] = positionals;
  if (!group) return null;
  if (group === "serve") return "serve";
  if (!action) return group;
  return `${group} ${action}`;
};

const run = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const key = commandKey(args.positionals);
  const handler = key ? COMMANDS[key] : null;
  if (!handler) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  await handler({
    args,
    asJson: args.flags.json === true,
  });
};

run().catch((error: unknown) => {
  fail(`Migration command failed. ${asErrorMessage(error)}`);
});
