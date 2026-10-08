import test from "node:test";
import assert from "node:assert/strict";
import { verify } from "node:crypto";
import { request } from "node:https";
import { access } from "node:fs/promises";
import { createGitHubPlanningFixture } from "../fixtures/repository-credentials/planning.mjs";
import {
  createResourceScope,
  createTestResourceScope,
} from "../fixtures/repository-credentials/resources.mjs";
import {
  temporaryDirectory,
  createTlsMaterial,
} from "../fixtures/repository-credentials/process.mjs";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import { createLoopbackServiceConfiguration } from "../fixtures/repository-credentials/service.mjs";
import { startGitHubFixture } from "../fixtures/repository-credentials/github.mjs";
import { startGitSmartHttpFixture } from "../fixtures/repository-credentials/git.mjs";
import {
  createGitHubServiceFactory,
  startServiceListeners,
  writeSessionClientConfiguration,
} from "../fixtures/repository-credentials/service-resources.mjs";
import {
  requestHead as head,
  issueResponse,
  pullResponse,
} from "../fixtures/repository-credentials/builders.mjs";

test("GitHub driver admits exact REST methods, conservative GraphQL writes and configured Git routes", async (t) => {
  const { factory, bind } = await createGitHubPlanningFixture(t);
  const routes = [
    ["/repos/fixture/repository", ["GET"]],
    ["/repos/fixture/repository/pulls", ["GET", "POST"]],
    ["/repos/fixture/repository/pulls/1", ["GET", "PATCH"]],
    ["/repos/fixture/repository/issues", ["GET", "POST"]],
    ["/repos/fixture/repository/issues/1", ["GET", "PATCH"]],
    ["/repos/fixture/repository/issues/1/comments", ["GET", "POST"]],
    ["/repos/fixture/repository/issues/comments/1", ["GET", "PATCH", "DELETE"]],
    ["/graphql", ["POST"]],
    ["/meta", ["GET"]],
  ];
  const routeScenarios = routes.flatMap(([path, methods]) =>
    ["GET", "POST", "PATCH", "DELETE", "PUT"].map((method) => ({
      name: `${method} ${path} is ${methods.includes(method) ? "admitted" : "denied"}`,
      request: head(method, path),
      admitted: methods.includes(method),
      effect: method === "GET" ? "read" : "write",
    })),
  );
  for (const scenario of routeScenarios) {
    await t.test(scenario.name, () => {
      const plan = bind().plan(scenario.request);
      assert.equal("kind" in plan, !scenario.admitted);
      if (!("kind" in plan)) {
        assert.equal(plan.effect, scenario.effect);
      }
    });
  }
  const gitScenarios = [
    { profile: "git-read", service: "upload", admitted: true },
    { profile: "git-read", service: "receive", admitted: false },
    { profile: "git-write", service: "upload", admitted: true },
    { profile: "git-write", service: "receive", admitted: true },
    { profile: "git-full", service: "upload", admitted: true },
    { profile: "git-full", service: "receive", admitted: true },
  ];
  for (const { profile, service, admitted } of gitScenarios) {
    await t.test(`${profile} ${service}-pack discovery and RPC`, () => {
      const git = bind(profile);
      assert.equal(
        factory.unauthenticated(
          head("GET", `/fixture/repository.git/info/refs?service=git-${service}-pack`),
        ).kind,
        "challenge",
      );
      for (const request of [
        head("GET", `/fixture/repository.git/info/refs?service=git-${service}-pack`),
        head("POST", `/fixture/repository.git/git-${service}-pack`, {
          "content-type": `application/x-git-${service}-pack-request`,
          "git-protocol": "version=2",
        }),
      ]) {
        assert.equal(
          "kind" in git.plan(request),
          !admitted,
          `${profile} ${request.method} ${request.rawTarget}`,
        );
      }
    });
  }
  for (const profile of ["git-read", "git-write"]) {
    for (const request of [head("GET", "/repos/fixture/repository"), head("POST", "/graphql")]) {
      await t.test(`${profile} admits ${request.method} ${request.rawTarget}`, () => {
        const plan = bind(profile).plan(request);
        assert.equal(plan.kind, undefined);
        assert.equal(plan.effect, request.method === "GET" ? "read" : "write");
      });
    }
  }
  assert.throws(() => factory.resolve("read-write"), /unsupported-profile/);
  for (const { name, rawTarget } of [
    { name: "foreign repository", rawTarget: "/repos/foreign/repo" },
    { name: "raw parent traversal", rawTarget: "/repos/fixture/repository/../repository" },
    { name: "encoded repository separator", rawTarget: "/repos/fixture%2frepository" },
    { name: "duplicate page", rawTarget: "/repos/fixture/repository/issues?page=1&page=2" },
    { name: "oversized page", rawTarget: "/repos/fixture/repository/issues?per_page=101" },
    {
      name: "absolute request target",
      rawTarget: "https://api.github.com/repos/fixture/repository",
    },
  ]) {
    await t.test(`denies ${name}`, () => {
      assert.equal(bind().plan(head("GET", rawTarget)).kind, "denied");
    });
  }
});
test("pinned gh JSON media profile is admitted and REST headers are normalized", async (t) => {
  const { bind } = await createGitHubPlanningFixture(t);
  const bound = bind();
  const accept =
    "application/vnd.github.merge-info-preview+json, application/vnd.github.nebula-preview";
  const plan = bound.plan(
    head("POST", "/graphql", {
      accept,
      "content-type": "application/json; charset=utf-8",
      "graphql-features": "merge_queue",
    }),
  );
  assert.equal(plan.kind, undefined);
  assert.equal(plan.effect, "write");
  assert.equal(plan.requestHeaders.accept, accept);
  assert.equal(plan.requestHeaders["content-type"], "application/json");
  assert.equal(plan.requestHeaders["graphql-features"], "merge_queue");
  const readme = bound.plan(head("GET", "/repos/fixture/repository/readme", { accept }));
  assert.equal(readme.kind, undefined);
  assert.equal(readme.requestHeaders.accept, "application/vnd.github+json");
  assert.equal(readme.responsePolicy.body, "bounded-json");
  for (const { name, path, headers, method = "POST" } of [
    {
      name: "raw repository metadata bypasses JSON credential filtering",
      method: "GET",
      path: "/repos/fixture/repository",
      headers: { accept: "application/vnd.github.v3.raw+json" },
    },
    {
      name: "diff media on issue reads",
      method: "GET",
      path: "/repos/fixture/repository/issues/1",
      headers: { accept: "application/vnd.github.v3.diff" },
    },
    {
      name: "patch media on pull mutations",
      method: "PATCH",
      path: "/repos/fixture/repository/pulls/1",
      headers: { accept: "application/vnd.github.v3.patch" },
    },
    {
      name: "additional XML media",
      path: "/graphql",
      headers: { accept: `${accept}, application/xml` },
    },
    {
      name: "unqualified preview media",
      path: "/graphql",
      headers: { accept: "application/vnd.github.unqualified-preview+json" },
    },
    {
      name: "unqualified GraphQL feature",
      path: "/graphql",
      headers: { accept, "graphql-features": "unqualified" },
    },
  ]) {
    await t.test(`denies ${name}`, () => {
      assert.equal(bind().plan(head(method, path, headers)).kind, "denied");
    });
  }
});
test("REST issue and PR responses preserve informational URLs on reads and successful mutations", async (t) => {
  const { bind } = await createGitHubPlanningFixture(t);
  const gateway = "https://credentials.example/repos/fixture/repository";
  for (const [resource, buildResponse] of [
    ["issues", issueResponse],
    ["pulls", pullResponse],
  ]) {
    const scenarios = [
      { name: "read item", method: "GET", path: `${resource}/1`, status: 200, list: false },
      { name: "list items", method: "GET", path: resource, status: 200, list: true },
      { name: "create item", method: "POST", path: resource, status: 201, list: false },
      { name: "update item", method: "PATCH", path: `${resource}/1`, status: 200, list: false },
    ];
    for (const scenario of scenarios) {
      await t.test(`${resource}: ${scenario.name} preserves informational links`, () => {
        const plan = bind().plan(
          head(scenario.method, `/repos/fixture/repository/${scenario.path}`),
        );
        const input = buildResponse();
        const expected = {
          ...structuredClone(input),
          url: `${gateway}/${resource}/1`,
          comments_url: `${gateway}/issues/1/comments`,
          ...(resource === "issues"
            ? { pull_request: { ...input.pull_request, url: `${gateway}/pulls/1` } }
            : { issue_url: `${gateway}/issues/1` }),
        };
        const output = plan.responsePolicy.rewriteJson(scenario.list ? [input] : input);
        assert.deepEqual(JSON.parse(JSON.stringify(output)), scenario.list ? [expected] : expected);
        const headers = { "content-type": "application/json" };
        assert.deepEqual(plan.responsePolicy.headers(scenario.status, headers), headers);
      });
    }
  }
  for (const path of ["labels/bug", "milestones/1", "pulls/1/comments", "pulls/1/commits"]) {
    await t.test(`informational ${path} remains unfollowable`, () => {
      assert.equal(bind().plan(head("GET", `/repos/fixture/repository/${path}`)).kind, "denied");
    });
  }
});
test("repository responses omit cloning credentials at repository locations without changing ordinary data", async (t) => {
  const { bind } = await createGitHubPlanningFixture(t);
  const api = "https://api.github.com/repos/fixture/repository";
  const gateway = "https://credentials.example/repos/fixture/repository";
  const metadata = {
    id: 73,
    url: api,
    description: "Document the temp_clone_token field without changing human text",
    clone_url: "https://github.com/fixture/repository.git",
    custom_properties: { temp_clone_token: "a property name, not a provider credential" },
  };
  const repository = {
    ...metadata,
    temp_clone_token: "synthetic-root-cloning-credential",
    parent: { ...metadata, temp_clone_token: "synthetic-parent-cloning-credential" },
    source: {
      ...metadata,
      temp_clone_token: "synthetic-source-cloning-credential",
      parent: { ...metadata, temp_clone_token: "synthetic-ancestor-cloning-credential" },
    },
  };
  const cleanRepository = {
    ...metadata,
    parent: metadata,
    source: { ...metadata, parent: metadata },
  };
  const pull = pullResponse({
    head: { ref: "topic", repo: repository },
    base: { ref: "main", repo: repository },
  });
  const cleanPull = {
    ...pull,
    url: `${gateway}/pulls/1`,
    comments_url: `${gateway}/issues/1/comments`,
    issue_url: `${gateway}/issues/1`,
    head: { ref: "topic", repo: cleanRepository },
    base: { ref: "main", repo: cleanRepository },
  };
  for (const { name, method, path, input, expected } of [
    {
      name: "repository",
      method: "GET",
      path: "",
      input: repository,
      expected: { ...cleanRepository, url: gateway },
    },
    { name: "pull read", method: "GET", path: "/pulls/1", input: pull, expected: cleanPull },
    { name: "pull list", method: "GET", path: "/pulls", input: [pull], expected: [cleanPull] },
    { name: "pull create", method: "POST", path: "/pulls", input: pull, expected: cleanPull },
    { name: "pull update", method: "PATCH", path: "/pulls/1", input: pull, expected: cleanPull },
    {
      name: "deleted head repository",
      method: "GET",
      path: "/pulls/1",
      input: { ...pull, head: { ref: "topic", repo: null } },
      expected: { ...cleanPull, head: { ref: "topic", repo: null } },
    },
  ]) {
    await t.test(name, () => {
      const original = structuredClone(input);
      const plan = bind().plan(head(method, `/repos/fixture/repository${path}`));
      assert.equal(plan.kind, undefined);
      // Exercise the selected backend policy and the JSON boundary, not a replacement sanitizer.
      const serialized = JSON.stringify(plan.responsePolicy.rewriteJson(input));
      assert.deepEqual(JSON.parse(serialized), expected);
      assert.doesNotMatch(serialized, /synthetic-[a-z]+-cloning-credential/);
      assert.deepEqual(input, original);
    });
  }
});

