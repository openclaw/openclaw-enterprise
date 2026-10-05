import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { validateServiceConfig } from "../../apps/controller/src/drivers/repo/credentials/configuration.ts";
import { createCustody } from "../../apps/controller/src/drivers/repo/credentials/custody.ts";
import { admitSession } from "../../apps/controller/src/drivers/repo/credentials/sessions.ts";
import { validateGitHubConfiguration } from "../../apps/controller/src/drivers/repo/github/credentials/config.ts";
import {
  classifyGitHubToken,
  createGitHubDriverFactory,
  createGitHubKeyOwner,
  createGitHubStaticTokenOwner,
} from "../../apps/controller/src/drivers/repo/github/credentials/index.ts";
import { createGitHubRegistryDriverFactory } from "../../apps/controller/src/drivers/repo/github/credentials/registry-factory.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import {
  githubConfigurationData,
  githubTokenConfigurationData,
  requestHead as head,
  serviceConfigurationData,
} from "../fixtures/repository-credentials/builders.mjs";

// Synthetic values: the prefix selects a class; nothing here is a real credential.
const sentinel = (prefix) => `${prefix}${"x".repeat(36)}`;
const oauthToken = sentinel("gho_");
const fineGrainedToken = sentinel("github_pat_");

function tokenFactory({
  token = oauthToken,
  configuration = {},
  limits = {},
  options = {},
  owner = createGitHubStaticTokenOwner({ token: Buffer.from(token) }),
} = {}) {
  const clock = createControlledClock(1700000000000);
  const config = validateServiceConfig(serviceConfigurationData({ limits }));
  const factory = createGitHubDriverFactory({
    configuration: githubTokenConfigurationData(configuration),
    authority: owner,
    clock,
    gatewayOrigin: config.gateway.publicOrigin,
    limits: config.limits,
    ...options,
  });
  return { clock, config, factory, owner };
}

/** Factory options selecting one binding of the configured token grant (`github-test`, 73). */
function factoryBinding(identity = {}, extra = {}) {
  return {
    options: {
      binding: {
        profile: "git-write",
        identity: {
          providerInstanceId: "github-test",
          repositoryId: "73",
          grantId: "x",
          ...identity,
        },
        ...extra,
      },
    },
  };
}

function appFactory() {
  const clock = createControlledClock(1700000000000);
  const config = validateServiceConfig(serviceConfigurationData());
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = createGitHubKeyOwner({ privateKey, appId: "12345", clock });
  const factory = createGitHubDriverFactory({
    configuration: githubConfigurationData(),
    authority: key,
    clock,
    gatewayOrigin: config.gateway.publicOrigin,
    limits: config.limits,
  });
  return { clock, config, factory, key };
}

function bind({ factory, clock }, profile, binding = factory.resolve(profile).binding) {
  const admitted = admitSession(binding, clock.wallNow() + 3600000, clock);
  const custody = createCustody({
    clock,
    maximumSlots: 2,
    maximumAccessBytes: 16384,
    maximumRenewalBytes: 16384,
    maximumCallbacks: 2,
    admitted: () => true,
    changed() {},
  });
  const driver = factory.create({ authority: admitted.authority, custody: custody.driver, clock });
  return {
    authority: admitted.authority,
    custody,
    driver,
    plan: (request) =>
      driver.plan({ authority: admitted.authority, session: admitted.ref, head: request }),
  };
}

test("static token owner lends zeroed copies of an owned token and fails closed after close", async () => {
  for (const [token, tokenClass] of [
    [fineGrainedToken, "fine-grained"],
    [sentinel("ghp_"), "classic"],
    [oauthToken, "oauth"],
    [sentinel("ghu_"), "app-user"],
    [sentinel("ghs_"), "app-installation"],
    [sentinel("glpat-"), "unknown"],
    ["gho_", "unknown"],
  ]) {
    assert.equal(classifyGitHubToken(Buffer.from(token)), tokenClass, token.slice(0, 11));
  }
  for (const invalid of [
    Buffer.alloc(0),
    Buffer.alloc(16385, 0x61),
    Buffer.from("gho_with space"),
    Buffer.from("gho_trailing\n"),
    Buffer.from("gho_é"),
    "gho_not-bytes",
  ]) {
    assert.throws(() => createGitHubStaticTokenOwner({ token: invalid }), {
      message: "invalid-token",
    });
  }
  const input = Buffer.from(oauthToken);
  const owner = createGitHubStaticTokenOwner({ token: input });
  // The caller zero-fills its own read buffer; the owner keeps its own copy.
  input.fill(0);
  assert.equal(owner.kind, "github-token");
  assert.equal(owner.tokenClass, "oauth");
  let lent;
  assert.equal(
    await owner.withToken(async (bytes) => {
      lent = bytes;
      return Buffer.from(bytes).toString();
    }),
    oauthToken,
  );
  assert.ok(
    lent.every((byte) => byte === 0),
    "lent copy is zeroed after use",
  );
  owner.close();
  await assert.rejects(
    owner.withToken(async () => assert.fail("closed owner lent a token")),
    { message: "authority-unavailable" },
  );
});

