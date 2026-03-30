import {
  sanitizeLogText,
  sanitizeStoredLogText,
  type JobRecord,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core";
import {
  runStorageCopyEngine,
  type StorageCopyProgress,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core/storage-copy";
import { asErrorMessage, nowIso, type StorageCopyInput } from "./inputs.js";
import { appendJobEvent, buildDefaultDebug, startJob } from "./jobs.js";
import { edgeFunctionOrigin, resolveSourceFromEdgeFunction } from "./edge.js";
import {
  DEFAULT_STORAGE_COPY_CONCURRENCY,
  MAX_STORAGE_COPY_CONCURRENCY,
  MIN_STORAGE_COPY_CONCURRENCY,
} from "./utils.js";

export const runStorageCopy = async (
  jobId: string,
  input: StorageCopyInput,
): Promise<JobRecord> => {
  const {
    sourceEdgeFunctionUrl,
    sourceEdgeFunctionAccessKey,
    sourceProjectUrl,
    targetProjectUrl,
    targetAdminKey,
    concurrency,
  } = input;

  const resolvedSourceProjectUrl = sourceProjectUrl ?? edgeFunctionOrigin(sourceEdgeFunctionUrl);
  const boundedConcurrency = Math.min(
    MAX_STORAGE_COPY_CONCURRENCY,
    Math.max(MIN_STORAGE_COPY_CONCURRENCY, concurrency || DEFAULT_STORAGE_COPY_CONCURRENCY),
  );

  let status = await startJob(
    jobId,
    buildDefaultDebug({
      task: "storage",
      source_project_url: resolvedSourceProjectUrl,
      target_project_url: targetProjectUrl,
      storage_copy_mode: "full",
      storage_copy_concurrency: boundedConcurrency,
    }),
    {
      level: "info",
      phase: "storage_copy.started",
      message: "Storage copy started.",
      data: {
        source_project_url: resolvedSourceProjectUrl,
        target_project_url: targetProjectUrl,
        concurrency: boundedConcurrency,
        source_mode: "edge_function",
      },
    },
  );

  try {
    const resolvedSource = await resolveSourceFromEdgeFunction({
      sourceEdgeFunctionUrl,
      sourceEdgeFunctionAccessKey,
    });
    const sourceAdminKey = resolvedSource.sourceAdminKey;
    if (!sourceAdminKey) {
      throw new Error(
        "Source edge function response is missing service_role_key. Deploy the edge function that exports the source admin key, then retry storage copy.",
      );
    }

    status = await appendJobEvent(jobId, status, {
      level: "info",
      phase: "source_edge_function.resolved",
      message: "Resolved source admin key from source edge function.",
    });

    const result = await runStorageCopyEngine({
      sourceProjectUrl: resolvedSourceProjectUrl,
      targetProjectUrl,
      sourceAdminKey,
      targetAdminKey,
      concurrency: boundedConcurrency,
      onProgress: async (progress: StorageCopyProgress) => {
        status = await appendJobEvent(jobId, status, {
          level: "info",
          phase: "storage_copy.progress",
          message: "Storage copy in progress.",
          data: {
            bucket_id: progress.bucketId,
            prefix: progress.prefix,
            buckets_processed: progress.bucketsProcessed,
            buckets_total: progress.bucketsTotal,
            objects_total: progress.objectsTotal,
            objects_copied: progress.objectsCopied,
            objects_skipped_missing: progress.objectsSkippedMissing,
          },
        });
      },
    });

    status = {
      ...status,
      status: "succeeded",
      finished_at: nowIso(),
      error: null,
    };

    status = await appendJobEvent(jobId, status, {
      level: "info",
      phase: result.objectsSkippedMissing > 0 ? "storage_copy.partial" : "storage_copy.succeeded",
      message:
        result.objectsSkippedMissing > 0
          ? "Storage copy completed with missing objects skipped."
          : "Storage copy completed.",
      data: {
        bucket_ids: result.bucketIds,
        buckets_total: result.bucketsTotal,
        buckets_created: result.bucketsCreated,
        objects_total: result.objectsTotal,
        objects_copied: result.objectsCopied,
        objects_skipped_missing: result.objectsSkippedMissing,
        concurrency: boundedConcurrency,
      },
    });

    return status;
  } catch (error) {
    status = {
      ...status,
      status: "failed",
      finished_at: nowIso(),
      error:
        "Storage copy failed. Verify source edge function, project URLs, and target admin key, then retry.",
      debug: status.debug
        ? {
            ...status.debug,
            failure_class: "storage_copy_failed",
            failure_hint:
              "Check source edge function URL/access key, source project URL, and target admin key.",
            monitor_raw_error: sanitizeStoredLogText(asErrorMessage(error)),
          }
        : status.debug,
    };
    status = await appendJobEvent(jobId, status, {
      level: "error",
      phase: "storage_copy.failed",
      message: "Storage copy failed.",
      data: {
        error: sanitizeLogText(asErrorMessage(error)),
      },
    });
    return status;
  }
};
