const { lstatSync } = require("node:fs") as typeof import("node:fs");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const manifest: unknown = require("./package.json");
const scripts: unknown = isRecord(manifest) ? manifest.scripts : undefined;
const command: unknown = isRecord(scripts) ? scripts["db:bootstrap:production"] : undefined;
const unsupported = "The image does not declare a supported production bootstrap program.";
if (typeof command !== "string") {
  throw new Error(unsupported);
}

let entry: string;
switch (command) {
  case "NODE_ENV=production node scripts/bootstrap-installation.mjs":
    entry = "scripts/bootstrap-installation.mjs";
    break;
  case "NODE_ENV=production node scripts/bootstrap-installation.ts":
    entry = "scripts/bootstrap-installation.ts";
    break;
  default:
    throw new Error(unsupported);
}
if (!lstatSync(entry, { throwIfNoEntry: false })?.isFile()) {
  throw new Error(unsupported);
}
if (typeof process.execve !== "function") {
  throw new Error("The controller image does not support process replacement.");
}
process.execve(process.execPath, [process.execPath, entry], process.env);
