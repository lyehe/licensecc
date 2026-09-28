import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App";
import { WorkspaceErrorBoundary } from "./app/WorkspaceErrorBoundary";

createRoot(document.getElementById("root") as HTMLElement).render(
  <WorkspaceErrorBoundary name="console" active><App /></WorkspaceErrorBoundary>,
);
