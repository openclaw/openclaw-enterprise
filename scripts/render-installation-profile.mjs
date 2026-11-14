#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInstallationProfileCli } from "./render-installation-profile.ts";

export { RenderRefusal, renderInstallationProfile } from "./render-installation-profile.ts";

// Keep the public CLI and import path, including execution through a symlink.
function startedAsEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
if (import.meta.main ?? startedAsEntryPoint()) {
  await runInstallationProfileCli();
}
