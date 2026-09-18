import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginMatrixOptions, replaceDriverMatrixMarkdown } from "./generate-compute-matrix.mjs";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some((arg) => arg !== "--check")) {
    throw new Error("Usage: generate-plugin-matrix.mjs [--check]");
  }

  const data = JSON.parse(fs.readFileSync(pluginMatrixOptions.dataPath, "utf8"));
  const target = "docs/reference/drivers/plugin-matrix.md";
  const current = fs.readFileSync(target, "utf8");
  const expected = replaceDriverMatrixMarkdown(current, data, pluginMatrixOptions);

  if (process.argv.includes("--check")) {
    if (current !== expected) {
      throw new Error(
        "Plugin matrix fallback is stale; run node scripts/generate-plugin-matrix.mjs",
      );
    }
    console.log(`Plugin matrix fallback is current (${data.rows.length} rows).`);
  } else {
    fs.writeFileSync(target, expected);
    console.log(`Updated ${target} (${data.rows.length} rows).`);
  }
}