test("token backend configuration requires both scope controls and rejects every App field", () => {
  const valid = validateGitHubConfiguration(githubTokenConfigurationData());
  assert.deepEqual(
    { ...valid },
    {
      ...githubTokenConfigurationData(),
      pushRefAllowlist: ["refs/heads/agent/*"],
      allowGraphql: false,
      leaseSeconds: 3600,
    },
  );
  // An empty allowlist is valid and denies every push at the gateway.
  assert.deepEqual(
    validateGitHubConfiguration(githubTokenConfigurationData({ pushRefAllowlist: [] }))
      .pushRefAllowlist,
    [],
  );
  const { developmentOnly: _d, ...noLiteral } = githubTokenConfigurationData();
  const { pushRefAllowlist: _p, ...noAllowlist } = githubTokenConfigurationData();
  for (const [name, input] of [
    ["missing developmentOnly", noLiteral],
    ["developmentOnly false", githubTokenConfigurationData({ developmentOnly: false })],
    ["developmentOnly string", githubTokenConfigurationData({ developmentOnly: "true" })],
    ["missing pushRefAllowlist", noAllowlist],
    [
      "allowlist outside heads",
      githubTokenConfigurationData({ pushRefAllowlist: ["refs/tags/*"] }),
    ],
    ["allowlist not an array", githubTokenConfigurationData({ pushRefAllowlist: "refs/heads/a" })],
    ["relative tokenFile", githubTokenConfigurationData({ tokenFile: "token" })],
    ["App field", githubTokenConfigurationData({ appId: "12345" })],
    ["App key path", githubTokenConfigurationData({ privateKeyFile: "/protected/app.pem" })],
    ["allowGraphql string", githubTokenConfigurationData({ allowGraphql: "true" })],
    ["lease below floor", githubTokenConfigurationData({ leaseSeconds: 899 })],
    ["lease above one day", githubTokenConfigurationData({ leaseSeconds: 86401 })],
    ["lease not an integer", githubTokenConfigurationData({ leaseSeconds: 1000.5 })],
    ["unknown key", githubTokenConfigurationData({ token: "inline" })],
    ["App kind with a token field", githubConfigurationData({ tokenFile: "/protected/token" })],
    ["unknown kind", githubTokenConfigurationData({ kind: "github-pat" })],
  ]) {
    assert.throws(() => validateGitHubConfiguration(input), { message: "invalid-backend" }, name);
  }
});

test("App grant identities are unchanged and token grants are disjoint from them", () => {
  // Recorded from main before the token source existed; registry bindings depend on them.
  const app = appFactory();
  assert.deepEqual(
    ["git-read", "git-write", "git-full"].map((profile) => app.factory.resolve(profile).binding),
    [
      "sha256:fd48d226cd09ad082ce9106858e6238ab07bdd2c124fbf96234ec9e7773ca9ba",
      "sha256:2aaf0850449238395a21649ea67ff527ef3be5c1ffcc43ea0ea2d392884cc986",
      "sha256:c94076150c6a1fb745e84ec684af3b8806e96a411d820997d835249ec7b73be2",
    ].map((grantId) => ({ providerInstanceId: "github-test", repositoryId: "73", grantId })),
  );
  assert.equal(app.factory.resolve("git-write").client.pushRefAllowlist, undefined);
  const token = tokenFactory();
  const grant = (factory, profile = "git-write") => factory.resolve(profile).binding.grantId;
  const grants = [
    grant(app.factory),
    grant(token.factory),
    grant(tokenFactory({ token: fineGrainedToken, configuration: { allowGraphql: true } }).factory),
    grant(tokenFactory({ configuration: { pushRefAllowlist: ["refs/heads/other/*"] } }).factory),
  ];
  assert.equal(new Set(grants).size, grants.length);
  // git-read never gets GraphQL, so allowGraphql does not change its identity.
  assert.equal(
    grant(token.factory, "git-read"),
    grant(
      tokenFactory({ token: fineGrainedToken, configuration: { allowGraphql: true } }).factory,
      "git-read",
    ),
  );
  // The client carries the gateway-enforced allowlist so its hook refuses first.
  assert.deepEqual(token.factory.resolve("git-write").client.pushRefAllowlist, [
    "refs/heads/agent/*",
  ]);
  // A session admitted for an App grant can never be served by a token backend.
  assert.throws(() => bind(token, "git-write", app.factory.resolve("git-write").binding), {
    message: "invalid-binding",
  });
  app.key.close();
  token.owner.close();
});

