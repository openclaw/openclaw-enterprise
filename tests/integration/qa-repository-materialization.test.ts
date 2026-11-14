import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { selectQaMatrix, validateQaInputs } from "../helpers/qa-selection.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

import { array, jsonRecord, record, text } from "./full-integration-json-fixture.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function qaRegistry(repositories: string[]) {
  return JSON.stringify({
    version: 1,
    backendId: "github",
    providerInstanceId: "github-fixture-instance",
    appId: "123",
    githubInstallationId: "456",
    maximumDurationSeconds: 3600,
    repositories: repositories.map((repository, index) => ({
      repositoryRef: `repo-${index}`,
      repositoryId: String(index + 1),
      repository,
      namespaces: [{ namespaceId: "ns_test", profiles: ["git-read", "git-full"] }],
    })),
  });
}

test("hosted repository egress selects only public GitHub API and Git IPv4 networks", () => {
  const meta = {
    api: ["140.82.112.0/20", "2606:50c0::/32"],
    git: ["140.82.112.0/20", "20.201.28.148/32"],
    actions: ["4.0.0.0/8"],
  };
  function select(metadata: { api: string[]; git: string[] | undefined; actions: string[] }) {
    return spawnSync("python3", ["scripts/ci/github-repository-egress.py"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      input: JSON.stringify(metadata),
    });
  }
  const result = select(meta);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    githubApiAndGit: ["140.82.112.0/20", "20.201.28.148/32"],
  });
  for (const git of [
    undefined,
    [],
    ["2606:50c0::/32"],
    ["0.0.0.0/0"],
    ["172.0.0.0/8"],
    ["140.82.112.3/20"],
  ]) {
    const invalid = select({ ...meta, git });
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.stdout, "");
  }
});

async function runQaCredentialMaterializer(
  t: TestContext,
  overrides: NodeJS.ProcessEnv = {},
  registry = qaRegistry(["openclaw/openclaw-enterprise"]),
) {
  const directory = await temporaryDirectory(t, "qa-credentials-");
  const githubEnv = join(directory, "github-env");
  const registryFile = join(directory, "reviewed-registry.json");
  await writeFile(registryFile, registry, { mode: 0o600 });
  await writeFile(
    join(directory, "github-repository-egress.json"),
    JSON.stringify({
      githubApiAndGit: ["140.82.112.0/20"],
    }),
  );
  const env = {
    RUNNER_TEMP: directory,
    GITHUB_ENV: githubEnv,
    GITHUB_REPOSITORY: "openclaw/openclaw-enterprise",
    OPENAI_API_KEY: "synthetic-openai-key",
    CODEX_ACCESS_TOKEN: "synthetic-codex-token",
    SLACK_APP_TOKEN: "synthetic-slack-app-token",
    SLACK_BOT_TOKEN: "synthetic-slack-bot-token",
    SLACK_SENDER_TOKEN: "synthetic-slack-sender-token",
    OCC_TEST_QA_SLACK_CHANNEL_ID: "C0123456789",
    OCC_TEST_QA_REPOSITORY_AUTHORIZED: "1",
    REPOSITORY_REGISTRY_FILE: registryFile,
    REPOSITORY_APP_KEY: "synthetic-private-key",
    ...overrides,
  };
  const result = spawnSync(globalThis.process.execPath, ["scripts/ci/qa-matrix-credentials.mjs"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env,
  });
  return { ...result, directory, githubEnv, registryFile };
}

