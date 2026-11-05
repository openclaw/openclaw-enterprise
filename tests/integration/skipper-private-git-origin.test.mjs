import assert from "node:assert/strict";
import { request } from "node:https";
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

function api(fixture, method, path, authorization, body, afterHeaders) {
  return new Promise((resolve, reject) => {
    const req = request(
      new URL(path, fixture.origin),
      {
        method,
        agent: false,
        ca: fixture.tls.ca ?? fixture.tls.cert,
        headers: { authorization, "content-type": "application/json" },
        timeout: 10000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined,
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
    await git(["clone", fixture.cloneUrl, "client"], token);
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
    await git(["clone", fixture.cloneUrl, "read-only"], reader.body.token);
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
        afterHeaders,
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
    const snapshot = fixture.snapshot();
    assert.equal(snapshot.issued, 5);
    assert.ok(snapshot.endpoints["upload-pack:200"] >= 2);
    assert.ok(snapshot.endpoints["receive-pack:200"] >= 4);
    assert.ok(snapshot.endpoints["other:404"] >= 1);
    assert.equal(JSON.stringify(snapshot).includes(token), false);
    assert.equal(JSON.stringify(snapshot).includes(jwt), false);
    await fixture.close();
    await fixture.close();
    await assert.rejects(api(fixture, "POST", issuePath, jwt, {}), { code: "ECONNREFUSED" });
  },
);

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
