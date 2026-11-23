import type { SpawnSyncReturns } from "node:child_process";

export type GitWorkspaceInput = {
  workspace: string;
  environment: Record<string, string>;
};

const assert: typeof import("node:assert/strict") = process.getBuiltinModule("node:assert/strict");
const { spawnSync } = process.getBuiltinModule("node:child_process");
const fs = process.getBuiltinModule("node:fs");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInput(raw: string | undefined): GitWorkspaceInput {
  assert.ok(typeof raw === "string", "Git workspace input is required");
  const input: unknown = JSON.parse(raw);
  assert.ok(isRecord(input), "Git workspace input must be an object");
  assert.ok(typeof input.workspace === "string", "Git workspace must be a string");
  assert.ok(isRecord(input.environment), "Git environment must be an object");
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.environment)) {
    assert.ok(typeof value === "string", `Git environment value for ${name} must be a string`);
    environment[name] = value;
  }
  return { workspace: input.workspace, environment };
}

const { workspace, environment } = parseInput(process.argv[2]);
const home = "/tmp/git-home";
fs.mkdirSync(home);
fs.chownSync(home, 1000, 1000);
const base = { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1" };

function git(
  path: string,
  args: string[],
  env: Record<string, string> = base,
): SpawnSyncReturns<string> {
  return spawnSync("/usr/bin/git", ["-C", path, ...args], {
    uid: 1000,
    gid: 1000,
    env,
    encoding: "utf8",
  });
}

function assertRefused(path: string, env: Record<string, string> = base): void {
  const refused = git(path, ["rev-parse", "--is-inside-work-tree"], env);
  assert.equal(refused.status, 128);
  assert.match(refused.stderr, /dubious ownership/);
}

// A writable volume root is owned by root, while Git creates .git as the
// Harness user. This is the actual ownership mismatch seen through OpenShell.
const repositories = [workspace, `${workspace}/nested`, "/sandbox/unrelated"];
for (const path of repositories) {
  fs.mkdirSync(path, { recursive: true });
  fs.chownSync(path, 0, 1000);
  fs.chmodSync(path, 0o2775);
  const initialized = git(path, ["init", "--quiet"]);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(fs.statSync(path).uid, 0);
  assert.equal(fs.statSync(`${path}/.git`).uid, 1000);
  assertRefused(path);
}
const configBefore = fs.readFileSync(`${workspace}/.git/config`);
const selected = { ...base, ...environment };
const accepted = git(workspace, ["rev-parse", "--is-inside-work-tree"], selected);
assert.equal(accepted.status, 0, accepted.stderr);
assert.equal(accepted.stdout.trim(), "true");
for (const path of repositories.slice(1)) {
  assertRefused(path, selected);
}
// Verify the configuration Git consumes, including credential/TLS controls
// that must survive Sandbox environment composition.
const expectedConfig: ReadonlyArray<readonly [key: string, expected: string]> = [
  ["safe.directory", workspace],
  ["http.sslVerify", "true"],
  ["http.followRedirects", "false"],
  ["credential.useHttpPath", "true"],
  ["credential.helper", ""],
];
for (const [key, expected] of expectedConfig) {
  const value = git(workspace, ["config", "--get-all", key], selected);
  assert.equal(value.status, 0, key);
  assert.equal(value.stdout.trim(), expected, key);
}
const helpers = git(
  workspace,
  ["config", "--get-regexp", "^credential\\.https://github\\.com.*\\.helper$"],
  selected,
);
assert.equal(helpers.status, 0);
assert.match(helpers.stdout, /password=\$GITHUB_TOKEN/);
assert.deepEqual(fs.readFileSync(`${workspace}/.git/config`), configBefore);
assert.equal(fs.existsSync(`${home}/.gitconfig`), false);
assertRefused(workspace);
console.log("Exact workspace Git trust verified with real ownership mismatch.");
