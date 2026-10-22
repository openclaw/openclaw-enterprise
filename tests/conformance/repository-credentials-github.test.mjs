import test from "node:test";
import assert from "node:assert/strict";
import { parseInstallationTokenResponse } from "../../apps/controller/src/drivers/repo/github/credentials/driver/acquisition-response.ts";
import { parseUnambiguousJson } from "../../apps/controller/src/drivers/repo/credentials/json-members.ts";
import { createGitHubKeyOwner } from "../../apps/controller/src/drivers/repo/github/credentials/material.ts";
import { validateServiceConfig } from "../../apps/controller/src/drivers/repo/credentials/configuration.ts";
import { createCredentialService } from "../../apps/controller/src/drivers/repo/credentials/service.ts";
import { createGitHubPlanningFixture } from "../fixtures/repository-credentials/planning.mjs";
import { startGitHubFixture } from "../fixtures/repository-credentials/github.mjs";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import { createProviderTransport } from "../../apps/controller/src/drivers/repo/github/credentials/provider-transport.ts";
import {
  requestHead,
  serviceConfigurationData,
} from "../fixtures/repository-credentials/builders.mjs";

const config = validateServiceConfig(serviceConfigurationData());
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
  const { factory, clock } = await createGitHubPlanningFixture(t);
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
});

test("literal .git repository names normalize against the admitted identity", async (t) => {
  const { factory, bind } = await createGitHubPlanningFixture(t, {
    repository: "Fixture/Repository.git",
  });
  const bound = bind("git-write");
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
      assert.throws(() => createProviderTransport(origin, fixture.tls.ca, clock, scope), {
        message: "invalid-provider-origin",
      });
    });
  }
  for (const { name, installationId } of [
    { name: "network path", installationId: "//other.example" },
    { name: "absolute URL", installationId: "https://other.example" },
    { name: "parent traversal", installationId: "41/../42" },
    { name: "query", installationId: "41?x=1" },
  ]) {
    await t.test(`refuses installation ${name}`, () => {
      assert.throws(
        () =>
          createProviderTransport(fixture.origin, fixture.tls.ca, clock, {
            ...scope,
            installationId,
          }),
        { message: "invalid-provider-scope" },
      );
    });
  }
  const invalidScope = { message: "invalid-provider-scope" };
  for (const { name, changes, refusal } of [
    {
      name: "unsafe repository integer",
      changes: { repositoryId: "9007199254740992" },
      refusal: invalidScope,
    },
    { name: "numeric repository ID", changes: { repositoryId: 73 }, refusal: invalidScope },
    { name: "numeric installation ID", changes: { installationId: 41 }, refusal: invalidScope },
    {
      name: "prototype profile",
      changes: { profile: "__proto__" },
      refusal: { message: "unsupported-profile" },
    },
  ]) {
    await t.test(`refuses ${name}`, () => {
      assert.throws(
        () =>
          createProviderTransport(fixture.origin, fixture.tls.ca, clock, { ...scope, ...changes }),
        refusal,
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
test("canonical GitHub responses preserve admitted repository identity", async (t) => {
  const { bind } = await createGitHubPlanningFixture(t, { repository: "Fixture/Repository" });
  const issuePlan = bind("git-full").plan(requestHead("POST", "/repos/Fixture/Repository/issues"));
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
});
test("installation response parsing separates unique root custody from unambiguous evidence", () => {
  const cases = [
    ['{"token":"owned","permissions":{"contents":"read"}}', "owned", true],
    ['{"token":"owned","permissions":{"contents":"write","contents":"read"}}', "owned", false],
    ['{"token":"owned","permissions":{},"permissions":{}}', "owned", false],
    ['{"token":"owned","unknown":1,"unknown":2}', "owned", false],
    ['{"token":"owned","nested":{"token":"a","token":"b"}}', "owned", false],
    ['{"token":"owned","nested":[{"token":"a","token":"b"}]}', "owned", false],
    ['{"token":"owned","token":"owned"}', undefined, false],
    [String.raw`{"token":"owned","to\u006ben":"other"}`, undefined, false],
    ['{"token":"owned","nested":{"token":"other"}}', "owned", true],
    ['{"token":""}', undefined, true],
    ['{"nested":{"token":"other"}}', undefined, true],
    ['[{"token":"owned"}]', undefined, false],
    ["null", undefined, false],
    ['"owned"', undefined, false],
    ['{"token":"owned",', undefined, false],
    [
      Buffer.concat([
        Buffer.from('{"token":"owned","unknown":"'),
        Buffer.from([0xff]),
        Buffer.from('"}'),
      ]),
      undefined,
      false,
    ],
  ];
  for (const [input, token, usable] of cases) {
    const parsed = parseInstallationTokenResponse(Buffer.from(input));
    assert.equal(parsed.token, token);
    assert.equal(parsed.packet !== undefined, usable);
  }
  // The rehomed strict consumer still rejects decoded duplicates at any depth.
  assert.throws(
    () => parseUnambiguousJson(String.raw`{"a":[{"x":1,"\u0078":2}]}`),
    /Ambiguous JSON/,
  );
  assert.deepEqual(parseUnambiguousJson('{"a":{"x":1},"b":{"x":2}}'), { a: { x: 1 }, b: { x: 2 } });
});
