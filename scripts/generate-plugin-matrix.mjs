import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginMatrixOptions, runDriverMatrixGenerator } from "./generate-compute-matrix.ts";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDriverMatrixGenerator(
    pluginMatrixOptions,
    "Plugin",
    "docs/reference/drivers/plugin-matrix.md",
  );
}