test("followed JSON links validate field purpose while GraphQL human URLs remain intact", async (t) => {
  const { bind } = await createGitHubPlanningFixture(t);
  const bound = bind();
  const planFor = (method, path) => bound.plan(head(method, path));
  const issue = planFor("GET", "/repos/fixture/repository/issues/1");
  for (const { name, url } of [
    { name: "foreign origin", url: "https://other.example/steal" },
    { name: "foreign repository", url: "https://api.github.com/repos/other/repo/issues/1" },
    {
      name: "informational resource",
      url: "https://api.github.com/repos/fixture/repository/labels/bug",
    },
    { name: "fragment", url: "https://api.github.com/repos/fixture/repository/issues/1#fragment" },
    {
      name: "pull URL in issue field",
      url: "https://api.github.com/repos/fixture/repository/pulls/1",
    },
  ]) {
    await t.test(`rejects ${name}`, () => {
      assert.throws(() => issue.responsePolicy.rewriteJson({ url }), /unsafe-upstream-url/);
    });
  }
  assert.throws(
    () =>
      issue.responsePolicy.rewriteJson({
        comments_url: "https://api.github.com/repos/fixture/repository/issues/1",
      }),
    /unsafe-upstream-url/,
  );
  const graphql = {
    data: {
      repository: {
        url: "https://github.com/fixture/repository",
        pullRequests: {
          nodes: [
            {
              url: "https://github.com/fixture/repository/pull/1",
              body: "https://api.github.com/repos/fixture/repository/labels/bug",
            },
          ],
        },
      },
    },
  };
  assert.deepEqual(planFor("POST", "/graphql").responsePolicy.rewriteJson(graphql), graphql);
});
test("GraphQL input policy refuses clone credential selections hidden by JSON encoding", async (t) => {
  const { bind } = await createGitHubPlanningFixture(t);
  const bound = bind();
  const { inputPolicy } = bound.plan(head("POST", "/graphql"));
  const allows = (text) => inputPolicy(Buffer.from(text));
  assert.equal(allows('{"query":"query { viewer { login } }"}'), true);
  assert.equal(
    allows('{"query":"query($q: String!) { viewer { login } }","variables":{"q":"\\""}}'),
    true,
  );
  for (const text of [
    '{"query":"{ repository(owner: \\"o\\", name: \\"r\\") { tempCloneToken } }"}',
    '{"query":"{ repository(owner: \\"o\\", name: \\"r\\") { \\u0074empCloneToken } }"}',
    '{"query":"{ viewer { login } }","query":"{ repository { tempCloneToken } }"}',
    '{"query":"{ repository { tempCloneToken } }","query":"{ viewer { login } }"}',
    '{"query":"{ viewer { login } }"',
  ]) {
    assert.equal(allows(text), false, text);
  }
  assert.equal(bound.plan(head("GET", "/repos/fixture/repository")).inputPolicy, undefined);
  // An empty query string cannot select another spelling of the GraphQL route.
  assert.equal(bound.plan(head("POST", "/graphql?")).kind, "denied");
});
test("response policy rewrites admitted machine links without changing human content or forwarding credential headers", async (t) => {
  const { bind } = await createGitHubPlanningFixture(t);
  const bound = bind();
  const plan = bound.plan(head("GET", "/repos/fixture/repository/issues/1/comments"));
  const link = "https://api.github.com/repos/fixture/repository/issues/1/comments?page=2";
  const headers = plan.responsePolicy.headers(200, {
    link: `<${link}>; rel="next"`,
    "set-cookie": "secret",
    "www-authenticate": "secret",
    "retry-after": "5",
    "content-length": "999",
  });
  assert.equal(
    headers.link,
    `<https://credentials.example/repos/fixture/repository/issues/1/comments?page=2>; rel="next"`,
  );
  assert.equal(headers["set-cookie"], undefined);
  assert.equal(headers["www-authenticate"], undefined);
  assert.equal(headers["content-length"], undefined);
  const body = plan.responsePolicy.rewriteJson({
    url: "https://api.github.com/repos/fixture/repository/issues/comments/1",
    body: link,
    html_url: "https://github.com/fixture/repository/pull/1",
    user: { url: "https://api.github.com/users/person" },
  });
  assert.equal(body.url, "https://credentials.example/repos/fixture/repository/issues/comments/1");
  assert.equal(body.body, link);
  assert.equal(body.user.url, "https://api.github.com/users/person");
  const unsafe = { message: "unsafe-upstream-url" };
  assert.throws(() => plan.responsePolicy.headers(302, { location: link }), {
    message: "upstream-redirect",
  });
  // Each link breaks one guard: foreign origin, unadmitted route, then total length.
  const foreign = link.replace("https://api.github.com/", "https://other.example/");
  assert.throws(
    () => plan.responsePolicy.headers(200, { link: `<${foreign}>; rel="next"` }),
    unsafe,
  );
  assert.throws(
    () =>
      plan.responsePolicy.headers(200, {
        link: '<https://api.github.com/repos/fixture/repository/labels/bug>; rel="next"',
      }),
    unsafe,
  );
  const long = Array.from({ length: 100 }, () => `<${link}>; rel="next"`).join(", ");
  assert.ok(long.length > 8192);
  assert.throws(() => plan.responsePolicy.headers(200, { link: long }), unsafe);
  // Git responses never carry pagination links, even admitted ones.
  const git = bound.plan(head("GET", "/fixture/repository.git/info/refs?service=git-upload-pack"));
  assert.equal(git.kind, undefined);
  assert.throws(() => git.responsePolicy.headers(200, { link: `<${link}>; rel="next"` }), unsafe);
});

