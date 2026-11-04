import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { temporaryDirectory } from "./temporary-directory.mjs";

// Load an Installation configuration the way startup does: from the YAML file
// OCC_CONFIG_PATH names. JSON is valid YAML, so the file goes through the same
// parser and closed-schema validation. The file is removed after the test.
// `environment` adds startup variables, such as the chart's listener ports.
export async function loadInstallationFile(
  t,
  configuration,
  { mode = "production", environment = {}, ...options } = {},
) {
  const directory = await temporaryDirectory(t, "occ-installation-");
  const path = join(directory, "installation.yaml");
  await writeFile(path, JSON.stringify(configuration), "utf8");
  return loadInstallationConfiguration({
    ...options,
    mode,
    environment: { ...environment, OCC_CONFIG_PATH: path },
  });
}
