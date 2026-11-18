const command = require("./package.json").scripts?.["db:migrate:production"];
const entry = /^(?:NODE_ENV=production )?node (scripts\/migrate-production\.(?:mjs|ts))$/.exec(
  command ?? "",
)?.[1];
if (!entry) {
  throw new Error("The image does not declare a supported production migration command.");
}
process.argv.splice(1, 0, entry);
import("./" + entry);
