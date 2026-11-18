const { lstatSync } = require("node:fs");
const command = require("./package.json").scripts?.["db:bootstrap:production"];
const entry = /^NODE_ENV=production node (scripts\/bootstrap-installation\.(?:mjs|ts))$/.exec(
  command ?? "",
)?.[1];
if (!entry || !lstatSync(entry, { throwIfNoEntry: false })?.isFile()) {
  throw new Error("The image does not declare a supported production bootstrap program.");
}
process.execve(process.execPath, [process.execPath, entry], process.env);
