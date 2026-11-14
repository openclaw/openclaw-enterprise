import type { bundledExport, loadCodexConfig } from "./bundled-codex.ts";
import type { parseJson, record } from "./wire.ts";

export async function probeBrokerConfig(
  load: typeof bundledExport,
  loadConfig: typeof loadCodexConfig,
  parse: typeof parseJson,
  read: typeof record,
) {
  const { readFileSync } = await import("node:fs");
  const runtime = read(parse(readFileSync(0, "utf8")));
  const resolve = await loadConfig(load, read, false);
  const { networkProxy } = resolve({ pluginConfig: runtime.brokerCodexConfiguration });
  const allowPatch = read(networkProxy).configPatch;
  if (allowPatch === undefined) {
    throw new Error("Codex network proxy config patch was not generated.");
  }
  process.stdout.write(JSON.stringify({ allowPatch }));
}
