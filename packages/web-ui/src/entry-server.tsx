import React from "react";
import { renderToString } from "react-dom/server";

import { LovableCloudToSupabaseExporterApp } from "./index";

export function render() {
  return renderToString(<LovableCloudToSupabaseExporterApp />);
}
