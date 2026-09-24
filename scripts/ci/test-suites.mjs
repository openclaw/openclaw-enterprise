import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function loadTestSuites(path) {
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
  return manifest;
}
