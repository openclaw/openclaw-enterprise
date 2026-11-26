import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { projectFullIntegrationOpenShell } from "./openshell-full-integration.ts";

export function loadTestSuites(path: string, view = "default"): unknown {
  if (view !== "default" && view !== "full-integration") {
    throw new Error("Unknown CI test suite view.");
  }
  const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(manifest)) {
    return manifest;
  }
  const { lanes } = manifest;
  // Leave invalid shapes intact for the runner's existing manifest diagnostics.
  if (!isRecord(lanes)) {
    return manifest;
  }
  for (const [name, lane] of Object.entries(lanes)) {
    if (typeof lane === "string") {
      lanes[name] = JSON.parse(readFileSync(resolve(dirname(path), lane), "utf8"));
    }
  }
  return view === "full-integration"
    ? projectFullIntegrationOpenShell({ ...manifest, lanes })
    : manifest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
