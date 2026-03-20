import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/export-runner.ts"],
  clean: true,
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  noExternal: [/^@dreamlit\/lovable-cloud-to-supabase-exporter-core(\/.*)?$/],
});
