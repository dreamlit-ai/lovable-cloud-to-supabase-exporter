import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

const normalizeAppBasePath = (value: string | undefined): string => {
  const trimmed = value?.trim();
  if (!trimmed) return "./";
  if (trimmed === "/") return "/";
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
};

export default defineConfig(({ command, mode, isSsrBuild }) => {
  const env = loadEnv(mode, __dirname, "");
  const isLibraryBuild = command === "build" && mode === "lib";
  const appBasePath = normalizeAppBasePath(env.VITE_APP_BASE_PATH);

  return {
    plugins: [react(), tailwindcss()],
    base: command === "build" && !isLibraryBuild ? appBasePath : undefined,
    build: isLibraryBuild
      ? {
          lib: {
            entry: resolve(__dirname, "src/index.ts"),
            formats: ["es"],
            fileName: "index",
            cssFileName: "styles",
          },
          rollupOptions: {
            external: [
              "react",
              "react-dom",
              "react/jsx-runtime",
              "@supabase/supabase-js",
              "lucide-react",
              "sugar-high",
            ],
          },
        }
      : isSsrBuild
        ? {
            rollupOptions: {
              output: {
                entryFileNames: "entry-server.js",
              },
            },
          }
        : undefined,
  };
});
