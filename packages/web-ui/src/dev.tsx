import React from "react";
import { createRoot } from "react-dom/client";
import { LovableCloudToSupabaseExporterApp } from "./index";
import { initPosthogAnalytics } from "./posthog";

void initPosthogAnalytics();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LovableCloudToSupabaseExporterApp />
  </React.StrictMode>,
);
