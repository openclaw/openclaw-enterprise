import assert from "node:assert/strict";
import { Agent, request } from "node:https";
import { once } from "node:events";
import { connect } from "node:net";
import { connect as connectTls } from "node:tls";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  assertOnlyTokenRetirement,
  fetchAfterWithdrawalCommand,
  startSkipperPrivateGitOrigin,
  withdrawDuringFetchCommand,
} from "../fixtures/skipper-private-git-origin.mjs";
import { cleanEnvironment, run } from "../fixtures/repository-credentials/process.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { waitUntil } from "../helpers/wait-for.mjs";

function api(
  fixture,
  method,
  path,
  authorization,
  body,
  { afterHeaders, contentType = "application/json", agent = false } = {},
) {
  return new Promise((resolve, reject) => {
    const req = request(
      new URL(path, fixture.origin),
      {
        method,
        agent,
        ca: fixture.tls.ca ?? fixture.tls.cert,
        headers: { ...(authorization && { authorization }), "content-type": contentType },
        timeout: 10000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            body:
              chunks.length && response.headers["content-type"] === "application/json"
                ? JSON.parse(Buffer.concat(chunks).toString())
                : undefined,
          }),
        );
        response.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("fixture request timed out")));
    req.on("error", reject);
    const send = () => req.end(body ? JSON.stringify(body) : undefined);
    if (afterHeaders) {
      req.flushHeaders();
      afterHeaders().then(send, (error) => req.destroy(error));
    } else {
      send();
    }
  });
}

