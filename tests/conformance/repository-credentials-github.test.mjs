import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import {
  createGitHubDriverFactory,
  createGitHubKeyOwner,
} from "../../apps/controller/src/drivers/repo/github/credentials/index.ts";
import { validateServiceConfig } from "../../apps/controller/src/drivers/repo/credentials/configuration.ts";
import { createCredentialService } from "../../apps/controller/src/drivers/repo/credentials/service.ts";
import { createCustody } from "../../apps/controller/src/drivers/repo/credentials/custody.ts";
import { createGitHubPlanningFixture } from "../fixtures/repository-credentials/planning.mjs";
import { startGitHubFixture } from "../fixtures/repository-credentials/github.mjs";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import { eventually } from "../fixtures/repository-credentials/service.mjs";
import { createProviderTransport } from "../../apps/controller/src/drivers/repo/github/credentials/provider-transport.ts";
import {
  githubConfigurationData,
  requestHead,
  serviceConfigurationData,
} from "../fixtures/repository-credentials/builders.mjs";
import { availablePort } from "../helpers/available-port.mjs";

const config = validateServiceConfig(serviceConfigurationData());
function owner(factory, clock, profile, id, captured = () => {}, observeDispatch = () => {}) {
  const authority = { sessionId: id, ...factory.resolve(profile).binding };
  const attempts = new WeakSet();
  const records = new Map();
  let sequence = 0;
  const custody = {
    assertAttempt(attempt, action) {
      assert.ok(attempts.has(attempt));
      assert.equal(attempt.action, action);
    },
    capture(attempt, bytes, observation) {
      assert.ok(attempts.has(attempt));
      const ref = Object.freeze({});
      records.set(ref, { bytes: Buffer.from(bytes), observation });
      captured();
      return ref;
    },
    async withAccess(ref, purpose, consume) {
      assert.ok(records.has(ref));
      return consume(records.get(ref).bytes);
    },
  };
  const driver = factory.create({ authority, custody, clock });
  return {
    driver,
    records,
    authority,
    attempt(action, signal = new AbortController().signal) {
      const attempt = Object.freeze({
        id: `${id}-${++sequence}`,
        authority,
        action,
        deadlineMonoMs: clock.monotonicNow() + 30000,
        signal,
        assertAdmitted() {
          assert.ok(clock.monotonicNow() < this.deadlineMonoMs);
        },
        observeDispatch,
      });
      attempts.add(attempt);
      return attempt;
    },
  };
}
test("gateway authentication preserves canonical syntax, token bounds and route-specific challenges", async (t) => {
  const { factory } = await createGitHubPlanningFixture(t);
  const git = requestHead("GET", "/fixture/repository.git/info/refs?service=git-upload-pack");
  const api = requestHead("GET", "/repos/fixture/repository");
  const bearer = "a".repeat(43);
  const basic = (token, username = "gateway-session") =>
    `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
  const canonical = basic(bearer);
  for (const { name, head, authorization, expected } of [
    { name: "minimum Basic token", head: git, authorization: canonical, expected: bearer },
    {
      name: "maximum Basic token and mixed-case scheme",
      head: git,
      authorization: basic("_".repeat(256)).replace("Basic", "bAsIc"),
      expected: "_".repeat(256),
    },
    { name: "API token scheme", head: api, authorization: `token ${bearer}`, expected: bearer },
    {
      name: "API bearer scheme",
      head: api,
      authorization: `bEaReR ${bearer}`,
      expected: bearer,
    },
    {
      name: "maximum API token",
      head: api,
      authorization: `Bearer ${"_".repeat(256)}`,
      expected: "_".repeat(256),
    },
  ]) {
    await t.test(name, () => {
      assert.equal(factory.parseAuthentication(head, authorization), expected);
    });
  }
  const denied = { kind: "denied", status: 401, code: "invalid-credential" };
  for (const { name, head, authorization } of [
    { name: "missing Basic padding", head: git, authorization: canonical.slice(0, -1) },
    {
      name: "noncanonical Basic padding bits",
      head: git,
      authorization: `${canonical.slice(0, -2)}F=`,
    },
    { name: "wrong Basic username", head: git, authorization: basic(bearer, "other") },
    { name: "short Basic token", head: git, authorization: basic("a".repeat(42)) },
    { name: "long Basic token", head: git, authorization: basic("a".repeat(257)) },
    { name: "invalid Basic token characters", head: git, authorization: basic(`${bearer}:x`) },
    { name: "non-ASCII Basic token", head: git, authorization: basic(`${bearer}é`) },
    { name: "API scheme on Git route", head: git, authorization: `Bearer ${bearer}` },
    { name: "Basic scheme on API route", head: api, authorization: canonical },
    { name: "short API token", head: api, authorization: `Bearer ${"a".repeat(42)}` },
    { name: "long API token", head: api, authorization: `Bearer ${"a".repeat(257)}` },
    { name: "extra API whitespace", head: api, authorization: `Bearer  ${bearer}` },
    { name: "invalid API token characters", head: api, authorization: `token ${bearer}=` },
    { name: "oversized header", head: git, authorization: `Basic ${"A".repeat(4096)}` },
    { name: "absent authorization", head: git, authorization: undefined },
    { name: "non-string authorization", head: api, authorization: [bearer] },
  ]) {
    await t.test(`denies ${name}`, () => {
      assert.deepEqual(factory.parseAuthentication(head, authorization), denied);
    });
  }
  assert.deepEqual(factory.unauthenticated(git), {
    kind: "challenge",
    realm: "repository-credential-service",
  });
  for (const head of [
    api,
    requestHead("GET", "/other/repository.git/info/refs?service=git-upload-pack"),
    requestHead("GET", "/fixture/repository.git/info/refs?service=unknown"),
  ]) {
    assert.deepEqual(factory.unauthenticated(head), denied);
  }
});
test("Git endpoint spellings share authentication and canonical request plans", async (t) => {
  const { factory, bind } = await createGitHubPlanningFixture(t);
  const bearer = "a".repeat(43);
  const authorization = `Basic ${Buffer.from(`gateway-session:${bearer}`).toString("base64")}`;
  for (const repository of ["fixture/repository", "FiXtUrE/RePoSiToRy", "FiXtUrE/RePoSiToRy.git"]) {
    for (const service of ["upload", "receive"]) {
      for (const method of ["GET", "POST"]) {
        await t.test(`${method} ${repository} ${service}-pack`, () => {
          const endpoint =
            method === "GET" ? `info/refs?service=git-${service}-pack` : `git-${service}-pack`;
          const head = requestHead(method, `/${repository}/${endpoint}`, {
            "content-type": `application/x-git-${service}-pack-request`,
            "git-protocol": "version=2",
          });
          assert.equal(factory.unauthenticated(head).kind, "challenge");
          assert.equal(factory.parseAuthentication(head, authorization), bearer);
          for (const profile of ["git-read", "git-write", "git-full"]) {
            const plan = bind(profile).plan(head);
            if (profile === "git-read" && service === "receive") {
              assert.deepEqual(plan, { kind: "denied", status: 400, code: "unsupported-request" });
            } else {
              assert.equal(plan.kind, undefined);
              assert.equal(plan.origin, "https://github.com");
              assert.equal(plan.target, `/fixture/repository.git/${endpoint}`);
              assert.equal(plan.method, method);
              assert.equal(plan.effect, service === "receive" ? "write" : "read");
              const rpcCategory = service === "receive" ? "git-push" : "git-fetch";
              assert.equal(plan.category, method === "GET" ? "git-discovery" : rpcCategory);
            }
          }
        });
      }
    }
  }
});

test("Git normalization preserves raw endpoint and profile denial before acquisition", async (t) => {
  const clock = createControlledClock();
  const fixture = await startGitHubFixture(t, { clock });
  const key = createGitHubKeyOwner({ privateKey: fixture.privateKey, appId: "12345", clock });
  t.after(() => key.close());
  const factory = createGitHubDriverFactory({
    configuration: githubConfigurationData(),
    key,
    clock,
    gatewayOrigin: config.gateway.publicOrigin,
    limits: config.limits,
    trustedEndpoints: { apiOrigin: fixture.origin, gitOrigin: fixture.origin, ca: fixture.tls.ca },
  });
  const service = createCredentialService({ config, factory, clock });
  t.after(() => service.shutdown(1000));
  const full = service.open({ durationSeconds: 3600, profile: "git-full" });
  const read = service.open({ durationSeconds: 3600, profile: "git-read" });
  const discovery = "/FiXtUrE/RePoSiToRy/info/refs?service=git-upload-pack";
  const upload = "/FiXtUrE/RePoSiToRy/git-upload-pack";
  const headers = { "content-type": "application/x-git-upload-pack-request" };
  for (const [name, head] of [
    ["owner prefix", requestHead("GET", discovery.replace("FiXtUrE", "FiXtUrE-other"))],
    ["repository prefix", requestHead("GET", discovery.replace("RePoSiToRy", "RePoSiToRy-other"))],
    ["nested suffix", requestHead("GET", discovery.replace("RePoSiToRy", "RePoSiToRy.git.git"))],
    ["escaped character", requestHead("GET", discovery.replace("FiXtUrE", "%46iXtUrE"))],
    ["escaped separator", requestHead("GET", discovery.replace("FiXtUrE/", "FiXtUrE%2f"))],
    ["parent segment", requestHead("GET", discovery.replace("/info", "/../RePoSiToRy/info"))],
    ["dot segment", requestHead("GET", discovery.replace("/info", "/./info"))],
    ["extra separator", requestHead("GET", discovery.replace("/info", "//info"))],
    ["network path", requestHead("GET", `/${discovery}`)],
    ["absolute target", requestHead("GET", `https://github.com${discovery}`)],
    ["fragment", requestHead("GET", `${discovery}#fragment`)],
    ["endpoint casing", requestHead("GET", discovery.replace("info/refs", "Info/Refs"))],
    ["extra path", requestHead("GET", discovery.replace("info/refs", "info/refs/extra"))],
    ["discovery method", requestHead("POST", discovery)],
    ["missing service", requestHead("GET", discovery.split("?")[0])],
    ["unknown service", requestHead("GET", discovery.replace("git-upload-pack", "other"))],
    ["escaped service", requestHead("GET", discovery.replace("git-upload", "%67it-upload"))],
    ["duplicate query", requestHead("GET", `${discovery}&service=git-upload-pack`)],
    ["extra query", requestHead("GET", `${discovery}&extra=1`)],
    ["RPC method", requestHead("GET", upload, headers)],
    ["RPC query", requestHead("POST", `${upload}?service=git-upload-pack`, headers)],
    ["RPC media", requestHead("POST", upload)],
    [
      "RPC media parameters",
      requestHead("POST", upload, { "content-type": `${headers["content-type"]}; charset=utf-8` }),
    ],
    ["protocol version", requestHead("GET", discovery, { "git-protocol": "version=1" })],
  ]) {
    await t.test(`denies ${name}`, () => {
      assert.equal(factory.unauthenticated(head).kind, "denied");
      const basic = `Basic ${Buffer.from(`gateway-session:${full.bearer}`).toString("base64")}`;
      assert.equal(factory.parseAuthentication(head, basic).kind, "denied");
      assert.deepEqual(service.reserve(full.bearer, head, new AbortController().signal), {
        kind: "denied",
        status: 400,
        code: "unsupported-request",
      });
    });
  }
  for (const repository of ["FiXtUrE/RePoSiToRy", "FiXtUrE/RePoSiToRy.git"]) {
    for (const head of [
      requestHead("GET", `/${repository}/info/refs?service=git-receive-pack`),
      requestHead("POST", `/${repository}/git-receive-pack`, {
        "content-type": "application/x-git-receive-pack-request",
      }),
    ]) {
      assert.equal(factory.unauthenticated(head).kind, "challenge");
      assert.equal(service.reserve(read.bearer, head, new AbortController().signal).kind, "denied");
    }
  }
  // Case/suffix normalization belongs to Git endpoints, not the REST policy.
  for (const path of ["/repos/FiXtUrE/RePoSiToRy", "/repos/fixture/repository.git"]) {
    assert.equal(
      service.reserve(full.bearer, requestHead("GET", path), new AbortController().signal).kind,
      "denied",
    );
  }
  const api = service.reserve(
    full.bearer,
    requestHead("GET", "/repos/fixture/repository"),
    new AbortController().signal,
  );
  assert.equal(service.plan(api).target, "/repos/fixture/repository");
  service.cancel(api);
  // Rejected requests cannot reach provider issuance or upstream mutation.
  assert.equal(fixture.issuesOfTokens.length, 0);
  assert.deepEqual(fixture.trace, []);
  assert.deepEqual(fixture.errors, []);
});

