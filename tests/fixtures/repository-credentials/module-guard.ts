import { registerHooks, syncBuiltinESMExports } from "node:module";
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";

// A parent-owned receipt survives application code catching a denied import.
const loadReceipt = process.env.CREDENTIAL_TEST_LOAD_RECEIPT;
if (loadReceipt) {
  appendFileSync(loadReceipt, "guard-active\n");
}
function recordForbidden(url: string) {
  if (loadReceipt) {
    appendFileSync(loadReceipt, `${url}\n`);
  }
}

const open = fs.open;
fs.open = (...args) => {
  if (args[0] === process.env.CREDENTIAL_TEST_TOKEN_FILE) {
    process.stderr.write("credential-test-token-open\n");
  }
  return open(...args);
};
syncBuiltinESMExports();

// Exercise the emitted entrypoints without letting a prepared sender load
// development authority or worker signing implementations.
registerHooks({
  load(url, context, nextLoad) {
    if (
      /\/credentials\/(custody|lifecycle)\.js$/.test(url) &&
      process.env.CREDENTIAL_TEST_DEVELOPMENT !== "1"
    ) {
      recordForbidden(url);
      throw new Error(`unexpected development construction: ${url}`);
    }
    const name = url.split("/drivers/repo/github/credentials/")[1];
    const development = ["factory.js", "driver.js", "static-token.js"];
    const worker = [
      "material.js",
      "prepared-owner.js",
      "prepared-lifecycle.js",
      "provider-transport.js",
    ];
    if (
      name &&
      (worker.includes(name) ||
        (development.includes(name) && process.env.CREDENTIAL_TEST_DEVELOPMENT !== "1"))
    ) {
      recordForbidden(url);
      process.stderr.write(`blocked credential implementation: ${name}\n`);
      throw new Error(`unexpected credential implementation: ${name}`);
    }
    return nextLoad(url, context);
  },
});
