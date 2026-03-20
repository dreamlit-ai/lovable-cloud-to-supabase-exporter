import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliDistEntry = path.join(rootDir, "packages/cli/dist/index.js");

const run = (command, args, extraEnv = {}) => {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
};

const runPnpm = (args) => {
  const pnpmExecPath = process.env.npm_execpath;
  if (pnpmExecPath) {
    const pnpmArgs = pnpmExecPath.endsWith(".js") ? [pnpmExecPath, ...args] : args;
    const command = pnpmExecPath.endsWith(".js") ? process.execPath : pnpmExecPath;
    return run(command, pnpmArgs);
  }

  return run("pnpm", args);
};

if (!existsSync(cliDistEntry)) {
  const buildStatus = runPnpm(["--filter", "lovable-cloud-to-supabase-exporter-cli", "build"]);
  if (buildStatus !== 0) {
    process.exit(buildStatus);
  }
}

process.exit(run(process.execPath, [cliDistEntry, ...process.argv.slice(2)]));
