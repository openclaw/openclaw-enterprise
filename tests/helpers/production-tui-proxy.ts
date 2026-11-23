import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const filename = "https-proxy.mjs";
export const productionTuiProxyCommand = ["node", `/code/${filename}`] as const;

export async function productionTuiProxyData() {
  const source = await readFile(
    new URL("../fixtures/production-tui/https-proxy.ts", import.meta.url),
    "utf8",
  );
  return { [filename]: stripTypeScriptTypes(source) };
}
