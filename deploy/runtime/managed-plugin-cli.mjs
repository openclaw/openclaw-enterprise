#!/usr/local/bin/node
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// Each packaged CLI has this launcher in its account-bin directory. Its revision
// configuration contains admitted handles and environment names, never values.
const installation = dirname(dirname(process.argv[1]));
const binary = join(installation, "bin", basename(process.argv[1]));
const { environment, accounts } = JSON.parse(
  readFileSync(join("/tmp/oce-managed-cli", basename(installation) + ".json"), "utf8"),
);
const args = process.argv.slice(2);
const handles = Object.keys(accounts);
const explicit = args[0] === "--oce-account";
let account = handles.length === 1 ? handles[0] : undefined;
if (explicit) {
  account = args.splice(0, 2)[1];
}
if (!account || !Object.hasOwn(accounts, account)) {
  process.stderr.write(
    "Select a bound account with --oce-account from the oce-plugin-accounts skill.\n",
  );
  process.exit(2);
}
const marker = process.env[accounts[account]];
const saved = /^oce:saved-account:([A-Z][A-Z0-9_]*):[0-9a-f]{64}$/.exec(marker ?? "");
const native = /^openshell:resolve:env:s[0-9a-f]{64}_([A-Z][A-Z0-9_]*)$/.exec(marker ?? "");
const selectedEnv = saved?.[1] ?? native?.[1];
if (!selectedEnv || accounts[account] !== "OCE_MANAGED_CLI_" + selectedEnv) {
  process.stderr.write("The selected plugin account is unavailable.\n");
  process.exit(2);
}
// gog gives its native token flag precedence over the environment. A bound
// invocation must use the selected source even when other native flags follow.
const separator = args.indexOf("--");
const options = separator < 0 ? args : args.slice(0, separator);
if (
  basename(installation) === "google" &&
  options.some((arg) => arg === "--access-token" || arg.startsWith("--access-token="))
) {
  process.stderr.write("A bound account supplies the Google access token.\n");
  process.exit(2);
}
const env = { ...process.env, [environment]: marker };
for (const key of Object.keys(env)) {
  if (key.startsWith("OCE_MANAGED_CLI_")) {
    delete env[key];
  }
}
process.execve(binary, [binary, ...args], env);
