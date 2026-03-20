export type ClassifiedFailure = {
  message: string;
  failureClass: string;
  hint: string;
  exitCode: number | null;
};

export const extractExitCode = (raw: string): number | null => {
  const m = raw.match(/exit code:\s*(\d+)/i);
  if (!m) return null;
  const n = Number.parseInt(m[1] ?? "", 10);
  return Number.isFinite(n) ? n : null;
};

const EXIT_CODE_FAILURES: Record<number, { message: string; failureClass: string; hint: string }> =
  {
    1: {
      message:
        "Export command failed during database clone or storage copy. Inspect status events for phase context.",
      failureClass: "clone_command_failed",
      hint: "Validate DB permissions and endpoint compatibility.",
    },
    41: {
      message: "Schema dump failed on source database.",
      failureClass: "schema_dump_failed",
      hint: "Verify source DB access and schema existence.",
    },
    42: {
      message: "Data dump failed on source database.",
      failureClass: "data_dump_failed",
      hint: "Verify source DB access and table permissions.",
    },
    43: {
      message:
        "Target database rejected the schema restore. This usually means the target database is not blank or already has conflicting objects.",
      failureClass: "schema_restore_failed",
      hint: "Start with a fresh or reset Supabase database, then retry. If the database is already blank, verify the target postgres credentials and permissions.",
    },
    44: {
      message: "Data restore failed on target database.",
      failureClass: "data_restore_failed",
      hint: "Verify target constraints, permissions, and ordering.",
    },
    46: {
      message:
        "Target role cannot set session_replication_role=replica for restore. Use a role with higher privileges.",
      failureClass: "session_replication_role_permission_denied",
      hint: "Grant higher DB privileges for target restore role.",
    },
    61: {
      message: "Source edge function could not be resolved from inside the export runtime.",
      failureClass: "source_edge_function_resolve_failed",
      hint: "Check source edge function URL/access key and confirm it returns DB URL + admin key JSON.",
    },
    62: {
      message:
        "Source edge function response is missing the source admin key required for storage copy.",
      failureClass: "source_admin_key_missing",
      hint: "Redeploy the migrate-helper that returns service_role_key and retry.",
    },
    63: {
      message: "Storage copy failed inside the export runtime.",
      failureClass: "storage_copy_failed",
      hint: "Inspect status events for the failing bucket/object batch and retry.",
    },
    64: {
      message: "Export runtime callback delivery failed.",
      failureClass: "progress_callback_failed",
      hint: "Check exporter API callback reachability and retry.",
    },
    65: {
      message: "Export runtime configuration is invalid.",
      failureClass: "runtime_config_invalid",
      hint: "Check target DB URL, target project URL, and admin key inputs.",
    },
    67: {
      message: "Could not connect to the target database with the provided credentials.",
      failureClass: "target_db_connection_failed",
      hint: "Check the target connection string, postgres password, and network reachability, then retry.",
    },
    68: {
      message: "Target database does not appear empty.",
      failureClass: "target_db_not_empty",
      hint: "Start with a fresh or reset Supabase database, then retry.",
    },
    69: {
      message: "Connected to the target database, but could not verify whether it is empty.",
      failureClass: "target_db_inspection_failed",
      hint: "Use the postgres credentials from Supabase Connect, then retry.",
    },
  };

export const classifyContainerFailure = (raw: string): ClassifiedFailure => {
  const exitCode = extractExitCode(raw);
  const lowered = raw.toLowerCase();

  if (lowered.includes("err_module_not_found") || lowered.includes("cannot find package")) {
    return {
      message: "Export runtime image is missing a required dependency.",
      failureClass: "runtime_dependency_missing",
      hint: "Rebuild the export runtime image and retry.",
      exitCode,
    };
  }

  if (exitCode !== null) {
    const mapped = EXIT_CODE_FAILURES[exitCode];
    if (mapped) {
      return { ...mapped, exitCode };
    }
  }

  if (lowered.includes("timeout")) {
    return {
      message: "Clone run timed out. Increase timeout or reduce data scope.",
      failureClass: "timeout",
      hint: "Raise hard_timeout_seconds or reduce schema/data scope.",
      exitCode,
    };
  }

  return {
    message: "Export run failed. See status debug fields for raw error.",
    failureClass: "unknown",
    hint: "Inspect monitor_raw_error in status and retry with narrower scope.",
    exitCode,
  };
};
