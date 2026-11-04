import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { selectQaMatrix, validateQaInputs } from "../../tests/helpers/qa-selection.mjs";

const selection = selectQaMatrix();

const repositoryPattern = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9._-]{0,99}$/;

function validateRepositoryFixture() {
  const fixture = process.env.QA_REPOSITORY_FIXTURE ?? "default";
  assert.ok(
    fixture === "default" || fixture === "isolated",
    "QA_REPOSITORY_FIXTURE must be default or isolated",
  );
  if (fixture !== "isolated") {
    return;
  }

  const target = process.env.QA_ISOLATED_REPOSITORY_FULL_NAME;
  assert.ok(target, "QA_ISOLATED_REPOSITORY_FULL_NAME is required");
  assert.match(
    target,
    repositoryPattern,
    "QA_ISOLATED_REPOSITORY_FULL_NAME must be a lowercase owner/repository name",
  );
  assert.notEqual(
    target,
    process.env.GITHUB_REPOSITORY?.toLowerCase(),
    "isolated QA repository fixture must not target this workflow repository",
  );

  let registry;
  try {
    registry = JSON.parse(process.env.REPOSITORY_REGISTRY_JSON ?? "");
  } catch {
    throw new Error("REPOSITORY_REGISTRY_JSON must be valid JSON");
  }
  assert.ok(
    registry !== null && typeof registry === "object" && !Array.isArray(registry),
    "REPOSITORY_REGISTRY_JSON must be an object",
  );
  assert.ok(Array.isArray(registry.repositories), "repository registry must contain repositories");
  assert.equal(
    registry.repositories.length,
    1,
    "isolated QA repository registry must contain exactly one repository",
  );
  assert.equal(
    registry.repositories[0]?.repository,
    target,
    "isolated QA repository registry must match QA_ISOLATED_REPOSITORY_FULL_NAME",
  );
}

// A workflow-scoped materializer: no secrets are written into the checkout,
// test results, command arguments, or the environment file itself.
const repositoryFixture = process.env.QA_REPOSITORY_FIXTURE ?? "default";
validateRepositoryFixture();
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
  if (!selection.requiredEnv.includes(target)) {
    continue;
  }
  assert.ok(process.env[source], `${source} is required`);
  const path = join(directory, filename);
  await writeFile(path, process.env[source], { mode: 0o600, flag: "wx" });
  entries.push(`${target}=${path}`);
}
if (selection.repository) {
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
  if (repositoryFixture === "isolated") {
    entries.push("QA_REPOSITORY_FIXTURE=isolated");
    entries.push(`OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY=${repository}`);
  }
}
entries.push(`OCC_TEST_QA_ARTIFACTS=${join(process.env.RUNNER_TEMP, "qa-matrix-evidence")}`);
validateQaInputs(selection, {
  ...process.env,
  ...Object.fromEntries(
    entries.map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  ),
});
await appendFile(process.env.GITHUB_ENV, entries.join("\n") + "\n");