test("token factory refuses mismatched authorities, metadata scope, broad GraphQL and short leases", () => {
  const { key } = appFactory();
  for (const [name, input] of [
    ["App authority for a token config", { owner: key }],
    ["metadata-only scope", { options: { metadataOnly: true } }],
    ["GraphQL with an OAuth token", { configuration: { allowGraphql: true } }],
    [
      "GraphQL with a classic token",
      { token: sentinel("ghp_"), configuration: { allowGraphql: true } },
    ],
    // A lease must cover one exchange deadline plus two safety margins.
    // The gateway enforces the configured allowlist; a binding cannot replace it.
    ["binding push allowlist", factoryBinding({}, { pushRefAllowlist: ["refs/heads/*"] })],
    [
      "lease below the exchange bound",
      { configuration: { leaseSeconds: 900 }, limits: { exchangeMs: 900000 } },
    ],
  ]) {
    assert.throws(() => tokenFactory(input), { message: "invalid-configuration" }, name);
  }
  const owner = createGitHubStaticTokenOwner({ token: Buffer.from(oauthToken) });
  const clock = createControlledClock();
  const config = validateServiceConfig(serviceConfigurationData());
  assert.throws(
    () =>
      createGitHubDriverFactory({
        configuration: githubConfigurationData(),
        authority: owner,
        clock,
        gatewayOrigin: config.gateway.publicOrigin,
        limits: config.limits,
      }),
    { message: "invalid-configuration" },
  );
  // The registry is the production path and accepts only an App authority.
  assert.throws(
    () =>
      createGitHubRegistryDriverFactory({
        registry: {},
        privateKeyFile: "/unused",
        authority: owner,
        clock,
        gatewayOrigin: config.gateway.publicOrigin,
        limits: config.limits,
      }),
    { message: "invalid-configuration" },
  );
  key.close();
  owner.close();
});

test("token routes deny GraphQL by default and for git-read, and inspect every push", () => {
  const graphql = head("POST", "/graphql", {}, { framing: { kind: "length", bytes: 20 } });
  const receivePack = head(
    "POST",
    "/fixture/repository.git/git-receive-pack",
    { "content-type": "application/x-git-receive-pack-request" },
    { framing: { kind: "length", bytes: 20 } },
  );
  const discovery = head("GET", "/fixture/repository.git/info/refs?service=git-receive-pack");
  const denied = { kind: "denied", status: 400, code: "unsupported-request" };
  const defaults = tokenFactory();
  const opted = tokenFactory({ token: fineGrainedToken, configuration: { allowGraphql: true } });
  for (const profile of ["git-read", "git-write", "git-full"]) {
    assert.deepEqual(bind(defaults, profile).plan(graphql), denied, profile);
  }
  assert.deepEqual(bind(opted, "git-read").plan(graphql), denied);
  // Opted-in GraphQL is read-only: a mutation could write refs outside the push allowlist.
  const query = (text) => Buffer.from(JSON.stringify({ query: text }));
  for (const profile of ["git-write", "git-full"]) {
    const plan = bind(opted, profile).plan(graphql);
    assert.equal(plan.target, "/graphql", profile);
    assert.equal(plan.inputPolicy(query("{ viewer { login } }")), true, profile);
    assert.equal(plan.inputPolicy(query("query { mutationTesting: viewer { login } }")), true);
    const named = { query: "query Q($n: Int) { viewer { login } }", variables: { n: 1 } };
    assert.equal(
      plan.inputPolicy(Buffer.from(JSON.stringify({ ...named, operationName: "Q" }))),
      true,
    );
    for (const refused of [
      query('mutation { updateRef(input: {refId: "x", oid: "y"}) { clientMutationId } }'),
      query("mutation{createRef(input:{}){ref{name}}}"),
      Buffer.from('{"query":"\\u006dutation { deleteRef(input: {}) { clientMutationId } }"}'),
      Buffer.from(
        '[{"query":"{ viewer { login } }"},{"query":"mutation { mergeBranch(input: {}) { clientMutationId } }"}]',
      ),
      query('{ repository(owner: "o", name: "r") { tempCloneToken } }'),
      Buffer.from("not json"),
      // Only one plain query document: no persisted queries, IDs or extensions.
      Buffer.from('{"id":"stored-document"}'),
      Buffer.from('{"extensions":{"persistedQuery":{"version":1,"sha256Hash":"x"}}}'),
      Buffer.from('{"query":"{ viewer { login } }","extensions":{}}'),
      Buffer.from('{"query":{"text":"{ viewer { login } }"}}'),
    ]) {
      assert.equal(plan.inputPolicy(refused), false, refused.toString());
    }
  }
  // The App path keeps token-bounded GraphQL, where mutations are bounded by the App token.
  const appGraphql = appFactory();
  const appPlan = bind(appGraphql, "git-write").plan(graphql);
  assert.equal(
    appPlan.inputPolicy(query("mutation { addStar(input: {}) { clientMutationId } }")),
    true,
  );
  appGraphql.key.close();
  // git-read never reaches receive-pack, before any acquisition.
  assert.deepEqual(bind(defaults, "git-read").plan(receivePack), denied);
  assert.deepEqual(bind(defaults, "git-read").plan(discovery), denied);
  const push = bind(defaults, "git-write").plan(receivePack);
  assert.equal(push.category, "git-push");
  const oid = "a".repeat(40);
  const command = (ref) => {
    const line = `${oid} ${oid} ${ref}\0report-status`;
    return Buffer.from(`${(line.length + 4).toString(16).padStart(4, "0")}${line}0000`);
  };
  assert.equal(push.inputPolicy(command("refs/heads/agent/x")), true);
  assert.equal(push.inputPolicy(command("refs/heads/main")), false);
  // The App path keeps its existing unbuffered push plan.
  const app = appFactory();
  assert.equal(bind(app, "git-write").plan(receivePack).inputPolicy, undefined);
  app.key.close();
  defaults.owner.close();
  opted.owner.close();
});