test(
  "private origin authenticates Git, constrains pushes, witnesses objects, and revokes tokens",
  { timeout: 120000 },
  async (t) => {
    const fixture = await startSkipperPrivateGitOrigin({
      witnessIssuedGit: true,
      repositoryRef: "qualification-private",
      approvalRef: "refs/heads/qualification/approved",
      teamReview: true,
    });
    t.after(() => fixture.close());
    const directory = await temporaryDirectory(t, "private-git-client-");
    const caFile = join(directory, "ca.pem");
    await writeFile(caFile, fixture.tls.ca);
    const env = cleanEnvironment({
      HOME: directory,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_SSL_CAINFO: caFile,
    });
    const git = (args, token, options = {}) =>
      run("git", args, {
        cwd: directory,
        env: token
          ? {
              ...env,
              GIT_CONFIG_COUNT: "2",
              GIT_CONFIG_KEY_1: "http.extraHeader",
              GIT_CONFIG_VALUE_1: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
            }
          : env,
        ...options,
      });
    const issuePath = `/app/installations/${fixture.installationId}/access_tokens`;
    const jwt = `Bearer ${fixture.createAppJwt()}`;
    const privileges = { metadata: "read", contents: "write" };
    const issue = (
      permissions = privileges,
      repositoryIds = [Number(fixture.repositoryId)],
      authorization = jwt,
    ) =>
      api(fixture, "POST", issuePath, authorization, {
        repository_ids: repositoryIds,
        permissions,
      });

    // A real anonymous clone must fail before any object reaches the client.
    const anonymous = await git(["clone", fixture.cloneUrl, "anonymous"], undefined, {
      allowFailure: true,
    });
    assert.notEqual(anonymous.code, 0);
    assert.equal(fixture.snapshot().endpoints["upload-advertise:401"], 1);
    assert.equal((await issue(privileges, [999])).status, 403);
    assert.equal((await issue({ ...privileges, administration: "write" })).status, 403);
    assert.equal((await issue(privileges, [73], "Bearer invalid")).status, 403);
    const forged = `${jwt.split(".").slice(0, 2).join(".")}.${Buffer.alloc(256).toString("base64url")}`;
    assert.equal((await issue(privileges, [73], forged)).status, 403);
    const issued = await issue();
    assert.equal(issued.status, 201);
    assert.deepEqual(issued.body.permissions, privileges);
    assert.equal(issued.body.repository_selection, "selected");
    assert.deepEqual(issued.body.repositories, [
      { id: 73, full_name: fixture.repository, private: true },
    ]);
    assert.ok(Date.parse(issued.body.expires_at) > Date.now());
    const token = issued.body.token;

    const metadata = await issue({ metadata: "read" });
    assert.equal(metadata.status, 201);
    assert.notEqual(
      (
        await git(["clone", fixture.cloneUrl, "metadata-only"], metadata.body.token, {
          allowFailure: true,
        })
      ).code,
      0,
    );
    // Identify the credential Git actually used; issuance order alone is not evidence.
    const usedIndex = (priorCount) => {
      const indices = [...new Set(fixture.gitAttemptIndices().slice(priorCount))];
      assert.equal(indices.length, 1);
      return indices[0];
    };
    const beforeA = fixture.gitAttemptIndices().length;
    await git(["clone", fixture.cloneUrl, "client"], token);
    const indexA = usedIndex(beforeA);
    assert.equal(await fixture.probeIssuedGit(indexA), 200);
    const client = join(directory, "client");
    assert.equal(
      await readFile(join(client, "README.md"), "utf8"),
      "Private qualification repository\n",
    );
    await writeFile(join(client, "approved.txt"), "Run-owned change\n");
    await git(["add", "approved.txt"], token, { cwd: client });
    await git(
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-m",
        "Approved fixture change",
      ],
      token,
      { cwd: client },
    );
    const sha = (await git(["rev-parse", "HEAD"], token, { cwd: client })).stdout.trim();
    const reader = await issue({
      metadata: "read",
      contents: "read",
      issues: "read",
      pull_requests: "read",
      checks: "read",
      statuses: "read",
    });
    assert.equal(reader.status, 201);
    const beforeB = fixture.gitAttemptIndices().length;
    await git(["clone", fixture.cloneUrl, "read-only"], reader.body.token);
    const indexB = usedIndex(beforeB);
    assert.notEqual(indexA, indexB);
    const observedProbe = fixture.observeRestartTraffic(indexA, indexB);
    const beforeProbe = fixture.snapshot();
    const beforeProbeAttempts = fixture.gitAttemptIndices().length;
    assert.equal(await fixture.probeIssuedGit(indexB), 200);
    assert.equal(usedIndex(beforeProbeAttempts), indexB);
    assert.deepEqual(observedProbe(), [
      "git auth B",
      "upload-advertise HTTP 200",
      "verifier probe",
    ]);
    assert.equal(
      fixture.snapshot().endpoints["upload-advertise:200"],
      beforeProbe.endpoints["upload-advertise:200"] + 1,
    );
    assert.equal(fixture.snapshot().issued, beforeProbe.issued);
    const beforeUnknown = fixture.snapshot();
    await assert.rejects(fixture.probeIssuedGit(0), /unknown issued Git index/);
    assert.deepEqual(fixture.snapshot(), beforeUnknown);
    assert.notEqual(
      (
        await git(["push", "origin", `HEAD:${fixture.approvalRef}`], reader.body.token, {
          cwd: client,
          allowFailure: true,
        })
      ).code,
      0,
    );

    // Exercise receive-pack itself, not just URL filtering. Mixed updates must
    // fail atomically, so an allowed branch cannot hide a protected branch update.
    for (const refs of [
      ["HEAD:refs/heads/main"],
      [`HEAD:${fixture.approvalRef}-other`],
      [`HEAD:${fixture.approvalRef}`, "HEAD:refs/heads/main"],
    ]) {
      const denied = await git(["push", "origin", ...refs], token, {
        cwd: client,
        allowFailure: true,
      });
      assert.notEqual(denied.code, 0);
      assert.match(denied.stderr, /ref denied/);
      assert.deepEqual(await fixture.readRefs(), { "refs/heads/main": fixture.initialSha });
    }
    assert.notEqual(
      (
        await git(["clone", `${fixture.origin}/${fixture.repository}-other.git`, "other"], token, {
          allowFailure: true,
        })
      ).code,
      0,
    );
    await git(["push", "origin", `HEAD:${fixture.approvalRef}`], token, { cwd: client });

    // The witness owns a new object store and reads the bare repository directly.
    // It cannot accept client/broker-reported success as evidence of a pushed commit.
    const witness = await fixture.witnessCommit();
    assert.equal(witness.sha, sha);
    assert.equal(witness.refs[fixture.approvalRef], sha);
    assert.equal(witness.refs["refs/heads/main"], fixture.initialSha);
    assert.match(witness.commit, /Approved fixture change/);
    assert.match(witness.tree, /\tapproved.txt\n/);
    const draftPermissions = { metadata: "read", contents: "write", pull_requests: "write" };
    const draftToken = await issue(draftPermissions);
    assert.equal(draftToken.status, 201);
    const draft = (token, afterHeaders) =>
      api(
        fixture,
        "POST",
        "/repos/" + fixture.repository + "/pulls",
        "Bearer " + token,
        {
          title: "Review qualification",
          body: "Native push independently inspected",
          draft: true,
          base: "main",
          head: "qualification/approved",
          maintainer_can_modify: false,
        },
        { afterHeaders },
      );
    assert.equal((await draft(token)).status, 403, "Git-only token must not create a draft");
    assert.equal(await fixture.observePullRequest(), null);
    // Revoke after the origin receives the headers, but before it can create the draft.
    const interrupted = await issue(draftPermissions);
    const authorization = "Bearer " + interrupted.body.token;
    const before = fixture.snapshot().pullCreateRequests;
    const withdrawn = await draft(interrupted.body.token, async () => {
      const deadline = AbortSignal.timeout(5000);
      while (fixture.snapshot().pullCreateRequests === before) {
        deadline.throwIfAborted();
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(
        (await api(fixture, "DELETE", "/installation/token", authorization)).status,
        204,
      );
    });
    assert.equal(withdrawn.status, 403, "revoked draft authority cannot commit a pending request");
    assert.equal(await fixture.observePullRequest(), null);
    const { status, body: pull } = await draft(draftToken.body.token);
    assert.equal(status, 201, "separately scoped draft creation accepted at controlled provider");
    assert.equal(pull.head.sha, sha);
    assert.equal(pull.head.repo.full_name, fixture.repository);
    assert.equal(pull.base.sha, fixture.initialSha);
    assert.deepEqual(await fixture.observePullRequest(), pull);
    assert.equal(fixture.snapshot().endpoints["pull-create:201"], 1);
    await git(["clone", "--branch", "qualification/approved", fixture.cloneUrl, "reader"], token);
    assert.equal(
      await readFile(join(directory, "reader", "approved.txt"), "utf8"),
      "Run-owned change\n",
    );

    // Compare-and-delete must preserve a concurrently changed ref on mismatch.
    await assert.rejects(fixture.deleteApprovalRef(fixture.initialSha), {
      message: /^command failed/,
    });
    assert.equal((await fixture.readRefs())[fixture.approvalRef], sha);
    await fixture.deleteApprovalRef(sha);
    assert.deepEqual(await fixture.readRefs(), { "refs/heads/main": fixture.initialSha });
    // An issuer refusal leaves this separate credential valid. Other tokens must still retire
    // normally below; closing the fixture destroys this synthetic issuer without replaying DELETE.
    const retained = await issue();
    assert.equal(retained.status, 201);
    const beforeRetained = fixture.gitAttemptIndices().length;
    await git(["ls-remote", fixture.cloneUrl, "refs/heads/main"], retained.body.token);
    const retainedIndex = usedIndex(beforeRetained);
    fixture.refuseTokenRetirement(retainedIndex);
    const observedRetirement = fixture.observeRestartTraffic(indexA, indexB);
    assert.equal(
      (await api(fixture, "DELETE", "/installation/token", "Bearer invalid")).status,
      401,
    );
    assert.equal(fixture.snapshot().targetedRetirementRefusals, 0);
    assert.equal(
      (await api(fixture, "DELETE", "/installation/token", "Bearer " + retained.body.token)).status,
      503,
    );
    assert.equal(fixture.snapshot().targetedRetirementRefusals, 1);
    assert.deepEqual(observedRetirement(), [
      "retirement auth other",
      "revoke HTTP 401",
      "revoke HTTP 503",
    ]);
    assert.equal(await fixture.probeIssuedGit(retainedIndex), 200);
    assert.equal(
      fixture.snapshot().tokens.find(({ index }) => index === retainedIndex).revoked,
      false,
    );
    assert.equal(await fixture.probeIssuedGit(indexB), 200);

    const observedWithdrawal = fixture.observeRestartTraffic(indexA, indexB);
    // Qualify the exact installed withdrawal oracle on a real Git protocol-v2 connection.
    // Hold authenticated discovery, revoke the synthetic token, release discovery. The native
    // client must see its authenticated POST refused, never infer a denial from a timeout.
    fixture.holdNextDiscovery();
    const command = withdrawDuringFetchCommand(".", 401);
    const envAuth = {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_1: "http.extraHeader",
      GIT_CONFIG_VALUE_1:
        "Authorization: Basic " + Buffer.from("x-access-token:" + token).toString("base64"),
    };
    const held = run("sh", ["-c", command], {
      cwd: client,
      env: { ...env, ...envAuth },
      allowFailure: true,
    }).then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    await waitUntil("a real authenticated discovery", () => fixture.discoveryHeld(), 5000);
    assert.deepEqual(observedWithdrawal(), ["git auth A", "upload-advertise HTTP 200"]);
    assert.equal(
      (await api(fixture, "DELETE", "/installation/token", `Bearer ${token}`)).status,
      204,
    );
    fixture.releaseDiscovery();
    const { result } = await held;
    assert.equal(result?.code, 0, "the withdrawn active-session oracle must pass");
    assert.equal(
      fixture.snapshot().endpoints["upload-pack:401"],
      1,
      "fixture observed the second authenticated POST",
    );
    assert.deepEqual(observedWithdrawal(), [
      "git auth A",
      "retirement auth A",
      "revoke HTTP 204",
      "upload-advertise HTTP 200",
      "upload-pack HTTP 401",
    ]);
    const fresh = fetchAfterWithdrawalCommand(".", 401);
    const beforeFresh = fixture.snapshot().requests;
    const refused = await run("sh", ["-c", fresh], {
      cwd: client,
      env: { ...env, ...envAuth },
      allowFailure: true,
    });
    assert.equal(refused.code, 0, "new authenticated Git process sees the explicit refusal");
    assert.ok(fixture.snapshot().requests > beforeFresh);
    const uncredentialed = await run("sh", ["-c", fresh], { cwd: client, env, allowFailure: true });
    assert.notEqual(uncredentialed.code, 0, "anonymous refusal must fail the withdrawal oracle");
    assert.notEqual(
      (await git(["clone", fixture.cloneUrl, "revoked"], token, { allowFailure: true })).code,
      0,
    );
    assert.notEqual(
      (
        await git(["push", "origin", `HEAD:${fixture.approvalRef}`], token, {
          cwd: client,
          allowFailure: true,
        })
      ).code,
      0,
    );
    assert.deepEqual(await fixture.readRefs(), { "refs/heads/main": fixture.initialSha });
    assert.equal(
      (await api(fixture, "DELETE", "/installation/token", `Bearer ${token}`)).status,
      401,
    );
    assert.equal(await fixture.probeIssuedGit(indexA), 401);
    assert.equal(await fixture.probeIssuedGit(indexB), 200);

    const snapshot = fixture.snapshot();
    assert.equal(snapshot.issued, 6);
    assert.ok(snapshot.endpoints["upload-pack:200"] >= 2);
    assert.ok(snapshot.endpoints["receive-pack:200"] >= 4);
    assert.ok(snapshot.endpoints["other:404"] >= 1);
    assert.equal(JSON.stringify(snapshot).includes(token), false);
    assert.equal(JSON.stringify(snapshot).includes(jwt), false);
    // Invalid protocol data reaches the Git backend only with valid credentials.
    const observedRpc = fixture.observeRestartTraffic(indexA, indexB);
    const invalidRpc = (credential) =>
      api(
        fixture,
        "POST",
        `/${fixture.repository}.git/git-upload-pack`,
        `Bearer ${credential}`,
        "not a Git packet",
        { contentType: "application/x-git-upload-pack-request" },
      );
    assert.equal((await invalidRpc("invalid")).status, 401);
    assert.equal((await invalidRpc(reader.body.token)).status, 502);
    assert.deepEqual(observedRpc(), [
      "git auth B",
      "git auth other",
      "upload-pack HTTP 401",
      "upload-pack HTTP 502",
    ]);
    await fixture.close();
    await assert.rejects(fixture.probeIssuedGit(indexB), /origin closed/);
    await fixture.close();
    await assert.rejects(api(fixture, "POST", issuePath, jwt, {}), { code: "ECONNREFUSED" });
  },
);

