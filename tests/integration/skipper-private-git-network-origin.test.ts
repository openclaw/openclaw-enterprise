import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { request } from "node:https";
import test from "node:test";
import { startSkipperPrivateGitOrigin } from "../fixtures/skipper-private-git-origin.mjs";
import {
  cleanEnvironment,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.ts";
import {
  assertGitAclVariantOutcome,
  calibrateGitAclVariant,
  createGitAclDenialCommand,
  describeGitAclFailure,
  gitAclVariantCurlArgs,
  gitAclVariants,
} from "../helpers/openshell-git-denial.ts";

const alias = `openshell:resolve:env:s${"0".repeat(64)}_GITHUB_TOKEN`;

test("private Git network origin accepts only its broad fixture credential across three repositories", async (t) => {
  // A broad fixture token is independent of the issuer's repository IDs and refs.
  const origin = await startSkipperPrivateGitOrigin({
    repository: "fixture/a",
    repositoryRef: "private-git-b",
    repositoryId: "74",
    networkAcl: true,
  });
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

test("private Git network origin calibrates the exact issued A/B/C credential and observes retirement", async (t) => {
  const origin = await startSkipperPrivateGitOrigin({
    repository: "fixture/a",
    networkAcl: "issued",
  });
  t.after(() => origin.close());
  const network = origin.network;
  assert.ok(network);
  assert.ok(network.token === undefined, "issued mode must use the App issuance path");
  assert.deepEqual(network.scopes, [
    { repository: "fixture/a", repositoryRef: "private-git", repositoryId: "73" },
    { repository: "fixture/b", repositoryRef: "private-git-b", repositoryId: "74" },
    { repository: "fixture/c", repositoryRef: "private-git-c", repositoryId: "75" },
  ]);

  const api = (path: string, method: "POST" | "DELETE", authorization: string, json?: object) =>
    new Promise<{ status: number; payload: string }>((resolve, reject) => {
      const body = json === undefined ? undefined : JSON.stringify(json);
      const req = request(
        new URL(path, origin.origin),
        {
          method,
          ca: origin.tls.ca,
          headers: {
            authorization,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json", "content-length": Buffer.byteLength(body) }),
          },
        },
        (response) => {
          let payload = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            payload += chunk;
          });
          response.once("error", reject);
          response.once("end", () => resolve({ status: response.statusCode!, payload }));
        },
      );
      req.once("error", reject);
      req.end(body);
    });
  const issue = (repository_ids: number[]) =>
    api(
      `/app/installations/${origin.installationId}/access_tokens`,
      "POST",
      `Bearer ${origin.createAppJwt()}`,
      { repository_ids, permissions: { metadata: "read", contents: "write" } },
    );
  assert.equal((await issue([73, 74])).status, 403, "no partial repository scope can qualify");
  const issued = await issue([73, 74, 75]);
  assert.equal(issued.status, 201);
  const grant = JSON.parse(issued.payload) as {
    token: string;
    repository_selection: string;
    repositories: { id: number; full_name: string; private: boolean }[];
  };
  assert.equal(grant.repository_selection, "selected");
  assert.deepEqual(grant.repositories, [
    { id: 73, full_name: "fixture/a", private: true },
    { id: 74, full_name: "fixture/b", private: true },
    { id: 75, full_name: "fixture/c", private: true },
  ]);
  const index = origin.snapshot().tokens[0]?.index;
  assert.equal(index, 1);

  // The origin must accept both protocols for even the repositories that an
  // installed Sandbox will deny. A scoped token denial could otherwise mask an ACL leak.
  for (const repository of network.repositories) {
    for (const service of ["git-upload-pack", "git-receive-pack"]) {
      const body =
        service === "git-upload-pack" ? `0032want ${origin.initialSha}\n00000009done\n` : "0000";
      for (const method of ["GET", "POST"] as const) {
        const response = await network.probeIssued(index, repository, {
          service,
          method,
          ...(method === "POST" && { body }),
        });
        assert.deepEqual(response, {
          status: 200,
          type: `application/x-${service}-${method === "GET" ? "advertisement" : "result"}`,
        });
      }
    }
  }
  assert.equal(network.requests().length, 12);
  assert.ok(
    network
      .requests()
      .every(
        (entry: { authenticated: boolean; credentialIndex?: number }) =>
          entry.authenticated && entry.credentialIndex === index,
      ),
  );
  assert.equal(network.containsIssuedCredential(Buffer.from(grant.token)), true);
  assert.equal(
    network.containsIssuedCredential(
      Buffer.from(Buffer.from(`x-access-token:${grant.token}`).toString("base64")),
    ),
    true,
  );
  assert.equal(
    network.containsIssuedCredential(Buffer.from(JSON.stringify(network.requests()))),
    false,
  );

  // A receive-pack HTTP 200 alone does not establish a permitted ref update.
  // Prove the exact issued token can push a real new A ref through the origin.
  const working = await temporaryDirectory(t, "issued-git-origin-client-");
  const ca = join(working, "ca.pem");
  await writeFile(ca, origin.tls.ca, { mode: 0o600 });
  const basic = Buffer.from(`x-access-token:${grant.token}`).toString("base64");
  const beforePushControl = network.requests().length;
  const git = (args: string[]) =>
    run("git", ["--config-env=http.extraHeader=OCC_TEST_ISSUED_GIT_AUTH", ...args], {
      cwd: working,
      env: cleanEnvironment({
        HOME: working,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_SSL_CAINFO: ca,
        GIT_TERMINAL_PROMPT: "0",
        OCC_TEST_ISSUED_GIT_AUTH: `Authorization: Basic ${basic}`,
      }),
      signal: t.signal,
    });
  await git(["clone", "-q", `${origin.origin}/fixture/a.git`, "a"]);
  const calibrationRef = "refs/heads/issuer-control";
  assert.equal(await network.ref("fixture/a", calibrationRef), undefined);
  await git(["-C", "a", "push", "-q", "origin", `HEAD:${calibrationRef}`]);
  assert.equal(await network.ref("fixture/a", calibrationRef), origin.initialSha);
  assert.ok(
    network
      .requests()
      .slice(beforePushControl)
      .some(
        (entry) =>
          entry.repository === "fixture/a" &&
          entry.operation === "receive-pack" &&
          entry.authenticated &&
          entry.credentialIndex === index,
      ),
    "require authenticated receive-pack from the exact issued credential",
  );

  const route = {
    host: "github.com",
    path: "/fixture/a.git/info/refs",
    method: "GET",
  } as const;
  const fingerprints = network.issuedCredentialFingerprints();
  const guest = createGitAclDenialCommand(fingerprints);
  const variants = gitAclVariants(origin.initialSha);
  for (const probe of variants) {
    await calibrateGitAclVariant(origin, index, probe);
  }
  // The real unfiltered HTTPS origin is a negative control for the installed
  // oracle. In particular a C upload advertisement is a successful Git read.
  assert.equal(new URL(origin.origin).hostname, "127.0.0.1");
  const emptyTrust = join(working, "empty-trust");
  await mkdir(emptyTrust);
  const credentialHeader = join(working, "fixture-auth");
  await writeFile(credentialHeader, `Authorization: Basic ${basic}\n`, { mode: 0o600 });
  const localCurl = [
    "/usr/bin/curl",
    "-q",
    "-s",
    "--noproxy",
    "*",
    "--proto",
    "=https",
    "--max-time",
    "5",
    "--capath",
    emptyTrust,
  ] as const;
  const runGuest = (observation: Parameters<typeof guest>[0], curl: [string, ...string[]]) =>
    run(process.execPath, guest(observation, curl).slice(1), {
      cwd: working,
      env: cleanEnvironment({ GITHUB_TOKEN: alias }),
      signal: t.signal,
      allowFailure: true,
    });
  for (const probe of variants) {
    const before = origin.snapshot().requests;
    const start = network.requests().length;
    const result = await runGuest(
      { kind: "variant", method: probe.method, path: probe.path, host: "github.com" },
      [
        ...localCurl,
        "--cacert",
        ca,
        "-H",
        `@${credentialHeader}`,
        ...gitAclVariantCurlArgs(probe),
        origin.origin + probe.target,
      ],
    );
    assert.ok(
      [result.stdout, result.stderr].every(
        (output) => !network.containsIssuedCredential(Buffer.from(output)),
      ),
      "a bypass control must never emit the fixture credential",
    );
    const delta = origin.snapshot().requests - before;
    const observations = network.requests().slice(start);
    assert.equal(delta, 1, probe.name);
    if (probe.expected === "safe-read") {
      assert.equal(result.code, 0, probe.name);
      assert.equal(
        assertGitAclVariantOutcome(probe, result.stdout, delta, observations, index),
        "upload-advertisement",
      );
    } else {
      assert.throws(
        () => assertGitAclVariantOutcome(probe, result.stdout, delta, observations, index),
        /forbidden origin HTTP/,
      );
    }
  }
  const untrustedStart = origin.snapshot().requests;
  const untrusted = await runGuest({ kind: "variant", ...route }, [
    ...localCurl,
    origin.origin + route.path + "?service=git-upload-pack",
  ]);
  assert.ok(
    untrusted.code === 1 &&
      untrusted.stdout === "" &&
      untrusted.stderr === "ACL_VARIANT_CURL_EXIT_60\n",
    "untrusted TLS must yield only the classified client failure",
  );
  assert.equal(describeGitAclFailure(Buffer.from(untrusted.stderr)), "ACL_VARIANT_CURL_EXIT_60");
  assert.equal(describeGitAclFailure(Buffer.from(untrusted.stderr + "unknown\n")), undefined);
  assert.equal(
    describeGitAclFailure(Buffer.from("ACL_NATIVE_REST_DENIAL\n")),
    "ACL_NATIVE_REST_DENIAL",
  );
  assert.equal(describeGitAclFailure(Buffer.from("ACL_NATIVE_REST_DENIAL\nextra")), undefined);
  assert.equal(
    origin.snapshot().requests,
    untrustedStart,
    "untrusted TLS cannot qualify as an ACL denial",
  );
  const payload = join(working, "output.json");
  const capture = async (
    observation: Parameters<typeof guest>[0],
    stdout: string,
    stderr = "",
    env: Record<string, string> = {},
  ) => {
    await writeFile(payload, JSON.stringify({ stdout, stderr }), { mode: 0o600 });
    const argv = guest(observation, [
      process.execPath,
      "--eval",
      'const { stdout, stderr } = JSON.parse(require("node:fs").readFileSync(process.argv[1])); process.stdout.write(stdout); process.stderr.write(stderr);',
      "--",
      payload,
    ]);
    assert.ok(argv.every((argument) => !network.containsIssuedCredential(Buffer.from(argument))));
    const result = await run("sh", ["-ceu", 'exec "$@"', "--", ...argv], {
      cwd: working,
      env: cleanEnvironment({
        GITHUB_TOKEN: alias,
        PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
        ...env,
      }),
      signal: t.signal,
      allowFailure: true,
    });
    for (const output of [result.stdout, result.stderr]) {
      assert.ok(!network.containsIssuedCredential(Buffer.from(output)), "credential escaped");
    }
    return [result.code, result.stdout, result.stderr];
  };
  const denied = {
    error: "middleware_denied",
    middleware: "oce-prepared-git",
    reason_code: "request_not_allowed",
    layer: "l7",
    port: 443,
    ...route,
  };
  const footer = "\n403 application/json\n";
  const requestAuthority = { kind: "request-authority", ...route } as const;
  const restPolicy = { kind: "rest", ...route } as const;
  const expectedDenial = JSON.stringify(denied) + footer;
  assert.deepEqual(await capture(requestAuthority, expectedDenial), [
    0,
    "403 git-request-authority\n",
    "",
  ]);
  assert.deepEqual(await capture(restPolicy, expectedDenial), [1, "", "ACL_NATIVE_REST_DENIAL\n"]);
  const policy = {
    error: "policy_denied",
    protocol: "rest",
    layer: "l7",
    port: 443,
    ...route,
    rule_missing: { type: "rest_allow", layer: "l7", method: route.method, path: route.path },
  };
  const expectedPolicy = JSON.stringify(policy) + footer;
  assert.deepEqual(await capture(requestAuthority, expectedPolicy), [
    1,
    "",
    "ACL_GIT_AUTHORITY_DENIAL\n",
  ]);
  assert.deepEqual(await capture(restPolicy, expectedPolicy), [0, "403 native-rest-policy\n", ""]);
  const variant = { kind: "variant", ...route } as const;
  assert.deepEqual(await capture(variant, expectedPolicy), [0, "403 native-rest-policy\n", ""]);
  assert.deepEqual(await capture(variant, expectedDenial), [0, "403 git-request-authority\n", ""]);
  for (const token of [grant.token, basic]) {
    assert.deepEqual(
      await capture(
        requestAuthority,
        JSON.stringify({ ...denied, extra: `prefix=${token}` }) + footer,
      ),
      [1, "", "ACL_CREDENTIAL_IN_OUTPUT\n"],
    );
    assert.deepEqual(await capture(requestAuthority, expectedDenial, `prefix=${token}\n`), [
      1,
      "",
      "ACL_CREDENTIAL_IN_OUTPUT\n",
    ]);
    assert.deepEqual(
      await capture({ kind: "success" }, "projected-output", "", {
        CREDENTIAL_TEST: `prefix=${token}`,
      }),
      [1, "", "ACL_CREDENTIAL_IN_ENVIRONMENT\n"],
    );
  }
  assert.deepEqual(await capture({ kind: "success" }, "projected-output"), [
    0,
    "projected-output",
    "",
  ]);
  assert.deepEqual(
    await capture({ kind: "success" }, "projected-output", "", { GITHUB_TOKEN: "" }),
    [1, "", "ACL_PLACEHOLDER_ENVIRONMENT\n"],
  );
  const missing = await network.probeIssued(undefined, "fixture/a", {
    service: "git-upload-pack",
    method: "GET",
  });
  assert.deepEqual(missing, { status: 401, type: "application/json" });
  assert.equal(network.requests().at(-1)?.authenticated, false);

  assert.equal((await api("/installation/token", "DELETE", `Bearer ${grant.token}`)).status, 204);
  const retired = await network.probeIssued(index, "fixture/b", {
    service: "git-receive-pack",
    method: "POST",
    body: "0000",
  });
  assert.deepEqual(retired, { status: 401, type: "application/json" });
  assert.equal(network.requests().at(-1)?.authenticated, false);
  assert.equal(origin.snapshot().tokens[0]?.revoked, true);
});
