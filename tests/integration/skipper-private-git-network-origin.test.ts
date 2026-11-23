import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { request } from "node:https";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import test, { type TestContext } from "node:test";
import {
  scopedRestFixturePermissions,
  startSkipperPrivateGitOrigin,
} from "../fixtures/skipper-private-git-origin.mjs";
import {
  cleanEnvironment,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.ts";
import { createGitAclDenialCommand } from "../helpers/openshell-git-denial.ts";

const alias = `openshell:resolve:env:s${"0".repeat(64)}_GITHUB_TOKEN`;
const repos = ["fixture/a", "fixture/b", "fixture/c"];
type Origin = Awaited<ReturnType<typeof startSkipperPrivateGitOrigin>>;

function basic(token: string) {
  return `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}

async function gitClient(t: TestContext, origin: Origin, token: string) {
  const cwd = await temporaryDirectory(t, "git-network-origin-client-");
  const ca = join(cwd, "ca.pem");
  await writeFile(ca, origin.tls.ca, { mode: 0o600 });
  return (args: string[], { credential = token, allowFailure = false } = {}) =>
    run("git", ["--config-env=http.extraHeader=FIXTURE_GIT_AUTH", ...args], {
      cwd,
      env: cleanEnvironment({
        HOME: cwd,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_SSL_CAINFO: ca,
        FIXTURE_GIT_AUTH: `Authorization: ${basic(credential)}`,
      }),
      allowFailure,
      signal: t.signal,
    });
}

function send(
  origin: Origin,
  path: string,
  {
    method = "GET",
    authorization,
    body,
    contentType = "application/json",
  }: {
    method?: "GET" | "POST" | "DELETE";
    authorization?: string;
    body?: string;
    contentType?: string;
  },
) {
  return new Promise<{ status: number | undefined; type: string | undefined; body: string }>(
    (resolve, reject) => {
      const req = request(
        new URL(path, origin.origin),
        {
          method,
          ca: origin.tls.ca,
          signal: AbortSignal.timeout(5000),
          headers: {
            ...(authorization === undefined ? {} : { authorization }),
            ...(body === undefined
              ? {}
              : { "content-type": contentType, "content-length": Buffer.byteLength(body) }),
          },
        },
        (response) => {
          text(response).then(
            (body) =>
              resolve({
                status: response.statusCode,
                type: response.headers["content-type"],
                body,
              }),
            reject,
          );
        },
      );
      req.once("error", reject);
      req.end(body);
    },
  );
}

function issueCredential(origin: Origin, repository_ids: number[], permissions: object) {
  return send(origin, `/app/installations/${origin.installationId}/access_tokens`, {
    method: "POST",
    authorization: `Bearer ${origin.createAppJwt()}`,
    body: JSON.stringify({ repository_ids, permissions }),
  });
}

const nextCommit = (directory: string) => [
  "-C",
  directory,
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.test",
  "commit",
  "--allow-empty",
  "-m",
  "Fast-forward candidate",
];

test("private Git network origin accepts only its broad fixture credential across three repositories", async (t) => {
  const origin = await startSkipperPrivateGitOrigin({ repository: "fixture/a", networkAcl: true });
  t.after(() => origin.close());
  const network = origin.network;
  assert.ok(network?.token);
  const git = await gitClient(t, origin, network.token);
  for (const repo of repos) {
    await git(["clone", `${origin.origin}/${repo}.git`, repo]);
  }
  const approved = origin.approvalRef;
  const push = (repo: string, ref: string) => ["-C", repo, "push", "origin", `HEAD:${ref}`];
  assert.equal(await network.ref("fixture/a", approved), undefined);
  await git(push("fixture/a", approved));
  await git(push("fixture/c", "refs/heads/control"));
  assert.equal(await network.ref("fixture/a", approved), origin.initialSha);
  assert.equal(await network.ref("fixture/c", "refs/heads/control"), origin.initialSha);
  assert.equal(await network.hasObject("fixture/c", origin.initialSha), true);

  // A real fast-forward is distinguishable from a denied update or a no-op.
  await git(push("fixture/b", approved));
  await git(nextCommit("fixture/b"));
  const candidate = (await git(["-C", "fixture/b", "rev-parse", "HEAD"])).stdout.trim();
  assert.notEqual(candidate, origin.initialSha);
  assert.equal(await network.hasObject("fixture/b", candidate), false);
  for (const [repo, command] of [
    ["fixture/a", ["ls-remote", `${origin.origin}/fixture/a.git`]],
    ["fixture/b", push("fixture/b", approved)],
  ] as const) {
    const before = network.requests().length;
    const denied = await git([...command], { credential: alias, allowFailure: true });
    assert.notEqual(denied.code, 0);
    const attempts = network.requests().slice(before);
    assert.ok(attempts.length > 0);
    assert.ok(attempts.every((entry) => entry.repository === repo && !entry.authenticated));
  }
  assert.equal(await network.ref("fixture/b", approved), origin.initialSha);
  assert.equal(await network.hasObject("fixture/b", candidate), false);
  await git(push("fixture/b", approved));
  assert.equal(await network.ref("fixture/b", approved), candidate);
  assert.equal(await network.hasObject("fixture/b", candidate), true);

  const beforeUnknown = network.unknownRequests();
  const beforeKnown = network.requests().length;
  const unknown = await send(origin, "/unrecognized-route?service=unrecognized-value", {
    authorization: basic(network.token),
  });
  assert.equal(unknown.status, 404);
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
  // An observation failure cannot prove the forbidden ref is absent.
  await origin.close();
  await assert.rejects(network.ref("fixture/a", approved), /Git ref lookup failed/u);
  await assert.rejects(network.hasObject("fixture/b", candidate), /Git object lookup failed/u);
});

test("private Git network origin calibrates the exact issued A/B/C credential and observes retirement", async (t) => {
  const origin = await startSkipperPrivateGitOrigin({
    networkAcl: "issued",
    scopedRest: true,
  });
  t.after(() => origin.close());
  const network = origin.network;
  assert.ok(network);
  assert.equal(network.token, undefined, "issued mode must use the App issuance path");

  const issue = (ids: number[], permissions: object) => issueCredential(origin, ids, permissions);
  assert.equal((await issue([73, 74], scopedRestFixturePermissions)).status, 403);
  const issued = await issue([73, 74, 75], scopedRestFixturePermissions);
  assert.equal(issued.status, 201);
  const grant = JSON.parse(issued.body) as {
    token: string;
    repository_selection: string;
    repositories: { id: number; full_name: string; private: boolean }[];
  };
  assert.equal(grant.repository_selection, "selected");
  assert.deepEqual(grant.repositories, [
    { id: 73, full_name: origin.repository, private: true },
    { id: 74, full_name: "fixture/b", private: true },
    { id: 75, full_name: "fixture/c", private: true },
  ]);
  const index = origin.snapshot().tokens[0]?.index;
  assert.equal(index, 1);

  // Authenticated Git and REST must work at the origin even for repositories
  // the Sandbox should deny. Otherwise an origin refusal could hide an ACL leak.
  for (const repo of [origin.repository, "fixture/b", "fixture/c"]) {
    for (const service of ["git-upload-pack", "git-receive-pack"]) {
      const advertise = await send(origin, `/${repo}.git/info/refs?service=${service}`, {
        authorization: basic(grant.token),
      });
      assert.equal(advertise.status, 200);
      assert.equal(advertise.type, `application/x-${service}-advertisement`);
      const pack = await send(origin, `/${repo}.git/${service}`, {
        method: "POST",
        authorization: basic(grant.token),
        contentType: `application/x-${service}-request`,
        body:
          service === "git-upload-pack" ? `0032want ${origin.initialSha}\n00000009done\n` : "0000",
      });
      assert.equal(pack.status, 200);
      assert.equal(pack.type, `application/x-${service}-result`);
    }
    const issuePath = `/repos/${repo}/issues`;
    const listed = await send(origin, issuePath, { authorization: `Bearer ${grant.token}` });
    const detail = await send(origin, `${issuePath}/42`, {
      authorization: `Bearer ${grant.token}`,
    });
    const expected = { number: 42, title: `Fixture issue in ${repo}`, state: "open" };
    assert.equal(listed.status, 200);
    assert.deepEqual(JSON.parse(listed.body), [expected]);
    assert.equal(detail.status, 200);
    assert.deepEqual(JSON.parse(detail.body), expected);
  }
  const calibrated = network.requests();
  assert.equal(calibrated.length, 18);
  const unknownBefore = network.unknownRequests();
  const unknown = await send(origin, "/repos/fixture/a/issues/42", {
    authorization: `Bearer ${grant.token}`,
  });
  assert.equal(unknown.status, 404);
  assert.equal(network.unknownRequests(), unknownBefore + 1);
  assert.deepEqual(network.requests(), calibrated);
  assert.ok(calibrated.every((entry) => entry.authenticated && entry.credentialIndex === index));
  for (const representation of [grant.token, basic(grant.token)]) {
    assert.ok(
      !JSON.stringify(calibrated).includes(representation),
      "credential leaked into observations",
    );
  }

  // A receive-pack HTTP 200 alone doesn't establish a permitted ref update.
  const git = await gitClient(t, origin, grant.token);
  const repo = "fixture/b";
  await git(["clone", "-q", `${origin.origin}/${repo}.git`, repo]);
  await git(nextCommit(repo));
  const sha = (await git(["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
  assert.notEqual(sha, origin.initialSha);
  assert.equal(await network.ref(repo, origin.approvalRef), undefined);
  const beforePush = network.requests().length;
  await git(["-C", repo, "push", "-q", "origin", `HEAD:${origin.approvalRef}`]);
  assert.equal(await network.ref(repo, origin.approvalRef), sha);
  assert.ok(
    network
      .requests()
      .slice(beforePush)
      .some(
        (entry) =>
          entry.repository === repo &&
          entry.operation === "receive-pack" &&
          entry.authenticated &&
          entry.credentialIndex === index,
      ),
    "require receive-pack with the exact issued credential",
  );

  // The synthetic origin must also allow a real primary-A push outside the approval ref.
  const primaryRef = "refs/heads/issued-primary-control";
  assert.notEqual(primaryRef, origin.approvalRef);
  assert.equal(await network.ref(origin.repository, primaryRef), undefined);
  assert.equal(await network.hasObject(origin.repository, sha), false);
  const beforePrimaryPush = network.requests().length;
  await git([
    "-C",
    repo,
    "push",
    "-q",
    `${origin.origin}/${origin.repository}.git`,
    `HEAD:${primaryRef}`,
  ]);
  assert.equal(await network.ref(origin.repository, primaryRef), sha);
  assert.equal(await network.hasObject(origin.repository, sha), true);
  assert.ok(
    network
      .requests()
      .slice(beforePrimaryPush)
      .some(
        (entry) =>
          entry.repository === origin.repository &&
          entry.operation === "receive-pack" &&
          entry.authenticated &&
          entry.credentialIndex === index,
      ),
    "require primary receive-pack with the exact issued credential",
  );

  const pull = (token: string) =>
    send(origin, `/repos/${repo}/pulls`, {
      method: "POST",
      authorization: `Bearer ${token}`,
      body: JSON.stringify({ title: "Fixture change", head: "approved", base: "main" }),
    });
  const lackedPermission = await issue([73, 74, 75], { metadata: "read", contents: "write" });
  assert.equal(lackedPermission.status, 201);
  assert.equal((await pull(JSON.parse(lackedPermission.body).token)).status, 403);
  assert.equal((await pull(alias)).status, 403);
  assert.equal(network.pullRequest(repo), undefined);
  const created = await pull(grant.token);
  assert.equal(created.status, 201);
  const observedPull = network.pullRequest(repo);
  assert.deepEqual(JSON.parse(created.body), observedPull);
  assert.equal(observedPull?.head.sha, sha);
  assert.equal(observedPull?.base.sha, origin.initialSha);
  assert.equal(observedPull?.draft, false);

  const missing = await send(
    origin,
    `/${origin.repository}.git/info/refs?service=git-upload-pack`,
    {},
  );
  assert.equal(missing.status, 401);
  assert.equal(network.requests().at(-1)?.authenticated, false);
  assert.equal(
    (
      await send(origin, "/installation/token", {
        method: "DELETE",
        authorization: `Bearer ${grant.token}`,
      })
    ).status,
    204,
  );
  const retired = await send(origin, "/fixture/b.git/git-receive-pack", {
    method: "POST",
    authorization: basic(grant.token),
    contentType: "application/x-git-receive-pack-request",
    body: "0000",
  });
  assert.equal(retired.status, 401);
  assert.equal(network.requests().at(-1)?.authenticated, false);
  assert.equal(
    (
      await send(origin, "/repos/fixture/c/issues/42", {
        authorization: `Bearer ${grant.token}`,
      })
    ).status,
    403,
  );
  assert.equal(origin.snapshot().tokens[0]?.revoked, true);
});

test("private Git network origin tracks the rotated credential and retains redaction fingerprints", async (t) => {
  const origin = await startSkipperPrivateGitOrigin({
    networkAcl: "issued",
    witnessIssuedGit: true,
    repository: "fixture/a",
  });
  t.after(() => origin.close());
  const network = origin.network;
  assert.ok(network);
  const permissions = { metadata: "read", contents: "write" };
  const issue = async (lifetime: number) => {
    const before = Date.now();
    const response = await issueCredential(origin, [73, 74, 75], permissions);
    assert.equal(response.status, 201);
    const grant = JSON.parse(response.body) as { token: string; expires_at: string };
    const expiry = Date.parse(grant.expires_at);
    assert.ok(expiry >= before + lifetime && expiry <= Date.now() + lifetime, "issued lifetime");
    return grant.token;
  };
  const advertise = (repo: string, token: string) =>
    send(origin, `/${repo}.git/info/refs?service=git-receive-pack`, {
      authorization: basic(token),
    });

  network.shortenNextTokenForRenewal();
  assert.equal((await issueCredential(origin, [73, 74], permissions)).status, 403);
  const previous = await issue(750_000);
  const renewed = await issue(3_600_000);
  assert.ok(previous !== renewed, "the new credential must be distinct");

  // Independently establish broad write authority while both credentials are live.
  for (const [token, credentialIndex] of [
    [previous, 1],
    [renewed, 2],
  ] as const) {
    for (const repository of repos) {
      const reply = await advertise(repository, token);
      assert.equal(reply.status, 200);
      assert.equal(reply.type, "application/x-git-receive-pack-advertisement");
      assert.deepEqual(network.requests().at(-1), {
        repository,
        operation: "receive-advertise",
        method: "GET",
        authenticated: true,
        credentialIndex,
      });
    }
  }

  assert.equal(
    (
      await send(origin, "/installation/token", {
        method: "DELETE",
        authorization: `Bearer ${previous}`,
      })
    ).status,
    204,
  );
  const repo = "fixture/c";
  for (const rejected of [previous, alias]) {
    assert.equal((await advertise(repo, rejected)).status, 401);
    assert.deepEqual(network.requests().at(-1), {
      repository: repo,
      operation: "receive-advertise",
      method: "GET",
      authenticated: false,
    });
  }

  const git = await gitClient(t, origin, renewed);
  await git(["clone", "-q", `${origin.origin}/${repo}.git`, "peer"]);
  await git(nextCommit("peer"));
  const sha = (await git(["-C", "peer", "rev-parse", "HEAD"])).stdout.trim();
  const beforePush = network.requests().length;
  assert.equal(await network.ref(repo, origin.approvalRef), undefined);
  await git(["-C", "peer", "push", "-q", "origin", `HEAD:${origin.approvalRef}`]);
  assert.equal(await network.ref(repo, origin.approvalRef), sha);
  assert.ok(
    network
      .requests()
      .slice(beforePush)
      .some(
        (entry) =>
          entry.repository === repo &&
          entry.operation === "receive-pack" &&
          entry.authenticated &&
          entry.credentialIndex === 2,
      ),
    "observe the replacement credential on the write RPC",
  );
  assert.deepEqual(
    origin.snapshot().tokens.map(({ index, revoked }) => ({ index, revoked })),
    [
      { index: 1, revoked: true },
      { index: 2, revoked: false },
    ],
  );

  // Exercise the origin and denial oracle locally. Only the installed caller
  // can establish what OpenShell does with these literal targets.
  const outcomes = await network.checkGitVariants(2, async (probe) => {
    if (probe.expected === "read") {
      const replay = probe.target.includes("%61")
        ? { method: probe.method, service: probe.service }
        : probe;
      assert.equal((await network.probeIssued(2, probe.repository, replay)).status, 200);
      return "200 upload-advertisement\n";
    }
    return probe.method === "HEAD" ? "403 head-http\n" : "403 native-rest-policy\n";
  });
  assert.equal(new Set(outcomes.map(({ method, target }) => `${method} ${target}`)).size, 15);
  assert.deepEqual(
    outcomes.filter((row) => row.exactLiteral === false).map((row) => row.wire),
    [{ method: "literal", path: "canonical", query: "canonical" }],
  );
  // A canonical GET can return the right Git media type on the right repository.
  // It cannot witness a different request target.
  const normalized = {
    ...network,
    probeIssued: () =>
      network.probeIssued(2, "fixture/a", { method: "GET", service: "git-receive-pack" }),
  };
  await assert.rejects(
    normalized.checkGitVariants(2, async () => assert.fail("normalized calibration")),
    /Git calibration recipient or target mismatch/,
  );
  await assert.rejects(
    network.checkGitVariants(1, async () => assert.fail("revoked token")),
    /Git variant calibration failed/,
  );
  await assert.rejects(
    network.checkGitVariants(2, async (probe) => {
      await network.probeIssued(2, probe.repository, probe);
      return "403 native-rest-policy\n";
    }),
    /Forbidden Git variant reached the origin/,
  );
  await assert.rejects(
    network.checkGitVariants(2, async () => "transport\n"),
    /Missing Git variant refusal/,
  );

  const representations = [previous, renewed].flatMap((token) => [token, basic(token).slice(6)]);
  const fingerprints = network.issuedCredentialFingerprints();
  assert.deepEqual(
    fingerprints,
    representations.map((value) => [
      Buffer.byteLength(value),
      createHash("sha256").update(value).digest("hex"),
    ]),
  );
  // A convincing denial cannot compensate for a truncated capture. Both streams fit alone.
  const denial = createGitAclDenialCommand(fingerprints);
  const fatal = "fatal: The requested URL returned error: 403\n".padEnd(4096);
  for (const bytes of [4096, 4097]) {
    const [, ...args] = denial({ kind: "git" }, [
      "/bin/sh",
      "-c",
      'printf %s "$1"; printf %s "$2" >&2; exit 128',
      "--",
      "x".repeat(bytes),
      fatal,
    ]);
    const { code, stdout, stderr } = await run(process.execPath, args, {
      env: { GITHUB_TOKEN: alias },
      signal: t.signal,
      allowFailure: true,
    });
    assert.ok(
      bytes === 4096
        ? code === 0 && stdout === "403 native-git\n" && stderr === ""
        : code === 1 && stdout === "" && stderr === "ACL_DENIAL_CAPTURE\n",
      "Git denial requires complete output",
    );
  }
  const observations = JSON.stringify([origin.snapshot(), network.requests(), fingerprints]);
  for (const credential of representations) {
    assert.ok(!observations.includes(credential), "credential leaked into observations");
  }
});
