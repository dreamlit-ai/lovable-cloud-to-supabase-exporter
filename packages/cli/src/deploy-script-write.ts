import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildMigrationSummary,
  type JobRecord,
} from "@dreamlit/lovable-cloud-to-supabase-exporter-core";

export const tryWriteDeployEdgeFunctionsScript = async (
  job: JobRecord,
  options: {
    cwd: string;
    noDeployScript: boolean;
    deployScriptOut: string | null;
  },
): Promise<string | null> => {
  if (options.noDeployScript) return null;

  const summary = buildMigrationSummary(job);
  const script = summary.deploy_edge_functions_script;
  if (!script) return null;

  const fileName = summary.deploy_edge_functions_script_filename;
  const targetPath = options.deployScriptOut
    ? path.resolve(options.cwd, options.deployScriptOut)
    : path.resolve(options.cwd, fileName);

  await writeFile(targetPath, script, "utf8");
  await chmod(targetPath, 0o755);
  return targetPath;
};
