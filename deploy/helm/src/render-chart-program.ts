import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";

export async function renderChartProgram(source: URL, destination: URL): Promise<string> {
  const filepath = fileURLToPath(destination);
  const typescript = await readFile(source, "utf8");
  // Type stripping leaves padding. Format the JavaScript with the repository's settings.
  const options = await resolveConfig(filepath);
  return format(stripTypeScriptTypes(typescript), { ...options, filepath });
}