test("response policy rejects 304 without a redirect location", async (t) => {
  const { bind } = await createGitHubPlanningFixture(t);
  const plan = bind().plan(head("GET", "/repos/fixture/repository/issues/1"));
  const headers = { "cache-control": "private, max-age=60" };
  assert.equal(plan.kind, undefined);
  assert.deepEqual(plan.responsePolicy.headers(200, headers), headers);
  // Cache validation remains within the current all-3xx refusal policy.
  assert.throws(() => plan.responsePolicy.headers(304, headers), {
    message: "upstream-redirect",
  });
});

test("native repository-ID pagination stays bound to the configured repository and issue cursor policy", async (t) => {
  const { bind } = await createGitHubPlanningFixture(t);
  const bound = bind();
  const target = "/repos/fixture/repository/issues";
  const cursor = "Y3Vyc29yOnYyOjE=";
  const plan = bound.plan(head("GET", target));
  for (const direction of ["after", "before"]) {
    await t.test(`${direction} cursor rewrites to the admitted issue route`, () => {
      const query = `state=all&per_page=1&${direction}=${encodeURIComponent(cursor)}&page=2`;
      const canonical = `${target}?${query}`;
      const headers = plan.responsePolicy.headers(200, {
        link: `<https://api.github.com/repositories/73/issues?${query}>; rel="next"`,
      });
      assert.equal(headers.link, `<https://credentials.example${canonical}>; rel="next"`);
      assert.equal(bound.plan(head("GET", canonical)).target, canonical);
      assert.equal(bound.plan(head("POST", canonical)).kind, "denied");
      assert.equal(bind("git-write").plan(head("GET", canonical)).target, canonical);
    });
  }
  // A native ID is response metadata, never an additional caller-selected repository route.
  assert.equal(bound.plan(head("GET", "/repositories/73/issues")).kind, "denied");
  for (const { name, url } of [
    { name: "foreign repository ID", url: "https://api.github.com/repositories/74/issues?page=2" },
    { name: "repository ID prefix", url: "https://api.github.com/repositories/730/issues?page=2" },
    { name: "foreign origin", url: "https://other.example/repositories/73/issues?page=2" },
    {
      name: "unsupported resource",
      url: "https://api.github.com/repositories/73/actions/runs?page=2",
    },
    {
      name: "cursor on issue item",
      url: `https://api.github.com/repositories/73/issues/1?after=${cursor}`,
    },
    {
      name: "cursor on pull collection",
      url: `https://api.github.com/repositories/73/pulls?after=${cursor}`,
    },
    {
      name: "cursor with encoded space",
      url: "https://api.github.com/repositories/73/issues?after=bad%20cursor",
    },
    {
      name: "oversized cursor",
      url: `https://api.github.com/repositories/73/issues?after=${"a".repeat(1025)}`,
    },
    {
      name: "duplicate cursor",
      url: `https://api.github.com/repositories/73/issues?after=${cursor}&after=${cursor}`,
    },
  ]) {
    await t.test(`rejects ${name}`, () => {
      assert.throws(() => plan.responsePolicy.headers(200, { link: `<${url}>; rel="next"` }), {
        message: "unsafe-upstream-url",
      });
    });
  }
});

