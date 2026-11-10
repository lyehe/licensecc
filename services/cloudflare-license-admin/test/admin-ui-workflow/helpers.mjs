import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadUiModules } from "../../../../test/helpers/ui-modules.mjs";

export async function loadWorkflowModule(relativePath) {
  const [module] = await loadWorkflowModules([relativePath]);
  return module;
}

export async function loadWorkflowModules(relativePaths) {
  const serviceRoot = fileURLToPath(new URL("../../", import.meta.url));
  return await loadUiModules(serviceRoot, relativePaths.map((path) => join("ui", path)));
}
