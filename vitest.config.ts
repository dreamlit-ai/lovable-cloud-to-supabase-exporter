import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePath } from "vite";
import { defineConfig } from "vitest/config";

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CORE_SRC_DIR = normalizePath(path.resolve(ROOT_DIR, "packages/core/src"));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@dreamlit\/lovable-cloud-to-supabase-exporter-core$/,
        replacement: `${CORE_SRC_DIR}/index.ts`,
      },
      {
        find: /^@dreamlit\/lovable-cloud-to-supabase-exporter-core\/(.+)$/,
        replacement: `${CORE_SRC_DIR}/$1.ts`,
      },
    ],
  },
});
