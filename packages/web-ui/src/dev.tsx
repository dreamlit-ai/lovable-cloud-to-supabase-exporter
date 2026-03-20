import React from "react";
import { createRoot } from "react-dom/client";
import { LovableCloudToSupabaseExporterApp } from "./index";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LovableCloudToSupabaseExporterApp />
  </React.StrictMode>,
);