test("response policy rejects a literal comma inside an otherwise admitted Link URL", async (t) => {
  const { bind } = await createGitHubPlanningFixture(t);
  const bound = bind();
  const target = "/repos/fixture/repository/issues?labels=bug,help&page=2";
  const encodedTarget = "/repos/fixture/repository/issues?labels=bug%2Chelp&page=2";
  const plan = bound.plan(head("GET", target));
  assert.equal(plan.kind, undefined);
  assert.deepEqual(
    plan.responsePolicy.headers(200, {
      link: `<https://api.github.com${encodedTarget}>; rel="next"`,
    }),
    { link: `<https://credentials.example${encodedTarget}>; rel="next"` },
  );
  // A literal comma is refused by Link parsing even when the route itself is admitted.
  assert.throws(
    () =>
      plan.responsePolicy.headers(200, {
        link: `<https://api.github.com${target}>; rel="next"`,
      }),
    { message: "unsafe-upstream-url" },
  );
});

test("gateway authentication is separate from upstream signing and rejects foreign attempt/result/plan objects", async (t) => {
  const { factory, key, publicKey, bind } = await createGitHubPlanningFixture(t);
  const bound = bind();
  const bearer = "a".repeat(43);
  assert.equal(
    factory.parseAuthentication(
      head("GET", "/fixture/repository.git/info/refs?service=git-upload-pack"),
      `Basic ${Buffer.from(`gateway-session:${bearer}`).toString("base64")}`,
    ),
    bearer,
  );
  assert.equal(
    factory.parseAuthentication(head("GET", "/repos/fixture/repository"), `token ${bearer}`),
    bearer,
  );
  assert.equal(
    factory.parseAuthentication(
      head("GET", "/fixture/repository.git/info/refs?service=git-upload-pack"),
      `Bearer ${bearer}`,
    ).kind,
    "denied",
  );
  await key.withJwt(async (jwt) => {
    const [h, p, s] = jwt.split(".");
    assert.equal(
      verify("sha256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url")),
      true,
    );
    assert.equal(JSON.parse(Buffer.from(p, "base64url")).iss, "12345");
  });
  await assert.rejects(
    bound.driver.acquire(
      { id: "copy", action: "acquire", authority: bound.authority },
      undefined,
      1,
    ),
    /FOREIGN_ATTEMPT/,
  );
  await assert.rejects(
    bound.driver.settle({ kind: "acquired", attemptId: "copy" }),
    /foreign-outcome/,
  );
  await assert.rejects(
    bound.driver.withAuthentication({}, {}, async () => {
      throw new Error("must-not-send");
    }),
    /invalid-credential/,
  );
  key.close();
  await assert.rejects(
    key.withJwt(async () => {}),
    /authority-unavailable/,
  );
});

