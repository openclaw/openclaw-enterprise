import { readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";

type ApiCaScript = { filename: string; contents: string };

const programs = ["assemble-api-ca", "check-api-database-ca"] as const;
const chartFiles = new URL("../openclaw-enterprise/files/", import.meta.url);

export async function generateApiCaScripts(): Promise<ApiCaScript[]> {
  return Promise.all(
    programs.map(async (program) => {
      const filename = `${program}.mjs`;
      const filepath = fileURLToPath(new URL(filename, chartFiles));
      const source = await readFile(new URL(`${program}.ts`, import.meta.url), "utf8");
      // Type stripping leaves padding. Format the JavaScript with the repository's settings.
      const options = await resolveConfig(filepath);
      const contents = await format(stripTypeScriptTypes(source), { ...options, filepath });
      return { filename, contents };
    }),
  );
}

if (import.meta.main) {
  for (const { filename, contents } of await generateApiCaScripts()) {
    await writeFile(new URL(filename, chartFiles), contents);
  }
}
