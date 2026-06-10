import { extractLogErrorExcerpt } from "./logging.js";

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
      hint: "Start with a fresh or reset Supabase project, then try again. If logs mention missing extensions, enable those in Supabase first.",
    },
    45: {
      message: "This app uses database features that need to be enabled in Supabase.",
      failureClass: "target_extension_missing",
      hint: "Enable the listed database features in Supabase, then try again.",
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
    lowered.includes("cannot assign requested address") ||
    lowered.includes("could not translate host name") ||
    lowered.includes("network is unreachable") ||
    lowered.includes("no route to host") ||
    lowered.includes("nodename nor servname"));

const isLikelyMissingExtensionFailure = (lowered: string): boolean =>
  lowered.includes("target database is missing required extension setup") ||
  lowered.includes("could not open extension control file") ||
  lowered.includes("permission denied to create extension") ||
  /extension "[^"]+" is not available/.test(lowered) ||
  /extension "[^"]+" is not installed/.test(lowered) ||
  /extension "[^"]+" must be installed/.test(lowered) ||
  lowered.includes("function public.unaccent") ||
  lowered.includes("function extensions.unaccent") ||
  lowered.includes('operator class "gin_trgm_ops"') ||
  lowered.includes('operator class "gist_trgm_ops"') ||
  lowered.includes("function public.similarity") ||
  lowered.includes("function extensions.similarity") ||
  lowered.includes("function public.word_similarity") ||
  lowered.includes("function extensions.word_similarity") ||
  lowered.includes('type "vector" does not exist') ||
  lowered.includes("type public.vector does not exist") ||
  lowered.includes('type "geometry" does not exist') ||
  lowered.includes('type "geography" does not exist') ||
  lowered.includes("type public.geometry does not exist") ||
  lowered.includes("type public.geography does not exist") ||
  lowered.includes("function addgeometrycolumn") ||
  lowered.includes("function public.uuid_generate_v4") ||
  lowered.includes("function extensions.uuid_generate_v4") ||
  lowered.includes("function public.gen_random_uuid") ||
  lowered.includes("function extensions.gen_random_uuid") ||
  lowered.includes("function public.gen_salt") ||
  lowered.includes("function extensions.gen_salt") ||
  lowered.includes("function public.crypt") ||
  lowered.includes("function extensions.crypt");

const isLikelyMissingPgmqQueueFailure = (lowered: string): boolean =>
  /relation\s+"?pgmq\.q_[a-z0-9_]+"?\s+does not exist/i.test(lowered);

const COMMON_EXTENSION_SETUP_TERMS = new Set([
  "extension",
  "extensions",
  "public",
  "schema",
  "pg",
  "pg_catalog",
]);

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isLikelyTargetDatabaseStorageExhaustion = (lowered: string): boolean =>
  lowered.includes("no space left on device") &&
  (lowered.includes("pg_wal/") ||
    lowered.includes("xlogtemp") ||
    lowered.includes("psql:/tmp/pg-clone/clone-data.pipe") ||
    (lowered.includes("writing block") && lowered.includes("relation base/")));

const extractTargetExtensionSetupItems = (raw: string): string[] => {
  const items: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\[clone\](?:\[warn\])?\s+-\s+(.+)$/);
    if (!match?.[1]) continue;
    const item = match[1].trim();
    if (item.startsWith("extension ") || item.startsWith("Supabase Queue ")) {
      items.push(item);
    }
  }
  return items;
};

const extractTargetExtensionSetupTerms = (items: string[]): string[] => {
  const terms = new Set<string>();
  const addTerm = (value: string) => {
    const term = value.trim().toLowerCase();
    if (term.length >= 3 && !COMMON_EXTENSION_SETUP_TERMS.has(term)) {
      terms.add(term);
    }
  };

  for (const item of items) {
    const extensionMatch = item.match(/^extension\s+([a-z0-9_-]+)\s+in schema\s+([a-z0-9_-]+)/i);
    if (extensionMatch?.[1]) {
      const extensionName = extensionMatch[1].toLowerCase();
      addTerm(extensionName);
      if (extensionName.startsWith("pg_")) {
        addTerm(extensionName.slice(3));
      }
    }
    if (extensionMatch?.[2]) {
      addTerm(extensionMatch[2]);
    }

    const queueMatch = item.match(/^Supabase Queue\s+([a-z0-9_-]+)/i);
    if (queueMatch?.[1]) {
      const queueName = queueMatch[1].toLowerCase();
      addTerm(queueName);
      addTerm(`q_${queueName}`);
    }
  }

  return [...terms];
};

