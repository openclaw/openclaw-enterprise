import { writeFile } from "node:fs/promises";
import { renderChartProgram } from "./render-chart-program.ts";

const destination = new URL("../openclaw-enterprise/files/check-installation.mjs", import.meta.url);

export function generateInstallationCheck(): Promise<string> {
  return renderChartProgram(new URL("check-installation.ts", import.meta.url), destination);
}

if (import.meta.main) {
  await writeFile(destination, await generateInstallationCheck());
}
