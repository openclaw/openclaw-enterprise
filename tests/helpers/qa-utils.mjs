import { createRequire } from "node:module";
import { createServer } from "node:net";
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

export async function waitFor(description, observe, timeout = 300_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await observe();
    if (result) {
      return result;
    }
    await delay(1000);
  }
  throw new Error(`Timed out: ${description}`);
}

export async function unusedPort() {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const port = server.address().port;
  await new Promise((accept) => server.close(accept));
  return port;
}
