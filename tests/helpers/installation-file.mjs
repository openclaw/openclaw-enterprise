import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";

// Load an Installation configuration the way startup does: from the YAML file
// OCC_CONFIG_PATH names. JSON is valid YAML, so the file goes through the same
// parser and closed-schema validation. The file is removed after the test.
// `environment` adds startup variables, such as the chart's listener ports.
export async function loadInstallationFile(
  t,
  configuration,
  { mode = "production", environment = {}, ...options } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "occ-installation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "installation.yaml");
  await writeFile(path, JSON.stringify(configuration), "utf8");
  return loadInstallationConfiguration({
    ...options,
    mode,
    environment: { ...environment, OCC_CONFIG_PATH: path },
  });
}
