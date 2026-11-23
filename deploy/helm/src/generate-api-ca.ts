import { writeFile } from "node:fs/promises";
import { renderChartProgram } from "./render-chart-program.ts";

type ApiCaScript = { filename: string; contents: string };

const programs = ["assemble-api-ca", "check-api-database-ca"] as const;
const chartFiles = new URL("../openclaw-enterprise/files/", import.meta.url);

export async function generateApiCaScripts(): Promise<ApiCaScript[]> {
  return Promise.all(
    programs.map(async (program) => {
      const filename = `${program}.mjs`;
      const contents = await renderChartProgram(
        new URL(`${program}.ts`, import.meta.url),
        new URL(filename, chartFiles),
      );
      return { filename, contents };
    }),
  );
}

if (import.meta.main) {
  for (const { filename, contents } of await generateApiCaScripts()) {
    await writeFile(new URL(filename, chartFiles), contents);
  }
}