test("literal .git repository names normalize against the admitted identity", async (t) => {
  const { key } = await createGitHubPlanningFixture(t);
  const clock = createControlledClock();
  const factory = createGitHubDriverFactory({
    configuration: githubConfigurationData({ repository: "Fixture/Repository.git" }),
    key,
    clock,
    gatewayOrigin: config.gateway.publicOrigin,
    limits: config.limits,
  });
  const bound = owner(factory, clock, "git-write", "literal-suffix");
  for (const repository of ["fixture/repository.git", "FIXTURE/REPOSITORY.GIT.git"]) {
    const head = requestHead("GET", `/${repository}/info/refs?service=git-upload-pack`);
    assert.equal(factory.unauthenticated(head).kind, "challenge");
    const plan = bound.driver.plan({ authority: bound.authority, session: {}, head });
    assert.equal(plan.target, "/Fixture/Repository.git.git/info/refs?service=git-upload-pack");
  }
  // A literal suffix is part of this grant's identity; stripping it would select another repository.
  for (const repository of ["fixture/repository", "fixture/repository.git.git.git"]) {
    const head = requestHead("GET", `/${repository}/info/refs?service=git-upload-pack`);
    assert.equal(factory.unauthenticated(head).kind, "denied");
    assert.equal(
      bound.driver.plan({ authority: bound.authority, session: {}, head }).kind,
      "denied",
    );
  }
});