test("partial fixture cleanup retains the startup failure and releases keys and files", async () => {
  const resources = createResourceScope();
  const directory = await temporaryDirectory(resources);
  const { key } = await createGitHubPlanningFixture(resources);
  const startupFailure = new Error("startup failed");
  const cleanupFailure = new Error("cleanup failed");
  resources.after(() => {
    throw cleanupFailure;
  });
  const closed = resources.close(startupFailure);
  assert.equal(resources.close(), closed);
  await assert.rejects(closed, (error) => {
    assert.deepEqual(error.errors, [startupFailure, cleanupFailure]);
    assert.equal(error.cause, startupFailure);
    return true;
  });
  await assert.rejects(access(directory), { code: "ENOENT" });
  await assert.rejects(
    key.withJwt(async () => {}),
    /authority-unavailable/,
  );
});

test("a cleanup deadline is a failure and does not prevent remaining resource release", async () => {
  // Every cleanup races the same deadline, so it must leave the directory removal room on a
  // loaded runner; 20 ms let the removal time out too.
  const resources = createResourceScope({ cleanupTimeoutMs: 500 });
  const directory = await temporaryDirectory(resources);
  const pendingCleanup = Promise.withResolvers();
  resources.after(() => pendingCleanup.promise);
  const closed = resources.close();
  await assert.rejects(closed, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    assert.match(error.errors[0].message, /cleanup timed out/);
    return true;
  });
  await assert.rejects(access(directory), { code: "ENOENT" });
  pendingCleanup.resolve();
  await pendingCleanup.promise;
  // Late completion cannot replace the recorded cleanup deadline with success.
  assert.equal(resources.close(), closed);
  await assert.rejects(resources.close(), /credential fixture cleanup failed/);
});

