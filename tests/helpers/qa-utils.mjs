import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

export const { loadYaml, dumpYaml } = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
)("@kubernetes/client-node");

export function yamlDocuments(text) {
  return text
    .split(/^---\s*$/m)
    .filter((document) =>
      document.split("\n").some((line) => line.trim() && !line.trim().startsWith("#")),
    );
}

// `describe` reports the last state `observe` saw (kept by the caller), so a
// timeout says what was still missing instead of only what was awaited. `now`
// lets a test drive the deadline with its own clock.
export async function waitFor(
  description,
  observe,
  timeout = 300_000,
  { describe, interval = 1000, now = () => Date.now() } = {},
) {
  const deadline = now() + timeout;
  while (now() < deadline) {
    const result = await observe();
    if (result) {
      return result;
    }
    await delay(interval);
  }
  let detail = "";
  if (describe) {
    try {
      detail = `; last observation: ${describe()}`;
    } catch (error) {
      detail = `; last observation unavailable (${error?.message ?? error})`;
    }
  }
  throw new Error(`Timed out: ${description}${detail}`);
}