test("GitHub request plans reconstruct headers without forwarding caller credentials", async (t) => {
  const { bind } = await createGitHubPlanningFixture(t);
  const backend = bind();
  const inbound = {
    authorization: "caller-credential",
    cookie: "caller-cookie",
    host: "other.example",
    connection: "keep-alive",
    "content-length": "500",
    "user-agent": "caller-agent",
    "accept-encoding": "gzip",
  };
  const git = backend.plan(
    requestHead("GET", "/fixture/repository.git/info/refs?service=git-upload-pack", {
      ...inbound,
      accept: "application/x-git-upload-pack-advertisement",
      "git-protocol": "version=2",
    }),
  );
  assert.deepEqual(git.requestHeaders, {
    "user-agent": "openclaw-enterprise-repository-credentials",
    "accept-encoding": "identity",
    "git-protocol": "version=2",
    accept: "application/x-git-upload-pack-advertisement",
  });
  const api = backend.plan(requestHead("POST", "/repos/fixture/repository/pulls", inbound));
  assert.deepEqual(api.requestHeaders, {
    "user-agent": "openclaw-enterprise-repository-credentials",
    "accept-encoding": "identity",
    accept: "application/vnd.github+json",
    "x-github-api-version": "2026-03-10",
    "content-type": "application/json",
  });
  assert.ok(Object.isFrozen(git.requestHeaders));
  assert.ok(Object.isFrozen(api.requestHeaders));
});
test("provider transport pins destination and exact issuance scope before receiving credentials", async (t) => {
  const clock = createControlledClock();
  const fixture = await startGitHubFixture(t, { clock });
  const key = createGitHubKeyOwner({ privateKey: fixture.privateKey, appId: "12345", clock });
  t.after(() => key.close());
  const scope = { installationId: "41", repositoryId: "73", profile: "git-read" };
  for (const { name, origin } of [
    { name: "plaintext origin", origin: "http://localhost" },
    { name: "origin with user info", origin: "https://user@example.test" },
    { name: "origin with path", origin: `${fixture.origin}/path` },
  ]) {
    await t.test(`refuses ${name}`, () => {
      assert.throws(() => createProviderTransport(origin, fixture.tls.ca, clock, scope));
    });
  }
  for (const { name, installationId } of [
    { name: "network path", installationId: "//other.example" },
    { name: "absolute URL", installationId: "https://other.example" },
    { name: "parent traversal", installationId: "41/../42" },
    { name: "query", installationId: "41?x=1" },
  ]) {
    await t.test(`refuses installation ${name}`, () => {
      assert.throws(() =>
        createProviderTransport(fixture.origin, fixture.tls.ca, clock, {
          ...scope,
          installationId,
        }),
      );
    });
  }
  for (const { name, changes } of [
    { name: "unsafe repository integer", changes: { repositoryId: "9007199254740992" } },
    { name: "numeric repository ID", changes: { repositoryId: 73 } },
    { name: "numeric installation ID", changes: { installationId: 41 } },
    { name: "prototype profile", changes: { profile: "__proto__" } },
  ]) {
    await t.test(`refuses ${name}`, () => {
      assert.throws(() =>
        createProviderTransport(fixture.origin, fixture.tls.ca, clock, { ...scope, ...changes }),
      );
    });
  }
  let installationReads = 0;
  const transportScope = {
    ...scope,
    get installationId() {
      return ++installationReads === 1 ? "41" : "42";
    },
  };
  const transport = createProviderTransport(fixture.origin, fixture.tls.ca, clock, transportScope);
  assert.equal(installationReads, 1);
  assert.deepEqual(Object.keys(transport).sort(), ["issue", "revoke"]);
  assert.ok(Object.isFrozen(transport));
  // A later caller cannot replace the URL, request body, or admitted permission map.
  transportScope.repositoryId = "74";
  transportScope.profile = "git-full";
  let dispatches = 0;
  let observations = 0;
  const attempt = (action) => ({
    action,
    deadlineMonoMs: clock.monotonicNow() + 30000,
    signal: new AbortController().signal,
    assertAdmitted() {},
    observeDispatch() {},
  });
  const onDispatch = () => dispatches++;
  const observeResponse = () => observations++;
  for (const { name, authorization } of [
    { name: "header injection", authorization: "unsafe\r\nHeader: value" },
    { name: "empty authorization", authorization: "" },
    { name: "authorization object", authorization: { path: "//other.example" } },
  ]) {
    await t.test(`refuses ${name} before dispatch`, async () => {
      await assert.rejects(
        transport.issue(authorization, attempt("acquire"), onDispatch, () => {}, observeResponse),
        /provider-unavailable/,
      );
    });
  }
  assert.equal(dispatches, 0);
  assert.equal(fixture.issuesOfTokens.length, 0);
  const issued = await key.withJwt((jwt, assertCurrent) =>
    transport.issue(jwt, attempt("acquire"), onDispatch, assertCurrent, observeResponse),
  );
  let token;
  try {
    assert.equal(issued.status, 201);
    token = JSON.parse(issued.body.toString()).token;
  } finally {
    issued.body.fill(0);
  }
  assert.equal(observations, 1);
  assert.deepEqual(fixture.issuesOfTokens[0].repositoryIds, [73]);
  assert.deepEqual(fixture.issuesOfTokens[0].permissions, {
    metadata: "read",
    contents: "read",
    issues: "read",
    pull_requests: "read",
    checks: "read",
    statuses: "read",
  });
  const revoked = await transport.revoke(token, attempt("retire"), onDispatch);
  try {
    assert.equal(revoked.status, 204);
  } finally {
    revoked.body.fill(0);
  }
  assert.equal(dispatches, 2);
  assert.equal(fixture.tokenState()[0].revoked, true);
  assert.deepEqual(fixture.errors, []);
});
test("real HTTPS issuance preserves exact profiles after hour 13 and revokes with owned token after key closure", async (t) => {
  const clock = createControlledClock();
  const providerClock = createControlledClock(clock.wallNow());
  const fixture = await startGitHubFixture(t, { clock: providerClock });
  const key = createGitHubKeyOwner({ privateKey: fixture.privateKey, appId: "12345", clock });
  const factory = createGitHubDriverFactory({
    configuration: githubConfigurationData({
      providerInstanceId: "fixture-instance",
      configVersion: "v1",
      repository: "Fixture/Repository",
    }),
    key,
    clock,
    gatewayOrigin: config.gateway.publicOrigin,
    limits: config.limits,
    trustedEndpoints: { apiOrigin: fixture.origin, gitOrigin: fixture.origin, ca: fixture.tls.ca },
  });
  const first = owner(factory, clock, "git-write", "one");
  const second = owner(factory, clock, "git-full", "two");
  const originalAttempt = first.attempt("acquire");
  await assert.rejects(first.driver.acquire({ ...originalAttempt }, undefined, 360000));
  const a = await first.driver.acquire(originalAttempt, undefined, 360000);
  assert.equal(a.kind, "acquired");
  await assert.rejects(first.driver.settle({ ...a }), /foreign-outcome/);
  await first.driver.settle(a);
  const finished = await first.driver.finalize(first.attempt("finalize"));
  assert.equal(finished.kind, "finalized");
  await first.driver.settle(finished);
  const b = await second.driver.acquire(second.attempt("acquire"), undefined, 360000);
  assert.equal(b.kind, "acquired");
  await second.driver.settle(b);
  await providerClock.advance(13 * 3600000 + 1);
  await clock.advance(13 * 3600000 + 1);
  const c = await second.driver.acquire(second.attempt("acquire"), b.credential, 360000);
  assert.equal(c.kind, "acquired");
  await second.driver.settle(c);
  assert.deepEqual(
    fixture.issuesOfTokens.map((item) => item.permissions),
    [
      {
        metadata: "read",
        contents: "write",
        issues: "read",
        pull_requests: "write",
        checks: "read",
        statuses: "read",
      },
      {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
        issues: "write",
        checks: "read",
        statuses: "read",
      },
      {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
        issues: "write",
        checks: "read",
        statuses: "read",
      },
    ],
  );
  assert.notEqual(fixture.issuesOfTokens[1].claims.iat, fixture.issuesOfTokens[2].claims.iat);
  await assert.rejects(
    second.driver.retire(second.attempt("retire"), a.credential),
    /foreign-credential/,
  );
  const head = requestHead(
    "GET",
    "/repos/Fixture/Repository",
    {},
    {
      receivedMonoMs: clock.monotonicNow(),
    },
  );
  const plan = second.driver.plan({ authority: second.authority, session: {}, head });
  // GitHub returns canonical identity casing even when configuration retains capitals.
  const issuePlan = second.driver.plan({
    authority: second.authority,
    session: {},
    head: {
      ...head,
      method: "POST",
      rawTarget: "/repos/Fixture/Repository/issues",
      headers: { "content-type": "application/json" },
    },
  });
  const canonicalIssue = "https://api.github.com/repos/fixture/repository/issues/1";
  assert.deepEqual(
    issuePlan.responsePolicy.rewriteJson({ url: canonicalIssue, body: canonicalIssue }),
    {
      url: "https://credentials.example/repos/Fixture/Repository/issues/1",
      body: canonicalIssue,
    },
  );
  for (const prefix of ["repos/fixture/repository", "repositories/73"]) {
    await t.test(`rewrites canonical pagination from ${prefix}`, () => {
      assert.equal(
        issuePlan.responsePolicy.headers(200, {
          link: `<https://api.github.com/${prefix}/issues?after=Y3Vyc29yOnYyOjE%3D&page=2>; rel="next"`,
        }).link,
        '<https://credentials.example/repos/Fixture/Repository/issues?after=Y3Vyc29yOnYyOjE%3D&page=2>; rel="next"',
      );
    });
  }
  for (const { name, target } of [
    { name: "repository prefix", target: "repos/fixture/repository-other/issues/1" },
    { name: "owner prefix", target: "repos/fixture-other/repository/issues/1" },
    { name: "resource casing", target: "repos/fixture/repository/Issues/1" },
    { name: "route casing", target: "REPOS/fixture/repository/issues/1" },
    { name: "cursor on item", target: "repos/fixture/repository/issues/1?after=cursor" },
    { name: "repository ID prefix", target: "repositories/730/issues/1" },
  ]) {
    await t.test(`rejects ${name}`, () => {
      assert.throws(
        () => issuePlan.responsePolicy.rewriteJson({ url: `https://api.github.com/${target}` }),
        /unsafe-upstream-url/,
      );
    });
  }
  await assert.rejects(
    second.driver.withAuthentication(c.credential, { ...plan }, async () => {}),
    /invalid-credential/,
  );
  await second.driver.withAuthentication(c.credential, plan, async (request) =>
    assert.equal(fixture.authorize(request.headers.authorization), true),
  );
  // A local wall jump denies authentication but does not expire the provider token.
  await clock.advance(0, 2 * 3600000);
  await assert.rejects(
    second.driver.withAuthentication(c.credential, plan, async () =>
      assert.fail("a forward wall jump must deny authentication"),
    ),
    /invalid-credential/,
  );
  key.close();
  const retired = await second.driver.retire(second.attempt("retire"), c.credential);
  assert.equal(retired.kind, "revoked");
  await second.driver.settle(retired);
  assert.equal(fixture.tokenState().at(-1).revoked, true);
  assert.deepEqual(fixture.errors, []);
  for (const owned of [first, second]) {
    for (const record of owned.records.values()) {
      record.bytes.fill(0);
    }
  }
});
test("refused and cancelled observations remain independently captured and token-owned cleanup succeeds", async (t) => {
  const clock = createControlledClock();
  const providerClock = createControlledClock(clock.wallNow() + 5000);
  let mode = "surplus";
  const fixture = await startGitHubFixture(t, {
    clock: providerClock,
    issueResponse({ status, body }) {
      if (mode === "surplus") {
        return {
          status,
          body: { ...body, permissions: { ...body.permissions, administration: "write" } },
        };
      }
      if (mode === "missing-checks") {
        const { checks: _checks, ...permissions } = body.permissions;
        return { status, body: { ...body, permissions } };
      }
      if (mode === "refused") {
        return { status: 403, body };
      }
      if (mode === "excess-skew") {
        return {
          status,
          body: { ...body, expires_at: new Date(clock.wallNow() + 3660001).toISOString() },
        };
      }
      if (mode === "short") {
        return {
          status,
          body: { ...body, expires_at: new Date(clock.wallNow() + 1000).toISOString() },
        };
      }
      return { status, body };
    },
  });
  const key = createGitHubKeyOwner({ privateKey: fixture.privateKey, appId: "12345", clock });
  t.after(() => key.close());
  const factory = createGitHubDriverFactory({
    configuration: githubConfigurationData({
      providerInstanceId: "fixture-instance",
    }),
    key,
    clock,
    gatewayOrigin: config.gateway.publicOrigin,
    limits: config.limits,
    trustedEndpoints: { apiOrigin: fixture.origin, gitOrigin: fixture.origin, ca: fixture.tls.ca },
  });
  for (const { name, selected, expected } of [
    { name: "surplus permissions", selected: "surplus", expected: "rejected" },
    { name: "missing checks permission", selected: "missing-checks", expected: "rejected" },
    { name: "provider refusal", selected: "refused", expected: "reauthorization-required" },
    { name: "insufficient lifetime", selected: "short", expected: "rejected" },
    { name: "closure during capture", selected: "cancel", expected: "uncertain" },
    { name: "excessive provider skew", selected: "excess-skew", expected: "rejected" },
    { name: "bounded provider skew", selected: "valid-skew", expected: "acquired" },
  ]) {
    await t.test(`${name} retains token-owned cleanup`, async () => {
      mode = selected;
      const abort = new AbortController();
      // Closure during the original material callback cannot remove the cleanup obligation.
      const owned = owner(factory, clock, "git-full", selected, () => {
        if (selected === "cancel") {
          abort.abort();
        }
      });
      const result = await owned.driver.acquire(
        owned.attempt("acquire", abort.signal),
        undefined,
        360000,
      );
      assert.equal(result.kind, expected);
      assert.equal(owned.records.size, 1);
      await owned.driver.settle(result);
      const [credential] = owned.records.keys();
      const plan = owned.driver.plan({
        authority: owned.authority,
        session: {},
        head: requestHead("GET", "/repos/fixture/repository"),
      });
      if (selected === "valid-skew") {
        await owned.driver.withAuthentication(credential, plan, async ({ headers }) =>
          assert.equal(fixture.authorize(headers.authorization), true),
        );
        // Service wall time stays behind while independent provider time advances.
        // Authentication must stop conservatively; the still-live token needs DELETE.
        await providerClock.advance(3595000);
        await clock.advance(3595000, 0);
        assert.ok(fixture.tokenState().at(-1).expires > providerClock.wallNow());
      }
      await assert.rejects(
        owned.driver.withAuthentication(credential, plan, async () =>
          assert.fail("refused material cannot authenticate"),
        ),
        /invalid-credential/,
      );
      const cleanup = await owned.driver.retire(owned.attempt("retire"), credential);
      assert.equal(cleanup.kind, "revoked");
      await owned.driver.settle(cleanup);
      for (const record of owned.records.values()) {
        record.bytes.fill(0);
      }
    });
  }
  assert.ok(fixture.tokenState().every((token) => token.revoked));
  assert.deepEqual(fixture.errors, []);
});

