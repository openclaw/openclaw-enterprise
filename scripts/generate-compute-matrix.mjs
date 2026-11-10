import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeMatrixOptions, runDriverMatrixGenerator } from "./generate-compute-matrix.ts";

export * from "./generate-compute-matrix.ts";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDriverMatrixGenerator(
    computeMatrixOptions,
    "Compute",
    "docs/reference/drivers/compute-matrix.md",
  );
}