test("replacement permits only the original B credential's first issuer retirement", async (t) => {
  const origin = await startSkipperPrivateGitOrigin({ witnessIssuedGit: true });
  t.after(() => origin.close());
  const issue = async () => {
    const response = await api(
      origin,
      "POST",
      `/app/installations/${origin.installationId}/access_tokens`,
      `Bearer ${origin.createAppJwt()}`,
      { repository_ids: [73], permissions: { metadata: "read", contents: "write" } },
    );
    assert.equal(response.status, 201);
    return { auth: "Bearer " + response.body.token, index: origin.snapshot().tokens.at(-1).index };
  };
  const a = await issue();
  const b = await issue();
  const observe = () => origin.observeReplacementOrigin(a.index, b.index);
  const revoke = async (auth, options) =>
    (await api(origin, "DELETE", "/installation/token", auth, undefined, options)).status;
  const denied = (check) => assert.throws(check, { code: "ERR_ASSERTION" });
  const clean = observe();
  clean();
  assert.equal(await origin.probeIssuedGit(a.index), 200);
  denied(clean);
  clean(1);
  const git = observe();
  assert.equal(await origin.probeIssuedGit(b.index), 200);
  denied(() => git(1));
  const discovery = `/${origin.repository}.git/info/refs?service=git-upload-pack`;
  for (const [path, auth, status] of [
    [discovery, b.auth, 200],
    [discovery, undefined, 401],
    ["/unrecognized", a.auth, 404],
  ]) {
    const check = observe();
    assert.equal((await api(origin, "GET", path, auth)).status, status);
    denied(check);
  }
  origin.refuseTokenRetirement(a.index);
  const wrong = observe();
  assert.equal(await revoke(a.auth), 503);
  denied(wrong);
  const unknown = observe();
  assert.equal(await revoke("Bearer invalid"), 401);
  denied(unknown);
  const issuance = observe();
  await issue();
  denied(issuance);

  // B's first HTTP request can use TLS accepted before observation. A bare
  // connection opened afterward must still fail even though the totals rise by one each.
  const url = new URL(origin.origin);
  const options = { host: url.hostname, port: Number(url.port) };
  // The TLS connection already belongs to the baseline. Only the parsed request
  // can distinguish this traffic from an idle connection.
  for (const [name, headers, status] of [
    [
      "unsupported expectation",
      "GET / HTTP/1.1\r\nHost: fixture.invalid\r\nExpect: unsupported",
      417,
    ],
    ["missing Host", "GET / HTTP/1.1", 400],
    ["CONNECT", "CONNECT fixture.invalid:443 HTTP/1.1\r\nHost: fixture.invalid", undefined],
    [
      "upgrade",
      "GET / HTTP/1.1\r\nHost: fixture.invalid\r\nConnection: upgrade\r\nUpgrade: example",
      404,
    ],
  ]) {
    await t.test(name, { timeout: 5000 }, async (t) => {
      const socket = connectTls({ ...options, ca: origin.tls.ca });
      t.after(() => socket.destroy());
      await once(socket, "secureConnect");
      const check = observe();
      check();
      socket.setEncoding("ascii");
      let response = "";
      socket.on("data", (chunk) => (response += chunk));
      socket.end(headers + "\r\n\r\n");
      await once(socket, "end");
      if (status === undefined) {
        assert.equal(response, "");
      } else {
        assert.ok(response.startsWith(`HTTP/1.1 ${status} `));
      }
      denied(check);
    });
  }
  const tls = connectTls({ ...options, ca: origin.tls.ca });
  t.after(() => tls.destroy());
  await once(tls, "secureConnect");
  const withExtra = observe();
  const prior = origin.snapshot().connections;
  const raw = connect(options);
  t.after(() => raw.destroy());
  await once(raw, "connect");
  await waitUntil(
    "extra raw connection accepted",
    () => origin.snapshot().connections === prior + 1,
    3000,
  );
  const preconnected = observe();
  const agent = new Agent();
  agent.createConnection = () => tls;
  assert.equal(await revoke(b.auth, { agent }), 204);
  preconnected();
  denied(withExtra);
  assert.equal(await revoke(b.auth), 401);
  denied(preconnected);

  const next = await issue();
  const fresh = origin.observeReplacementOrigin(a.index, next.index);
  assert.equal(await revoke(next.auth), 204);
  fresh();

  const pipelined = await issue();
  const checkPipeline = origin.observeReplacementOrigin(a.index, pipelined.index);
  const pipeline = connectTls({ ...options, ca: origin.tls.ca });
  t.after(() => pipeline.destroy());
  await once(pipeline, "secureConnect");
  pipeline.resume();
  pipeline.write(
    `DELETE /installation/token HTTP/1.1\r\nHost: fixture.invalid\r\nAuthorization: ${pipelined.auth}\r\n\r\n` +
      "GET /unrecognized HTTP/1.1\r\nHost: fixture.invalid\r\nConnection: close\r\n\r\n",
  );
  await once(pipeline, "end");
  assert.equal(origin.snapshot().endpoints["other:503"], 1);
  denied(checkPipeline);
});