test("token issue failures before a connection are definite; after one they stay uncertain", async (t) => {
  const clock = createControlledClock();
  const fixture = await startGitHubFixture(t, { clock });
  const key = createGitHubKeyOwner({ privateKey: fixture.privateKey, appId: "12345", clock });
  t.after(() => key.close());
  // A closed port refuses the connection; a raw TCP server accepts and then drops it.
  const refused = `https://127.0.0.1:${await availablePort()}`;
  const dropping = createNetServer((socket) => socket.destroy());
  await new Promise((resolve) => dropping.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => dropping.close(resolve)));
  const factoryFor = (origin) =>
    createGitHubDriverFactory({
      configuration: githubConfigurationData({ providerInstanceId: "fixture-instance" }),
      key,
      clock,
      gatewayOrigin: config.gateway.publicOrigin,
      limits: config.limits,
      trustedEndpoints: { apiOrigin: origin, gitOrigin: origin, ca: fixture.tls.ca },
    });
  const closedAtConnect = () => {
    throw new Error("ATTEMPT_CLOSED");
  };
  for (const { name, origin, observeDispatch, expected } of [
    { name: "connection refused", origin: refused, expected: "not-dispatched" },
    {
      name: "connection dropped",
      origin: `https://127.0.0.1:${dropping.address().port}`,
      expected: "uncertain",
    },
    // Admission closing before connect cancels the request before any byte is sent.
    {
      name: "admission closed at connect",
      origin: fixture.origin,
      observeDispatch: closedAtConnect,
      expected: "not-dispatched",
    },
  ]) {
    await t.test(name, async () => {
      const owned = owner(factoryFor(origin), clock, "git-read", name, undefined, observeDispatch);
      const result = await owned.driver.acquire(owned.attempt("acquire"), undefined, 360000);
      assert.equal(result.kind, expected);
      await owned.driver.settle(result);
      assert.equal(owned.records.size, 0);
    });
  }
  assert.deepEqual(fixture.trace, []);

  // A definite failure releases the reservation, so a closed session reaches DISPOSED.
  const service = createCredentialService({ config, factory: factoryFor(refused), clock });
  t.after(async () => {
    // Grace runs on the controlled clock; advance it so a stuck session cannot hang.
    const stopped = service.shutdown(1000);
    await clock.advance(1000);
    await stopped;
  });
  const opened = service.open({ durationSeconds: 3600, profile: "git-read" });
  const exchange = service.reserve(
    opened.bearer,
    requestHead("GET", "/repos/fixture/repository"),
    new AbortController().signal,
  );
  const outcome = await service.execute(exchange, async () =>
    assert.fail("no upstream exchange without a credential"),
  );
  assert.equal(outcome.kind, "not-dispatched");
  service.close(opened.session.sessionId);
  await clock.advance(0);
  await eventually(() => service.status(opened.session.sessionId)?.state === "DISPOSED");
});

