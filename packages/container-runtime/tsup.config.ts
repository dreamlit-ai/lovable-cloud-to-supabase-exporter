import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/export-runner.ts"],
  clean: true,
  format: ["cjs"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  outExtension() {
    return {
      js: ".cjs",
    };
  },
  noExternal: [/^@dreamlit\/lovable-cloud-to-supabase-exporter-core(\/.*)?$/, "archiver"],
});
