import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { LovableCloudToSupabaseExporterApp } from "./index";
import { initPosthogAnalytics } from "./posthog";

void initPosthogAnalytics();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Lovable Cloud to Supabase Exporter root element was not found.");
}

const app = (
  <React.StrictMode>
    <LovableCloudToSupabaseExporterApp />
  </React.StrictMode>
);

if (rootElement.hasChildNodes()) {
  hydrateRoot(rootElement, app);
} else {
  createRoot(rootElement).render(app);
}