test("retirement uncertainty retains real custody after non-204 replies and lost responses", async (t) => {
  for (const { name, revokeStatus, disconnect, revoked } of [
    { name: "accepted without confirmation", revokeStatus: 202, disconnect: false, revoked: false },
    { name: "provider unavailable", revokeStatus: 503, disconnect: false, revoked: false },
    { name: "response lost after revocation", revokeStatus: 204, disconnect: true, revoked: true },
  ]) {
    await t.test(name, async (t) => {
      const clock = createControlledClock();
      const fixture = await startGitHubFixture(t, { clock, revokeStatus });
      const key = createGitHubKeyOwner({ privateKey: fixture.privateKey, appId: "12345", clock });
      t.after(() => key.close());
      const factory = createGitHubDriverFactory({
        configuration: githubConfigurationData({ providerInstanceId: "fixture-instance" }),
        key,
        clock,
        gatewayOrigin: config.gateway.publicOrigin,
        limits: config.limits,
        trustedEndpoints: {
          apiOrigin: fixture.origin,
          gitOrigin: fixture.origin,
          ca: fixture.tls.ca,
        },
      });
      const authority = { sessionId: name, ...factory.resolve("git-read").binding };
      const custody = createCustody({
        clock,
        maximumSlots: 1,
        maximumAccessBytes: 16384,
        maximumRenewalBytes: 16384,
        maximumCallbacks: 1,
        admitted: () => true,
        changed() {},
      });
      const driver = factory.create({ authority, custody: custody.driver, clock });
      let sequence = 0;
      let dispatches = 0;
      const attempt = (action) => {
        const value = Object.freeze({
          id: `${name}-${++sequence}`,
          authority,
          action,
          deadlineMonoMs: clock.monotonicNow() + 30000,
          signal: new AbortController().signal,
          assertAdmitted() {
            assert.ok(clock.monotonicNow() < this.deadlineMonoMs);
          },
          observeDispatch() {
            dispatches++;
          },
        });
        custody.register(value);
        return value;
      };
      const acquisition = attempt("acquire");
      const reservation = custody.reserve(acquisition);
      const acquired = await driver.acquire(acquisition, undefined, 360000);
      assert.equal(acquired.kind, "acquired");
      await driver.settle(acquired);
      custody.settle(reservation);
      const record = custody.lookup(acquired.credential);
      if (disconnect) {
        // The provider commits revocation before dropping the reply; the driver cannot confirm it.
        fixture.disconnectAfterMutation("DELETE", "/installation/token");
      }
      const retirement = attempt("retire");
      const result = await driver.retire(retirement, acquired.credential);
      assert.equal(result.kind, "uncertain");
      await assert.rejects(driver.settle({ ...result }), /foreign-outcome/);
      await driver.settle(result);
      custody.endAttempt(retirement);
      assert.equal(dispatches, 2);
      assert.equal(fixture.trace.filter((entry) => entry.method === "DELETE").length, 1);
      assert.equal(fixture.tokenState()[0].revoked, revoked);
      assert.equal(record.callbacks, 0);
      assert.ok(custody.records.has(record));
      assert.throws(() => custody.release(record), /CREDENTIAL_BUSY/);
      // Uncertainty retains the original token; only the conservative expiry bound ends custody.
      await custody.driver.withAccess(acquired.credential, "retire", async (bytes) => {
        assert.equal(fixture.authorize(`Bearer ${Buffer.from(bytes).toString("utf8")}`), !revoked);
      });
      await clock.advance(3600000);
      const expiration = attempt("retire");
      const expired = await driver.retire(expiration, acquired.credential);
      assert.equal(expired.kind, "expired");
      await driver.settle(expired);
      custody.endAttempt(expiration);
      record.disposition = "expired";
      custody.release(record);
      assert.equal(dispatches, 2);
      assert.equal(custody.records.size, 0);
      assert.equal(custody.reservations.size, 0);
      assert.deepEqual(fixture.errors, []);
    });
  }
});
