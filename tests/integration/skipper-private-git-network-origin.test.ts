import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { startSkipperPrivateGitOrigin } from "../fixtures/skipper-private-git-origin.mjs";
import {
  cleanEnvironment,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.ts";

test("private Git network origin accepts only its broad fixture credential across three repositories", async (t) => {
  const origin = await startSkipperPrivateGitOrigin({ repository: "fixture/a", networkAcl: true });
  t.after(() => origin.close());
  const network = origin.network;
  assert.ok(network?.token);
  const token = network.token;
  const directory = await temporaryDirectory(t, "git-network-origin-client-");
  const ca = join(directory, "ca.pem");
  await writeFile(ca, origin.tls.ca);
  const environment = (token: string) =>
    cleanEnvironment({
      HOME: directory,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_SSL_CAINFO: ca,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "maintenance.auto",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "http.extraHeader",
      GIT_CONFIG_VALUE_1: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    });
  const git = (args: string[], credential = token, allowFailure = false) =>
    run("git", args, { cwd: directory, env: environment(credential), allowFailure });
  for (const name of ["a", "b", "c"]) {
    await git(["clone", `${origin.origin}/fixture/${name}.git`, name]);
  }
  await git(["-C", "a", "push", "origin", "HEAD:refs/heads/approved"]);
  await git(["-C", "c", "push", "origin", "HEAD:refs/heads/control"]);
  assert.equal(await network.ref("fixture/a", "refs/heads/approved"), origin.initialSha);
  assert.equal(await network.ref("fixture/c", "refs/heads/control"), origin.initialSha);
  assert.equal(await network.hasObject("fixture/c", origin.initialSha), true);
  const rejected = await git(
    ["ls-remote", `${origin.origin}/fixture/a.git`],
    "openshell:resolve:env:GITHUB_TOKEN",
    true,
  );
  assert.notEqual(rejected.code, 0);
  assert.ok(
    network.requests().some((request: { authenticated: boolean }) => request.authenticated),
  );
  assert.equal(network.requests().at(-1)?.authenticated, false);
});
