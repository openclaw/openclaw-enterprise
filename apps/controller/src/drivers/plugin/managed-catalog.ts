import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PluginCatalogEntry } from "@openclaw-enterprise/contracts";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

// Only this package bundled in the controller participates in managed deployment.
const directory = new URL("../../../plugins/oce-google-workspace/", import.meta.url);
const pkg = asRecord(JSON.parse(readFileSync(new URL("plugin.json", directory), "utf8")));
const extension = asRecord(asRecord(pkg?.extensions)?.["ai.openclaw.oce"]);
const policyScope = extension?.policyScope;
if (
  policyScope !== "enablement_only" ||
  extension?.release !== "./ai.openclaw.oce/release.json" ||
  !isNonEmptyString(extension.id) ||
  !isNonEmptyString(extension.displayName) ||
  !isNonEmptyString(pkg?.version) ||
  !isNonEmptyString(pkg?.description)
) {
  throw new Error("Invalid bundled Google Workspace package.");
}
const bytes = readFileSync(new URL(extension.release, directory));
const placement = asRecord(asRecord(JSON.parse(bytes.toString("utf8")))?.placement);
const computeImplementations = placement?.computeImplementations;
if (
  !isNonEmptyString(placement?.harnessId) ||
  !isNonEmptyString(placement?.mode) ||
  !Array.isArray(computeImplementations) ||
  !computeImplementations.every(isNonEmptyString)
) {
  throw new Error("Invalid placement in the bundled Google Workspace release.");
}

export const managedGoogleInstall = {
  id: `${extension.id}@${pkg.version}`,
  policyScope,
  placement: { harnessId: placement.harnessId, mode: placement.mode, computeImplementations },
  releaseSha256: createHash("sha256").update(bytes).digest("hex"),
} as const;

export const googlePackage = {
  id: managedGoogleInstall.id,
  name: extension.displayName,
  description: pkg.description,
  selectableWithoutTools: true,
  tools: [],
} satisfies PluginCatalogEntry;