function attemptFor(session, { aborted = false, deadlineMonoMs = 60000 } = {}) {
  const controller = new AbortController();
  if (aborted) {
    controller.abort();
  }
  const attempt = Object.freeze({
    id: `attempt-${Math.random()}`,
    authority: session.authority,
    action: "acquire",
    deadlineMonoMs,
    signal: controller.signal,
    assertAdmitted() {
      if (controller.signal.aborted) {
        throw new Error("ATTEMPT_CLOSED");
      }
    },
    observeDispatch() {
      assert.fail("a static token acquisition never dispatches");
    },
  });
  session.custody.register(attempt);
  return { attempt, reservation: session.custody.reserve(attempt) };
}

test("static acquisition checks every bound before borrowing and never dispatches", async () => {
  const fixture = tokenFactory();
  const session = bind(fixture, "git-write");
  // Settle each attempt the way the lifecycle does, so refused attempts free their slot.
  const outcome = async (options, minimumValidityMs = 0) => {
    const { attempt, reservation } = attemptFor(session, options);
    const result = await session.driver.acquire(attempt, undefined, minimumValidityMs);
    await session.driver.settle(result);
    session.custody.settle(reservation);
    return result;
  };
  assert.equal((await outcome({ aborted: true })).kind, "not-dispatched");
  assert.equal((await outcome({ deadlineMonoMs: 0 })).kind, "not-dispatched");
  const rejected = await outcome({}, 3600001);
  assert.deepEqual([rejected.kind, rejected.code], ["rejected", "insufficient-validity"]);
  assert.equal(session.custody.records.size, 0, "refused attempts captured nothing");
  const acquired = await outcome({}, 3600000);
  assert.equal(acquired.kind, "acquired");
  assert.equal(acquired.expiresAtWallMs - acquired.observedWallMs, 3600000);
  assert.equal(session.custody.records.size, 1);
  const [record] = session.custody.records;
  await session.custody.driver.withAccess(record.ref, "retire", async (bytes) => {
    assert.equal(Buffer.from(bytes).toString(), oauthToken);
  });
  fixture.owner.close();
  const closed = await outcome({});
  assert.deepEqual(
    [closed.kind, closed.code],
    ["reauthorization-required", "authority-unavailable"],
  );
  assert.equal(session.custody.records.size, 1);
});

test("a factory binding must name the configured provider instance and repository", () => {
  tokenFactory(factoryBinding()).owner.close();
  for (const [name, identity] of [
    ["another repository", { repositoryId: "74" }],
    ["another provider instance", { providerInstanceId: "github-other" }],
  ]) {
    const owner = createGitHubStaticTokenOwner({ token: Buffer.from(oauthToken) });
    assert.throws(
      () => tokenFactory({ ...factoryBinding(identity), owner }),
      { message: "invalid-binding" },
      name,
    );
    owner.close();
  }
});
