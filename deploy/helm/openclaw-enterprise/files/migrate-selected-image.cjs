const command = require("./package.json").scripts?.["db:migrate:production"];
const match =
  typeof command === "string" &&
  /^(?:(NODE_ENV=production) )?node (scripts\/migrate-production\.(?:mjs|ts))$/.exec(command);
if (!match) {
  throw new Error("The image does not declare a supported production migration command.");
}
const [, productionMode, entry] = match;
// The production-prefixed declaration shipped with strict option parsing.
// A legacy bare command can silently apply migrations while ignoring any flag.
if (process.argv.length > 1 && productionMode === undefined) {
  throw new Error("The image does not declare support for production migration mode arguments.");
}
process.argv.splice(1, 0, entry);
import("./" + entry);
