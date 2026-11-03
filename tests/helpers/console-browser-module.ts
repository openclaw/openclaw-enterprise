import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { consoleAssetPaths, readConsoleAsset } from "../../apps/controller/src/console-assets.ts";

interface ConsoleModules {
  "agents/credentials.mjs": typeof import("../../apps/controller/src/console/agents/credentials.mts");
  "agents/deletion.mjs": typeof import("../../apps/controller/src/console/agents/deletion.mts");
  "agents/deployment-evidence.mjs": typeof import("../../apps/controller/src/console/agents/deployment-evidence.mts");
  "agents/detail.mjs": typeof import("../../apps/controller/src/console/agents/detail.mts");
  "agents/gateway-safety.mjs": typeof import("../../apps/controller/src/console/agents/gateway-safety.mts");
  "agents/list.mjs": typeof import("../../apps/controller/src/console/agents/list.mts");
  "agents/secret-picker.mjs": typeof import("../../apps/controller/src/console/agents/secret-picker.mts");
  "agents/workspace.mjs": typeof import("../../apps/controller/src/console/agents/workspace.mts");
  "api-client.mjs": typeof import("../../apps/controller/src/console/api-client.mts");
  "channels/slack.mjs": typeof import("../../apps/controller/src/console/channels/slack.mts");
  "namespaces.mjs": typeof import("../../apps/controller/src/console/namespaces.mts");
  "secrets.mjs": typeof import("../../apps/controller/src/console/secrets.mts");
  "stored-configuration-rules.mjs": typeof import("../../packages/occ/src/stored-configuration-rules.ts");
}

let browserModules: Promise<string> | undefined;

async function materializeConsoleModules() {
  const directory = await mkdtemp(join(tmpdir(), "oce-test-console-modules-"));
  try {
    // This preset is generated on request by the asset reader, outside the static registry.
    const paths = [...consoleAssetPaths(), "/console/default-codex-preset.mjs"];
    for (const pathname of paths) {
      if (!pathname.endsWith(".mjs")) {
        continue;
      }
      const asset = await readConsoleAsset(pathname);
      if (asset.statusCode !== 200) {
        throw new Error(`Could not read Console module ${pathname}: ${asset.statusCode}`);
      }
      const destination = join(directory, pathname.slice("/console/".length));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, asset.body);
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// The overload binds each allowed browser URL to the source that the asset reader serves there.
// All imports share one output directory so Node preserves the graph's module identities.
export function importConsoleModule<Path extends keyof ConsoleModules>(
  path: Path,
): Promise<ConsoleModules[Path]>;
export async function importConsoleModule(path: keyof ConsoleModules): Promise<unknown> {
  const directory = await (browserModules ??= materializeConsoleModules());
  const module: unknown = await import(pathToFileURL(join(directory, path)).href);
  return module;
}
