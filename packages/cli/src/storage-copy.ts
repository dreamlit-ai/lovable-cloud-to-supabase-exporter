import {
  sanitizeLogText,
  sanitizeStoredLogText,
  type JobRecord,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core";
import {
  getStorageCopyFailureDetails,
  getStorageCopyFailureHint,
  runStorageCopyEngine,
  toStorageFailureEventData,
  type StorageCopyProgress,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core/storage-copy";
import { asErrorMessage, nowIso, type StorageCopyInput } from "./inputs.js";
import { appendJobEvent, buildDefaultDebug, startJob } from "./jobs.js";
import { edgeFunctionOrigin, resolveSourceFromEdgeFunction } from "./edge.js";
import { resolveSourceDbObjectEnumerator } from "./source-db-object-enumerator.js";
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
  const storageCopyMode = input.skipExistingTargetObjects ? "retry_skip_existing" : "full";

  let status = await startJob(
    jobId,
    buildDefaultDebug({
      task: "storage",
      source_project_url: resolvedSourceProjectUrl,
      target_project_url: targetProjectUrl,
      storage_copy_mode: storageCopyMode,
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
        storage_copy_mode: storageCopyMode,
      },
    },
  );

  const buildCompletionMessage = (
    objectsSkippedMissing: number,
    objectsSkippedExisting: number,
  ) => {
    if (objectsSkippedMissing > 0 && objectsSkippedExisting > 0) {
      return "Storage copy completed with missing Lovable Cloud objects skipped. Existing Supabase objects were also left in place.";
    }
    if (objectsSkippedMissing > 0) {
      return "Storage copy completed with missing objects skipped.";
    }
    if (objectsSkippedExisting > 0) {
      return "Storage copy completed. Existing Supabase objects were left in place.";
    }
    return "Storage copy completed.";
  };

  const buildFailureSummaryMessage = (
    objectsFailed: number,
    objectsSkippedMissing: number,
    objectsSkippedExisting: number,
  ) => {
    const failureLabel = `${objectsFailed} object failure${objectsFailed === 1 ? "" : "s"}`;
    if (objectsSkippedMissing > 0 && objectsSkippedExisting > 0) {
      return `Storage copy completed with ${failureLabel}. Missing Lovable Cloud objects were skipped, and existing Supabase objects were left in place.`;
    }
    if (objectsSkippedMissing > 0) {
      return `Storage copy completed with ${failureLabel}. Missing Lovable Cloud objects were skipped.`;
    }
    if (objectsSkippedExisting > 0) {
      return `Storage copy completed with ${failureLabel}. Existing Supabase objects were left in place.`;
    }
    return `Storage copy completed with ${failureLabel}.`;
  };

  const buildFailureHint = (primaryFailure: ReturnType<typeof getStorageCopyFailureDetails>) => {
    const base = getStorageCopyFailureHint(primaryFailure);
    return base.includes("Retry")
      ? base
      : `${base} Retry storage copy to continue copying the remaining objects.`;
  };

  try {
    const resolvedSource = await resolveSourceFromEdgeFunction({
      sourceEdgeFunctionUrl,
      sourceEdgeFunctionAccessKey,
    });
    const sourceAdminKey = resolvedSource.sourceAdminKey;
    if (!sourceAdminKey) {
      throw new Error(
        "Lovable Cloud edge function response is missing service_role_key. Deploy the edge function that exports the admin key, then retry storage copy.",
      );
    }

    status = await appendJobEvent(jobId, status, {
      level: "info",
      phase: "source_edge_function.resolved",
      message: "Resolved Lovable Cloud admin key from edge function.",
    });

    status = await appendJobEvent(jobId, status, {
      level: "info",
      phase: "storage_copy.debug",
      message: "Counting storage objects from the Lovable Cloud database.",
      data: {
        stage: "count_source_objects",
      },
    });

    const sourceObjectEnumerator = await resolveSourceDbObjectEnumerator(
      resolvedSource.sourceDbUrl,
    );

    status = await appendJobEvent(jobId, status, {
      level: "info",
      phase: "storage_copy.debug",
      message: `Counted ${sourceObjectEnumerator.exactTotalObjects} storage objects from the Lovable Cloud database.`,
      data: {
        stage: "count_source_objects",
        objects_total: sourceObjectEnumerator.exactTotalObjects,
      },
    });

    const result = await runStorageCopyEngine({
      sourceProjectUrl: resolvedSourceProjectUrl,
      targetProjectUrl,
      sourceAdminKey,
      targetAdminKey,
      concurrency: boundedConcurrency,
      skipExistingTargetObjects: input.skipExistingTargetObjects,
      sourceObjectEnumerator,
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
            prefixes_scanned: progress.prefixesScanned,
            scan_complete: progress.scanComplete,
            objects_total: progress.objectsTotal,
            objects_copied: progress.objectsCopied,
            objects_failed: progress.objectsFailed,
            objects_skipped_existing: progress.objectsSkippedExisting,
            objects_skipped_missing: progress.objectsSkippedMissing,
          },
        });
      },
    });

    const primaryFailure = result.failedObjectSamples[0] ?? null;
    const message =
      result.objectsFailed > 0
        ? buildFailureSummaryMessage(
            result.objectsFailed,
            result.objectsSkippedMissing,
            result.objectsSkippedExisting,
          )
        : buildCompletionMessage(result.objectsSkippedMissing, result.objectsSkippedExisting);

    status = {
      ...status,
      status: result.objectsFailed > 0 ? "failed" : "succeeded",
      finished_at: nowIso(),
      error: result.objectsFailed > 0 ? message : null,
      debug:
        result.objectsFailed > 0 && status.debug
          ? {
              ...status.debug,
              failure_class: "storage_copy_partial_failure",
              failure_hint: buildFailureHint(primaryFailure),
              monitor_raw_error: sanitizeStoredLogText(primaryFailure?.message ?? message),
            }
          : status.debug,
    };

    status = await appendJobEvent(jobId, status, {
      level: result.objectsFailed > 0 ? "error" : "info",
      phase:
        result.objectsFailed > 0
          ? "storage_copy.failed"
          : result.objectsSkippedMissing > 0
            ? "storage_copy.partial"
            : "storage_copy.succeeded",
      message,
      data: {
        bucket_ids: result.bucketIds,
        buckets_total: result.bucketsTotal,
        buckets_created: result.bucketsCreated,
        objects_total: result.objectsTotal,
        objects_copied: result.objectsCopied,
        objects_failed: result.objectsFailed,
        objects_skipped_existing: result.objectsSkippedExisting,
        objects_skipped_missing: result.objectsSkippedMissing,
        concurrency: boundedConcurrency,
        failed_objects_sample: result.failedObjectSamples.map((failure) => ({
          message: failure.message,
          ...toStorageFailureEventData(failure),
        })),
        ...(primaryFailure ? toStorageFailureEventData(primaryFailure) : {}),
      },
    });

    return status;
  } catch (error) {
    const failureDetails = getStorageCopyFailureDetails(error);
    const message = sanitizeLogText(asErrorMessage(error));
    status = {
      ...status,
      status: "failed",
      finished_at: nowIso(),
      error: message || "Storage copy failed.",
      debug: status.debug
        ? {
            ...status.debug,
            failure_class: "storage_copy_failed",
            failure_hint: getStorageCopyFailureHint(failureDetails),
            monitor_raw_error: sanitizeStoredLogText(asErrorMessage(error)),
          }
        : status.debug,
    };
    status = await appendJobEvent(jobId, status, {
      level: "error",
      phase: "storage_copy.failed",
      message: message || "Storage copy failed.",
      data: {
        error: message,
        ...(failureDetails ? toStorageFailureEventData(failureDetails) : {}),
      },
    });
    return status;
  }
};
