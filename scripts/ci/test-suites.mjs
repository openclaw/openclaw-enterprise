import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { projectFullIntegrationOpenShell } from "./openshell-full-integration.ts";

export function loadTestSuites(path, view = "default") {
  if (view !== "default" && view !== "full-integration") {
    throw new Error("Unknown CI test suite view.");
  }
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const lanes = manifest?.lanes;
  // Leave invalid shapes intact for the runner's existing manifest diagnostics.
  if (lanes === null || typeof lanes !== "object" || Array.isArray(lanes)) {
    return manifest;
  }
  for (const [name, lane] of Object.entries(lanes)) {
    if (typeof lane === "string") {
      lanes[name] = JSON.parse(readFileSync(resolve(dirname(path), lane), "utf8"));
    }
  }
  return view === "full-integration" ? projectFullIntegrationOpenShell(manifest) : manifest;
}