test(
  "private origin accepts caller TLS and an explicit bridge listener",
  { timeout: 30000 },
  async (t) => {
    const owner = await startSkipperPrivateGitOrigin();
    t.after(() => owner.close());
    const bridge = await startSkipperPrivateGitOrigin({
      host: "0.0.0.0",
      advertisedHost: "localhost",
      tls: owner.tls,
      repository: "fixture/bridge",
      approvalRef: "refs/heads/bridge",
    });
    t.after(() => bridge.close());
    assert.match(bridge.origin, /^https:\/\/localhost:\d+$/);
    assert.equal(bridge.repository, "fixture/bridge");
    const issued = await api(
      bridge,
      "POST",
      `/app/installations/${bridge.installationId}/access_tokens`,
      `Bearer ${bridge.createAppJwt()}`,
      { repository_ids: [73], permissions: { metadata: "read", contents: "write" } },
    );
    assert.equal(issued.status, 201);
    const before = bridge.snapshot();
    const bearer = "Bearer " + issued.body.token;
    const revoke = () => api(bridge, "DELETE", "/installation/token", bearer);
    assert.equal((await revoke()).status, 204);
    assertOnlyTokenRetirement(before, bridge.snapshot());
    assert.equal((await revoke()).status, 401);
    assert.throws(() => assertOnlyTokenRetirement(before, bridge.snapshot()), {
      code: "ERR_ASSERTION",
    });
  },
);

