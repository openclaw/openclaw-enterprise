import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { request } from "node:https";
import test from "node:test";
import { startSkipperPrivateGitOrigin } from "../fixtures/skipper-private-git-origin.mjs";
import {
  cleanEnvironment,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.ts";
import { createGitAclDenialCommand } from "../helpers/openshell-git-denial.ts";

const alias = `openshell:resolve:env:s${"0".repeat(64)}_GITHUB_TOKEN`;

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
  await network.clearRef("fixture/a", "refs/heads/approved");
  assert.equal(await network.ref("fixture/a", "refs/heads/approved"), undefined);
  const beforeAlias = network.requests().length;
  const rejected = await git(["ls-remote", `${origin.origin}/fixture/a.git`], alias, true);
  assert.notEqual(rejected.code, 0);
  const aliasRequests = network.requests().slice(beforeAlias);
  assert.ok(aliasRequests.length > 0);
  assert.ok(
    aliasRequests.every(
      (entry: { repository: string; authenticated: boolean }) =>
        entry.repository === "fixture/a" && !entry.authenticated,
    ),
  );

  // A real fast-forward remains distinguishable from a denied update and from
  // a no-op. The fixture must observe both the ref and the transferred object.
  const approved = "refs/heads/approved";
  await git(["-C", "b", "push", "origin", `HEAD:${approved}`]);
  await git([
    "-C",
    "b",
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "Fast-forward candidate",
  ]);
  const candidate = (await git(["-C", "b", "rev-parse", "HEAD"])).stdout.trim();
  assert.notEqual(candidate, origin.initialSha);
  assert.equal(await network.hasObject("fixture/b", candidate), false);
  const beforeDeniedPush = network.requests().length;
  const push = ["-C", "b", "push", "origin", `HEAD:${approved}`];
  const deniedPush = await git(push, alias, true);
  assert.notEqual(deniedPush.code, 0);
  const deniedRequests = network.requests().slice(beforeDeniedPush);
  assert.ok(deniedRequests.length > 0);
  assert.ok(deniedRequests.every((entry: { authenticated: boolean }) => !entry.authenticated));
  assert.equal(await network.ref("fixture/b", approved), origin.initialSha);
  assert.equal(await network.hasObject("fixture/b", candidate), false);
  await git(push);
  assert.equal(await network.ref("fixture/b", approved), candidate);
  assert.equal(await network.hasObject("fixture/b", candidate), true);

  const http = (path: string, method: string, body?: string) =>
    new Promise<{ status: number; type: string | undefined }>((resolve, reject) => {
      const req = request(
        new URL(path, origin.origin),
        {
          method,
          ca: origin.tls.ca,
          headers: {
            authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
            ...(body === undefined
              ? {}
              : { "content-type": "application/x-git-receive-pack-request" }),
          },
        },
        (response) => {
          response.resume();
          response.once("end", () =>
            resolve({ status: response.statusCode!, type: response.headers["content-type"] }),
          );
        },
      );
      req.once("error", reject);
      req.end(body);
    });
  assert.deepEqual(await http("/fixture/a.git/info/refs?service=git-upload-pack", "GET"), {
    status: 200,
    type: "application/x-git-upload-pack-advertisement",
  });
  assert.deepEqual(await http("/fixture/b.git/git-receive-pack", "POST", "0000"), {
    status: 200,
    type: "application/x-git-receive-pack-result",
  });
  const beforeUnknown = network.unknownRequests();
  const beforeKnown = network.requests().length;
  await http("/unrecognized-sensitive-path?service=unrecognized-sensitive-value", "GET");
  assert.equal(network.unknownRequests(), beforeUnknown + 1);
  assert.equal(network.requests().length, beforeKnown);
  for (const observation of network.requests()) {
    assert.deepEqual(Object.keys(observation).sort(), [
      "authenticated",
      "method",
      "operation",
      "repository",
    ]);
  }
  // A missing repository is an observation failure, not proof the forbidden ref is absent.
  await origin.close();
  await assert.rejects(network.ref("fixture/a", "refs/heads/approved"), /Git ref lookup failed/u);
  await assert.rejects(network.hasObject("fixture/b", candidate), /Git object lookup failed/u);
});

