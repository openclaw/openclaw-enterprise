import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// A workflow-scoped materializer: no secrets are written into the checkout,
// test results, command arguments, or the environment file itself.
const directory = join(process.env.RUNNER_TEMP, "qa-matrix-credentials");
await mkdir(directory, { mode: 0o700 });
const mapping = {
  OPENAI_API_KEY: ["openai", "OCC_TEST_QA_OPENAI_KEY_FILE"],
  CODEX_ACCESS_TOKEN: ["codex", "OCC_TEST_QA_CODEX_TOKEN_FILE"],
  SLACK_APP_TOKEN: ["slack-app", "OCC_TEST_QA_SLACK_APP_TOKEN_FILE"],
  SLACK_BOT_TOKEN: ["slack-bot", "OCC_TEST_QA_SLACK_BOT_TOKEN_FILE"],
  SLACK_SENDER_TOKEN: ["slack-sender", "OCC_TEST_QA_SLACK_SENDER_TOKEN_FILE"],
  REPOSITORY_OBSERVER_TOKEN: ["observer", "OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE"],
};
const entries = [];
for (const [source, [filename, target]] of Object.entries(mapping)) {
  assert.ok(process.env[source], `${source} is required`);
  const path = join(directory, filename);
  await writeFile(path, process.env[source], { mode: 0o600, flag: "wx" });
  entries.push(`${target}=${path}`);
}
const repository = join(directory, "repository");
await mkdir(repository, { mode: 0o700 });
for (const [source, name] of [
  ["REPOSITORY_REGISTRY_JSON", "registry.json"],
  ["REPOSITORY_APP_KEY", "private-key.pem"],
  ["REPOSITORY_UPSTREAM_CIDRS_JSON", "upstream-cidrs.json"],
]) {
  assert.ok(process.env[source], `${source} is required`);
  await writeFile(join(repository, name), process.env[source], { mode: 0o600, flag: "wx" });
}
entries.push(`OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY=${repository}`);
entries.push(`OCC_TEST_QA_ARTIFACTS=${join(process.env.RUNNER_TEMP, "qa-matrix-evidence")}`);
await appendFile(process.env.GITHUB_ENV, entries.join("\n") + "\n");
