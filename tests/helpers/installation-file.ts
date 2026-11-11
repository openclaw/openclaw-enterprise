import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

type LoaderOptions = Parameters<typeof loadInstallationConfiguration>[0];
type InstallationFileOptions = Omit<LoaderOptions, "mode"> & Partial<Pick<LoaderOptions, "mode">>;

// Load an Installation configuration the way startup does: from the YAML file
// OCC_CONFIG_PATH names. JSON is valid YAML, so the file goes through the same
// parser and closed-schema validation. The file is removed after the test.
// `environment` adds startup variables, such as the chart's listener ports.
export async function loadInstallationFile(
  t: Parameters<typeof temporaryDirectory>[0],
  configuration: unknown,
  { mode = "production", environment = {}, ...options }: InstallationFileOptions = {},
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