test("QA credential materializer reads reviewed registry files only for repository scenarios", async (t) => {
  const registryFile = "scripts/ci/qa-repositories/default.json";
  const registry = await readFile(join(repositoryRoot, registryFile), "utf8");
  const result = await runQaCredentialMaterializer(t, { REPOSITORY_REGISTRY_FILE: registryFile });
  assert.equal(result.status, 0, result.stderr);
  const exported = await readFile(result.githubEnv, "utf8");
  assert.match(exported, /OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY=/);
  assert.match(exported, /OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY=/);
  assert.doesNotMatch(exported, /OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE=/);
  const repository = join(result.directory, "qa-matrix-credentials", "repository");
  assert.equal(await readFile(join(repository, "registry.json"), "utf8"), registry);
  assert.deepEqual(JSON.parse(await readFile(join(repository, "upstream-cidrs.json"), "utf8")), {
    githubApiAndGit: ["140.82.112.0/20"],
  });
  assert.equal(
    await readFile(join(repository, "private-key.pem"), "utf8"),
    "synthetic-private-key",
  );
  assert.equal((await stat(join(repository, "registry.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(repository, "private-key.pem"))).mode & 0o777, 0o600);
  assert.doesNotMatch(exported, /synthetic-private-key|fixture-owner/);

  // Invalid inputs stop materialization without copying their contents into errors.
  for (const [overrides, contents, error] of [
    [{ REPOSITORY_REGISTRY_FILE: undefined }, registry, /REPOSITORY_REGISTRY_FILE is required/],
    [
      { REPOSITORY_REGISTRY_FILE: join(result.directory, "missing.json") },
      registry,
      /REPOSITORY_REGISTRY_FILE must name a readable file/,
    ],
    [{}, "{synthetic-private-key", /REPOSITORY_REGISTRY_FILE must contain valid JSON/],
    [{}, "[]", /REPOSITORY_REGISTRY_FILE must contain an object/],
    [{}, "{}", /repository registry must contain repositories/],
  ] as const) {
    const failure = await runQaCredentialMaterializer(t, overrides, contents);
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, error);
    assert.doesNotMatch(failure.stderr, /synthetic-private-key/);
  }

  // Model-only advisory runs need no repository metadata or App key.
  const noRepository = await runQaCredentialMaterializer(t, {
    OCC_TEST_QA_PRESET: "OpenClaw",
    OCC_TEST_QA_SCENARIOS: "model-ui",
    REPOSITORY_REGISTRY_FILE: undefined,
    REPOSITORY_APP_KEY: undefined,
    QA_REPOSITORY_FIXTURE: "isolated",
  });
  assert.equal(noRepository.status, 0, noRepository.stderr);
  assert.doesNotMatch(
    await readFile(noRepository.githubEnv, "utf8"),
    /OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY/,
  );
});

test("QA credential materializer validates isolated repository fixture target", async (t) => {
  const registryFile = "scripts/ci/qa-repositories/isolated.json";
  const registry = await readFile(join(repositoryRoot, registryFile), "utf8");
  const target = text(record(array(jsonRecord(registry).repositories)[0]).repository);
  const success = await runQaCredentialMaterializer(t, {
    QA_REPOSITORY_FIXTURE: "isolated",
    QA_ISOLATED_REPOSITORY_FULL_NAME: target,
    REPOSITORY_REGISTRY_FILE: registryFile,
    REPOSITORY_APP_KEY: "synthetic-isolated-private-key",
  });
  assert.equal(success.status, 0, success.stderr);
  const repository = join(success.directory, "qa-matrix-credentials", "repository");
  assert.equal(await readFile(join(repository, "registry.json"), "utf8"), registry);
  assert.equal(
    await readFile(join(repository, "private-key.pem"), "utf8"),
    "synthetic-isolated-private-key",
  );
  const exported = await readFile(success.githubEnv, "utf8");
  assert.match(exported, /OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY=/);
  assert.match(exported, /OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY=/);
  assert.match(exported, /QA_REPOSITORY_FIXTURE=isolated/);
  assert.doesNotMatch(exported, /OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE=/);
  assert.doesNotMatch(exported, /synthetic-observer-token|synthetic-isolated-private-key/);
  const runnerEnv = Object.fromEntries(
    exported
      .trim()
      .split("\n")
      .map((line) => {
        const [name = "", value] = line.split(/=(.*)/s);
        return [name, value] as const;
      }),
  );
  const runnerSelection = selectQaMatrix({
    ...runnerEnv,
    OCC_TEST_QA_SCENARIOS: "git-write",
    OCC_TEST_QA_GITHUB_OBSERVER_BINARY: "gh",
    OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE: "/private/static-token",
  });
  const requiredEnv: readonly string[] = runnerSelection.requiredEnv;
  assert.ok(requiredEnv.includes("OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY"));
  assert.ok(!requiredEnv.includes("OCC_TEST_QA_GITHUB_OBSERVER_BINARY"));
  assert.ok(!requiredEnv.includes("OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE"));
  assert.doesNotThrow(() =>
    validateQaInputs(runnerSelection, {
      ...runnerEnv,
      OCC_TEST_QA_REPOSITORY_AUTHORIZED: "1",
    }),
  );

  const missingTarget = await runQaCredentialMaterializer(
    t,
    {
      QA_REPOSITORY_FIXTURE: "isolated",
    },
    qaRegistry([target]),
  );
  assert.notEqual(missingTarget.status, 0);
  assert.match(missingTarget.stderr, /QA_ISOLATED_REPOSITORY_FULL_NAME is required/);

  const wrongTarget = await runQaCredentialMaterializer(
    t,
    {
      QA_REPOSITORY_FIXTURE: "isolated",
      QA_ISOLATED_REPOSITORY_FULL_NAME: target,
    },
    qaRegistry(["fixture-owner/other-repo"]),
  );
  assert.notEqual(wrongTarget.status, 0);
  assert.match(wrongTarget.stderr, /must match QA_ISOLATED_REPOSITORY_FULL_NAME/);

  const multipleRepositories = await runQaCredentialMaterializer(
    t,
    {
      QA_REPOSITORY_FIXTURE: "isolated",
      QA_ISOLATED_REPOSITORY_FULL_NAME: target,
    },
    qaRegistry([target, "fixture-owner/other-repo"]),
  );
  assert.notEqual(multipleRepositories.status, 0);
  assert.match(multipleRepositories.stderr, /exactly one repository/);

  const workflowRepository = await runQaCredentialMaterializer(t, {
    QA_REPOSITORY_FIXTURE: "isolated",
    QA_ISOLATED_REPOSITORY_FULL_NAME: "openclaw/openclaw-enterprise",
    REPOSITORY_REGISTRY_FILE: registryFile,
  });
  assert.notEqual(workflowRepository.status, 0);
  assert.match(workflowRepository.stderr, /must not target this workflow repository/);
});
