import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runOpenclawSourceCli } from "./openclaw-source.ts";

export * from "./openclaw-source.ts";

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runOpenclawSourceCli();
}
