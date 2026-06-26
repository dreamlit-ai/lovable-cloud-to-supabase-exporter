import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  clean: true,
  dts: true,
  format: ["esm"],
  outDir: "dist",
  noExternal: [/^@dreamlit\/lovable-cloud-to-supabase-exporter-core(\/.*)?$/],
});