test(
  "service resource factories revoke acquired credentials before closing local upstreams",
  { timeout: 15000 },
  async (t) => {
    const resources = createTestResourceScope(t);
    const clock = createControlledClock();
    const tls = await createTlsMaterial(resources);
    const config = await createLoopbackServiceConfiguration(resources);
    const github = await startGitHubFixture(resources, { clock, tls });
    const git = await startGitSmartHttpFixture(resources, { authorize: github.authorize, tls });
    const factory = await createGitHubServiceFactory(resources, {
      config,
      clock,
      privateKey: github.privateKey,
      trustedEndpoints: { apiOrigin: github.origin, gitOrigin: git.origin, ca: tls.ca },
    });
    const { service, listeners } = await startServiceListeners(resources, {
      config,
      factory,
      clock,
      tls,
      upstreamOrigins: [github.origin, git.origin],
    });
    const opened = service.open({ durationSeconds: 86400, profile: "git-full" });
    const clientDirectory = await writeSessionClientConfiguration(resources, {
      opened,
      ca: tls.ca,
    });
    // Dial the owned loopback listener while retaining the public authority and TLS validation.
    const response = await new Promise((resolve, reject) => {
      const outgoing = request(
        {
          hostname: "127.0.0.1",
          port: listeners.address.port,
          path: "/repos/fixture/repository",
          ca: tls.ca,
          headers: { host: "credentials.example.test", authorization: `Bearer ${opened.bearer}` },
          agent: false,
        },
        (incoming) => {
          const chunks = [];
          incoming.on("data", (chunk) => chunks.push(chunk));
          incoming.once("error", reject);
          incoming.once("end", () =>
            resolve({ status: incoming.statusCode, body: Buffer.concat(chunks) }),
          );
        },
      );
      outgoing.setTimeout(3000, () => outgoing.destroy(new Error("fixture request timeout")));
      outgoing.once("error", reject);
      outgoing.end();
    });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).full_name, "fixture/repository");
    assert.equal(github.issuesOfTokens.length, 1);
    await resources.close();
    assert.equal(service.status(opened.session.sessionId).state, "DISPOSED");
    assert.equal(github.tokenState()[0].revoked, true);
    assert.deepEqual(github.errors, []);
    await assert.rejects(access(clientDirectory), { code: "ENOENT" });
    await assert.rejects(access(config.gateway.controlSocket), { code: "ENOENT" });
  },
);
