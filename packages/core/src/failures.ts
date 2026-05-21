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
      message: "Export failed before the migration could finish.",
      failureClass: "clone_command_failed",
      hint: "Try again. If it keeps failing, reach out via chat.",
    },
    41: {
      message: "Schema dump failed on Lovable Cloud database.",
      failureClass: "schema_dump_failed",
      hint: "Verify Lovable Cloud DB access and schema existence.",
    },
    42: {
      message: "Data dump failed on Lovable Cloud database.",
      failureClass: "data_dump_failed",
      hint: "Verify Lovable Cloud DB access and table permissions.",
    },
    43: {
      message: "Supabase could not create one of the database objects.",
      failureClass: "schema_restore_failed",
      hint: "Start with a fresh or reset Supabase project, then try again. If your app uses PostGIS, enable PostGIS in Supabase first.",
    },
    44: {
      message: "Data restore failed on Supabase database.",
      failureClass: "data_restore_failed",
      hint: "Verify Supabase constraints, permissions, and ordering.",
    },
    46: {
      message:
        "Supabase role cannot set session_replication_role=replica for restore. Use a role with higher privileges.",
      failureClass: "session_replication_role_permission_denied",
      hint: "Grant higher DB privileges for the Supabase restore role.",
    },
    61: {
      message: "Lovable Cloud edge function could not be resolved from inside the export runtime.",
      failureClass: "source_edge_function_resolve_failed",
      hint: "Check the edge function URL/access key and confirm it returns DB URL + admin key JSON.",
    },
    62: {
      message:
        "Lovable Cloud edge function response is missing the admin key required for storage copy.",
      failureClass: "source_admin_key_missing",
      hint: "Redeploy the migrate-helper that returns service_role_key and retry.",
    },
    63: {
      message: "Storage copy failed inside the export runtime.",
      failureClass: "storage_copy_failed",
      hint: "Try again. If it keeps failing, reach out via chat.",
    },
    64: {
      message: "Export runtime callback delivery failed.",
      failureClass: "progress_callback_failed",
      hint: "Check exporter API callback reachability and retry.",
    },
    65: {
      message: "Export runtime configuration is invalid.",
      failureClass: "runtime_config_invalid",
      hint: "Check Supabase DB URL, project URL, and admin key inputs.",
    },
    67: {
      message: "Could not connect to the Supabase database.",
      failureClass: "target_db_connection_failed",
      hint: "Check the connection string and database password, then try again.",
    },
    68: {
      message: "Supabase database does not appear empty.",
      failureClass: "target_db_not_empty",
      hint: "Start with a fresh or reset Supabase database, then retry.",
    },
    69: {
      message: "Connected to the Supabase database, but could not verify whether it is empty.",
      failureClass: "target_db_inspection_failed",
      hint: "Use the postgres credentials from Supabase Connect, then retry.",
    },
  };

const isLikelySupabaseDirectIpv6Failure = (lowered: string): boolean =>
  lowered.includes("db.") &&
  lowered.includes("supabase.co") &&
  (lowered.includes("address not available") ||
    lowered.includes("could not translate host name") ||
    lowered.includes("nodename nor servname"));

const isLikelyMissingPostgisFailure = (lowered: string): boolean =>
  lowered.includes('type "geometry" does not exist') ||
  lowered.includes('type "geography" does not exist') ||
  lowered.includes("function addgeometrycolumn") ||
  lowered.includes('extension "postgis"');

export const classifyContainerFailure = (raw: string): ClassifiedFailure => {
  const exitCode = extractExitCode(raw);
  const lowered = raw.toLowerCase();

  if (
    lowered.includes("err_module_not_found") ||
    lowered.includes("module_not_found") ||
    lowered.includes("cannot find package") ||
    lowered.includes("cannot find module")
  ) {
    return {
      message: "The export service hit an internal setup issue.",
      failureClass: "runtime_dependency_missing",
      hint: "Try again in a few minutes. If it keeps failing, reach out via chat.",
      exitCode,
    };
  }

  if (lowered.includes("no space left on device")) {
    return {
      message: "Export runtime ran out of disk while staging dump data.",
      failureClass: "runtime_disk_exhausted",
      hint: "Retry after reducing data scope or deploying the streaming dump fix.",
      exitCode,
    };
  }

  if (isLikelySupabaseDirectIpv6Failure(lowered)) {
    return {
      message: "Supabase Direct connection requires IPv6.",
      failureClass: "target_db_connection_failed",
      hint: "Use the Session pooler connection string from Supabase Connect, then try again.",
      exitCode,
    };
  }

  if (isLikelyMissingPostgisFailure(lowered)) {
    return {
      message: "Your app uses PostGIS, but PostGIS is not enabled in Supabase.",
      failureClass: "target_postgis_not_enabled",
      hint: "Enable PostGIS in Supabase, then try again.",
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
    message: "Export failed before the migration could finish.",
    failureClass: "unknown",
    hint: "Try again. If it keeps failing, reach out via chat.",
    exitCode,
  };
};