const includesIdentifierTerm = (lowered: string, term: string): boolean => {
  const escaped = escapeRegex(term);
  return new RegExp(`(^|[^a-z0-9_])${escaped}($|[^a-z0-9_])`, "i").test(lowered);
};

const isLikelyFailureForWarnedExtension = (lowered: string, setupItems: string[]): boolean => {
  if (setupItems.length === 0) return false;
  if (
    !lowered.includes("does not exist") &&
    !lowered.includes("is not installed") &&
    !lowered.includes("is not available") &&
    !lowered.includes("must be installed")
  ) {
    return false;
  }

  const terms = extractTargetExtensionSetupTerms(setupItems);
  return terms.some((term) => includesIdentifierTerm(lowered, term));
};

const removeCloneWarningLines = (raw: string): string =>
  raw
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("[clone][warn]"))
    .join("\n");

const formatTargetExtensionSetupHint = (items: string[]): string => {
  if (items.length === 0) {
    return "Enable the listed database extensions in Supabase, then try again.";
  }

  const visibleItems = items.slice(0, 6);
  const suffix =
    items.length > visibleItems.length ? `, and ${items.length - visibleItems.length} more` : "";
  return `Prepare these in Supabase, then try again: ${visibleItems.join("; ")}${suffix}.`;
};

const formatTargetExtensionRestoreHint = (items: string[]): string => {
  if (items.length === 0) {
    return "Enable the missing database extensions in Supabase, then retry. If a previous attempt created app tables, reset the target database first.";
  }

  const visibleItems = items.slice(0, 6);
  const suffix =
    items.length > visibleItems.length ? `, and ${items.length - visibleItems.length} more` : "";
  return `We tried to prepare these automatically, but Supabase still needs them: ${visibleItems.join("; ")}${suffix}. Enable or prepare them in Supabase, reset the target database if needed, then retry.`;
};

export const classifyContainerFailure = (raw: string): ClassifiedFailure => {
  const exitCode = extractExitCode(raw);
  const lowered = raw.toLowerCase();
  const failureExcerpt = extractLogErrorExcerpt(raw) ?? raw;
  const loweredFailureExcerpt = removeCloneWarningLines(failureExcerpt).toLowerCase();
  const targetExtensionSetupItems = extractTargetExtensionSetupItems(raw);

  if (exitCode === 45) {
    return {
      message: "This app uses database features that need to be enabled in Supabase.",
      failureClass: "target_extension_missing",
      hint: formatTargetExtensionSetupHint(targetExtensionSetupItems),
      exitCode,
    };
  }

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

  if (isLikelyTargetDatabaseStorageExhaustion(lowered)) {
    return {
      message: "Supabase ran out of database storage while restoring data.",
      failureClass: "target_db_storage_exhausted",
      hint: "Increase target database storage or retry into a larger fresh Supabase project.",
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

  if (
    isLikelyMissingExtensionFailure(loweredFailureExcerpt) ||
    isLikelyFailureForWarnedExtension(loweredFailureExcerpt, targetExtensionSetupItems)
  ) {
    return {
      message: "This app uses database extensions that need to be enabled in Supabase.",
      failureClass: "target_extension_missing",
      hint: formatTargetExtensionRestoreHint(targetExtensionSetupItems),
      exitCode,
    };
  }

  if (isLikelyMissingPgmqQueueFailure(loweredFailureExcerpt)) {
    return {
      message: "Your app uses Supabase Queues, but a required queue is missing in Supabase.",
      failureClass: "target_extension_missing",
      hint: "Enable Supabase Queues and create the missing queue, then try again.",
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
