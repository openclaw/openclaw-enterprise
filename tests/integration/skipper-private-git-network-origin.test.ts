import assert from "node:assert/strict";
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

  const issue = (repository_ids: number[], permissions: object) =>
    send(origin, `/app/installations/${origin.installationId}/access_tokens`, {
      method: "POST",
      authorization: `Bearer ${origin.createAppJwt()}`,
      body: JSON.stringify({ repository_ids, permissions }),
    });
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