test(
  "private origin serves a gzip-encoded upload-pack negotiation (more than 20 refs)",
  { timeout: 60000 },
  async (t) => {
    // git remote-curl gzips every upload-pack request body over 1024 bytes, which a clone of a
    // repository with more than about 20 refs reaches. git http-backend inflates such a body only
    // when the CGI environment carries HTTP_CONTENT_ENCODING.
    const fixture = await startSkipperPrivateGitOrigin({ seedRefs: 40 });
    t.after(() => fixture.close());
    assert.equal(Object.keys(await fixture.readRefs()).length, 41);
    const directory = await temporaryDirectory(t, "private-git-gzip-");
    const caFile = join(directory, "ca.pem");
    await writeFile(caFile, fixture.tls.ca);
    const issued = await api(
      fixture,
      "POST",
      `/app/installations/${fixture.installationId}/access_tokens`,
      `Bearer ${fixture.createAppJwt()}`,
      {
        repository_ids: [Number(fixture.repositoryId)],
        permissions: { metadata: "read", contents: "write" },
      },
    );
    assert.equal(issued.status, 201);
    const env = cleanEnvironment({
      HOME: directory,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_SSL_CAINFO: caFile,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${issued.body.token}`).toString("base64")}`,
    });
    await run("git", ["clone", fixture.cloneUrl, "many-refs"], { cwd: directory, env });
    const cloned = await run("git", ["-C", join(directory, "many-refs"), "ls-remote", "origin"], {
      cwd: directory,
      env,
    });
    assert.equal(cloned.stdout.trim().split("\n").length, 42);
    const endpoints = fixture.snapshot().endpoints;
    assert.equal(endpoints["upload-pack:502"], undefined);
    assert.ok(endpoints["upload-pack:200"] >= 1);
  },
);
