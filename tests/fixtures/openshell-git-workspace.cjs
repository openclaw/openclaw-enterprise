const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const { workspace, environment } = JSON.parse(process.argv[2]);
const home = "/tmp/git-home";
fs.mkdirSync(home);
fs.chownSync(home, 1000, 1000);
const base = { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
const git = (path, args, env = base) =>
  spawnSync("/usr/bin/git", ["-C", path, ...args], {
    uid: 1000,
    gid: 1000,
    env,
    encoding: "utf8",
  });

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
  const refused = git(path, ["rev-parse", "--is-inside-work-tree"]);
  assert.equal(refused.status, 128);
  assert.match(refused.stderr, /dubious ownership/);
}
const configBefore = fs.readFileSync(`${workspace}/.git/config`);
const selected = { ...base, ...environment };
const accepted = git(workspace, ["rev-parse", "--is-inside-work-tree"], selected);
assert.equal(accepted.status, 0, accepted.stderr);
assert.equal(accepted.stdout.trim(), "true");
for (const path of repositories.slice(1)) {
  const refused = git(path, ["rev-parse", "--is-inside-work-tree"], selected);
  assert.equal(refused.status, 128);
  assert.match(refused.stderr, /dubious ownership/);
}
// Verify the configuration Git consumes, including credential/TLS controls
// that must survive Sandbox environment composition.
for (const [key, expected] of [
  ["safe.directory", workspace],
  ["http.sslVerify", "true"],
  ["http.followRedirects", "false"],
  ["credential.useHttpPath", "true"],
  ["credential.helper", ""],
]) {
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
assert.equal(git(workspace, ["rev-parse", "--is-inside-work-tree"]).status, 128);
console.log("Exact workspace Git trust verified with real ownership mismatch.");