test("guest Git ACL denials screen both streams before classification", async (t) => {
  const token = randomBytes(32).toString("hex");
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  const denialCommand = createGitAclDenialCommand(token);
  const directory = await temporaryDirectory(t, "git-acl-denial-output-");
  const payload = join(directory, "process-output.json");
  const path = "/fixture/c.git/info/refs";
  const rest = {
    error: "policy_denied",
    layer: "l7",
    protocol: "rest",
    method: "GET",
    path,
    host: "github.com",
    port: 443,
    rule_missing: { type: "rest_allow", layer: "l7", method: "GET", path },
  };
  const fatal = "fatal: unable to access fixture: The requested URL returned error: 403\n";
  const footer = "\n403 application/json\n";
  const check = async (
    denial: Parameters<typeof denialCommand>[0],
    status: number,
    stdout: string,
    stderr: string,
    expected: { code: number; stdout: string; stderr: string },
  ) => {
    // Provide invented producer bytes via a private file. The real guest
    // checker gets only fingerprints, the command vector, and the route.
    await writeFile(payload, JSON.stringify({ status, stdout, stderr }), { mode: 0o600 });
    const result = await run(
      "sh",
      [
        "-ceu",
        'exec "$@"',
        "--",
        ...denialCommand(denial, [
          process.execPath,
          "--eval",
          'const fs = require("node:fs"); const { status, stdout, stderr } = JSON.parse(fs.readFileSync(process.argv[1])); fs.writeFileSync(1, stdout); fs.writeFileSync(2, stderr); process.exitCode = status;',
          "--",
          payload,
        ]),
      ],
      {
        cwd: directory,
        env: cleanEnvironment({
          GITHUB_TOKEN: alias,
          PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
        }),
        allowFailure: true,
        signal: t.signal,
      },
    );
    const { code, stdout: projected, stderr: diagnostic } = result;
    assert.ok(!projected.includes(token) && !diagnostic.includes(token), "raw credential escaped");
    assert.ok(
      !projected.includes(basic) && !diagnostic.includes(basic),
      "Basic credential escaped",
    );
    assert.equal(code, expected.code, "guest command status");
    assert.ok(projected === expected.stdout, "guest command stdout");
    assert.ok(diagnostic === expected.stderr, "guest command diagnostic");
  };
  const refused = (diagnostic: string) => ({ code: 1, stdout: "", stderr: diagnostic + "\n" });
  const exposed = refused("ACL_CREDENTIAL_IN_OUTPUT");
  const incomplete = refused("ACL_DENIAL_CAPTURE");
  const git = { kind: "git" } as const;
  await check(git, 128, "", fatal, { code: 0, stdout: "403 native-git\n", stderr: "" });
  await check(git, 128, "", "", refused("ACL_NATIVE_HTTP"));
  await check(git, 0, "", fatal, refused("ACL_NATIVE_UNEXPECTED_SUCCESS"));
  await check(git, 0, `prefix=${token};suffix\n`, fatal, exposed);
  await check(git, 128, `prefix=${basic};suffix\n`, fatal, exposed);
  await check(git, 128, "", `${fatal}prefix=${token};suffix\n`, exposed);
  await check(git, 128, "", `${fatal}prefix=${basic};suffix\n`, exposed);
  await check(git, 128, "", fatal + "x".repeat(8192), incomplete);

  const curl = { kind: "rest", method: "GET", path, host: "github.com" } as const;
  const valid = JSON.stringify(rest) + footer;
  await check(curl, 0, valid, "", { code: 0, stdout: "403 native-rest-policy\n", stderr: "" });
  await check(
    curl,
    0,
    JSON.stringify({ ...rest, extra: `prefix=${token};suffix` }) + footer,
    "",
    exposed,
  );
  await check(curl, 0, JSON.stringify({ ...rest, extra: `Basic ${basic}` }) + footer, "", exposed);
  await check(curl, 0, valid, `prefix=${token};suffix\n`, exposed);
  await check(curl, 0, valid, `Authorization: Basic ${basic}\n`, exposed);
  await check(curl, 18, valid, "", incomplete);
  const otherDenial = refused("ACL_NATIVE_REST_DENIAL");
  await check(
    curl,
    0,
    JSON.stringify({ ...rest, error: "middleware_denied" }) + footer,
    "",
    otherDenial,
  );
  await check(
    curl,
    0,
    JSON.stringify({ ...rest, path: "/another/path" }) + footer,
    "",
    otherDenial,
  );
  await check(curl, 0, JSON.stringify(rest) + "\n403 text/plain\n", "", otherDenial);
  // Each stream fits on its own. The combined capture still cannot be complete.
  await check(curl, 0, valid + "x".repeat(4096), "x".repeat(4096), incomplete);
});
