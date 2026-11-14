import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import type { RepositoryCredentialGrantIdentity } from "@openclaw-enterprise/contracts";
import type {
  AttemptContext,
  Clock,
  RequestHead,
} from "../../apps/controller/src/drivers/repo/access/backend-contracts.ts";
import type { ServiceLimits } from "../../apps/controller/src/drivers/repo/access/service-contracts.ts";
import { validateServiceConfig } from "../../apps/controller/src/drivers/repo/access/configuration.ts";
import { createCustody } from "../../apps/controller/src/drivers/repo/access/custody.ts";
import { admitSession } from "../../apps/controller/src/drivers/repo/access/sessions.ts";
import { validateGitHubConfiguration } from "../../apps/controller/src/drivers/repo/github/access/config.ts";
import {
  classifyGitHubToken,
  createGitHubStaticTokenOwner,
} from "../../apps/controller/src/drivers/repo/github/access/static-token.ts";
import { createGitHubDriverFactory } from "../../apps/controller/src/drivers/repo/github/access/factory.ts";
import { createGitHubKeyOwner } from "../../apps/controller/src/drivers/repo/github/access/material.ts";
import type {
  GitHubDriverFactory,
  GitHubProfile,
  GitHubStaticTokenOwner,
  GitHubTokenClass,
  GitHubTokenConfiguration,
} from "../../apps/controller/src/drivers/repo/github/access/types.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import {
  githubConfigurationData,
  githubTokenConfigurationData,
  requestHead,
  serviceConfigurationData,
  custodyLimits,
} from "../fixtures/repository-credentials/builders.mjs";

// Synthetic values: the prefix selects a class; nothing here is a real credential.
const sentinel = (prefix: string) => `${prefix}${"x".repeat(36)}`;
const oauthToken = sentinel("gho_");
const fineGrainedToken = sentinel("github_pat_");

interface TokenFixtureOptions {
  token?: string;
  configuration?: Partial<GitHubTokenConfiguration>;
  limits?: Partial<ServiceLimits>;
  owner?: GitHubStaticTokenOwner;
  // These extra properties exercise rejection of options outside the factory contract.
  options?: {
    metadataOnly?: true;
    binding?: { profile: string; identity: RepositoryCredentialGrantIdentity } | undefined;
  };
}

function tokenFactory(
  t: TestContext,
  {
    token = oauthToken,
    configuration = {},
    limits = {},
    options = {},
    owner,
  }: TokenFixtureOptions = {},
) {
  const authority = owner ?? createGitHubStaticTokenOwner({ token: Buffer.from(token) });
  if (owner === undefined) {
    t.after(() => authority.close());
  }
  const clock: Clock = createControlledClock(1700000000000);
  const config = validateServiceConfig(serviceConfigurationData({ limits }));
  const factory = createGitHubDriverFactory({
    configuration: validateGitHubConfiguration(githubTokenConfigurationData(configuration)),
    authority,
    clock,
    gatewayOrigin: config.gateway.publicOrigin,
    limits: config.limits,
    ...options,
  });
  return { clock, factory, owner: authority };
}

function head(
  method: string,
  rawTarget: string,
  headers: RequestHead["headers"] = {},
  framing: RequestHead["framing"] = { kind: "none", bytes: undefined },
): RequestHead {
  const {
    headers: fields,
    receivedMonoMs,
    contentEncoding,
  } = requestHead(method, rawTarget, headers);
  assert.equal(contentEncoding, "identity");
  return { method, rawTarget, headers: fields, receivedMonoMs, contentEncoding, framing };
}

function bind(
  { factory, clock }: Pick<ReturnType<typeof tokenFactory>, "factory" | "clock">,
  profile: GitHubProfile,
  binding = factory.resolve(profile).binding,
) {
  const admitted = admitSession(binding, clock.wallNow() + 3600000, clock);
  const custody = createCustody({
    clock,
    ...custodyLimits,
    admitted: () => true,
    changed() {},
  });
  const driver = factory.create({ authority: admitted.authority, custody: custody.driver, clock });
  return {
    authority: admitted.authority,
    custody,
    driver,
    plan: (request: RequestHead) =>
      driver.plan({ authority: admitted.authority, session: admitted.ref, head: request }),
  };
}

test("static token owner lends zeroed copies of an owned token and fails closed after close", async (t) => {
  const tokenClasses: [string, GitHubTokenClass][] = [
    [fineGrainedToken, "fine-grained"],
    [sentinel("ghp_"), "classic"],
    [oauthToken, "oauth"],
    [sentinel("ghu_"), "app-user"],
    [sentinel("ghs_"), "app-installation"],
    [sentinel("glpat-"), "unknown"],
    ["gho_", "unknown"],
  ];
  for (const [token, tokenClass] of tokenClasses) {
    assert.equal(classifyGitHubToken(Buffer.from(token)), tokenClass, token.slice(0, 11));
  }
  for (const invalid of [
    Buffer.alloc(0),
    Buffer.alloc(16385, 0x61),
    Buffer.from("gho_with space"),
    Buffer.from("gho_trailing\n"),
    Buffer.from("gho_é"),
  ]) {
    assert.throws(() => createGitHubStaticTokenOwner({ token: invalid }), {
      message: "invalid-token",
    });
  }
  assert.throws(
    // @ts-expect-error The owner also rejects non-byte inputs at runtime.
    () => createGitHubStaticTokenOwner({ token: "gho_not-bytes" }),
    { message: "invalid-token" },
  );
  const input = Buffer.from(oauthToken);
  const owner = createGitHubStaticTokenOwner({ token: input });
  t.after(() => owner.close());
  // The caller zero-fills its own read buffer; the owner keeps its own copy.
  input.fill(0);
  assert.equal(owner.kind, "github-token");
  assert.equal(owner.tokenClass, "oauth");
  const lent = await owner.withToken(async (bytes) => {
    assert.equal(Buffer.from(bytes).toString(), oauthToken);
    return bytes;
  });
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
  for (const repositoryId of ["1", "73", "9007199254740991"]) {
    assert.equal(
      validateGitHubConfiguration(githubTokenConfigurationData({ repositoryId })).repositoryId,
      repositoryId,
    );
  }
  let repositoryIdReads = 0;
  const changingRepositoryId = {
    ...githubTokenConfigurationData(),
    // Programmatic configuration can change type after the initial field check.
    get repositoryId() {
      return repositoryIdReads++ === 0 ? "73" : 73;
    },
  };
  const { developmentOnly: _d, ...noLiteral } = githubTokenConfigurationData();
  const { pushRefAllowlist: _p, ...noAllowlist } = githubTokenConfigurationData();
  const invalidConfigurations: [string, unknown][] = [
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
    ...["0", "01", "-1", "+1", "1.0", "1e2", " 73", "73 ", "9007199254740992", 73].map(
      (repositoryId): [string, unknown] => [
        "noncanonical repository ID",
        githubTokenConfigurationData({ repositoryId }),
      ],
    ),
    ["repository ID changes from string to number", changingRepositoryId],
  ];
  for (const [name, input] of invalidConfigurations) {
    assert.throws(() => validateGitHubConfiguration(input), { message: "invalid-backend" }, name);
  }
});

test("token grant identities distinguish policy and cannot reuse a previous App grant", (t) => {
  const previousBinding: RepositoryCredentialGrantIdentity = {
    providerInstanceId: "github-test",
    repositoryId: "73",
    grantId: "sha256:2aaf0850449238395a21649ea67ff527ef3be5c1ffcc43ea0ea2d392884cc986",
  };
  const token = tokenFactory(t);
  const grant = (factory: GitHubDriverFactory, profile: GitHubProfile = "git-write") =>
    factory.resolve(profile).binding.grantId;
  const grants = [
    previousBinding.grantId,
    grant(token.factory),
    grant(
      tokenFactory(t, { token: fineGrainedToken, configuration: { allowGraphql: true } }).factory,
    ),
    grant(tokenFactory(t, { configuration: { pushRefAllowlist: ["refs/heads/other/*"] } }).factory),
  ];
  assert.equal(new Set(grants).size, grants.length);
  // git-read never gets GraphQL, so allowGraphql does not change its identity.
  assert.equal(
    grant(token.factory, "git-read"),
    grant(
      tokenFactory(t, { token: fineGrainedToken, configuration: { allowGraphql: true } }).factory,
      "git-read",
    ),
  );
  // The client carries the gateway-enforced allowlist so its hook refuses first.
  assert.deepEqual(token.factory.resolve("git-write").client.pushRefAllowlist, [
    "refs/heads/agent/*",
  ]);
  // App grants and foreign repository/provider bindings cannot use the token backend.
  const canonicalBinding = token.factory.resolve("git-write").binding;
  for (const binding of [
    previousBinding,
    { ...canonicalBinding, repositoryId: "74" },
    { ...canonicalBinding, providerInstanceId: "github-other" },
  ]) {
    assert.throws(() => bind(token, "git-write", binding), {
      message: "invalid-binding",
    });
  }
});

test("token factory refuses mismatched authorities, metadata scope, broad GraphQL and short leases", (t) => {
  const clock: Clock = createControlledClock(1700000000000);
  const config = validateServiceConfig(serviceConfigurationData());
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = createGitHubKeyOwner({ privateKey, appId: "12345", clock });
  t.after(() => key.close());
  assert.throws(
    () =>
      createGitHubDriverFactory({
        configuration: validateGitHubConfiguration(githubTokenConfigurationData()),
        // @ts-expect-error A real App key owner must also be rejected at runtime.
        authority: key,
        clock,
        gatewayOrigin: config.gateway.publicOrigin,
        limits: config.limits,
      }),
    { message: "invalid-configuration" },
    "App authority for a token config",
  );
  const invalidOptions: [string, TokenFixtureOptions][] = [
    ["metadata-only scope", { options: { metadataOnly: true } }],
    ["GraphQL with an OAuth token", { configuration: { allowGraphql: true } }],
    [
      "GraphQL with a classic token",
      { token: sentinel("ghp_"), configuration: { allowGraphql: true } },
    ],
    // A lease must cover one exchange deadline plus two safety margins.
    [
      "lease below the exchange bound",
      { configuration: { leaseSeconds: 900 }, limits: { exchangeMs: 900000 } },
    ],
  ];
  for (const [name, input] of invalidOptions) {
    assert.throws(() => tokenFactory(t, input), { message: "invalid-configuration" }, name);
  }
  const owner = createGitHubStaticTokenOwner({ token: Buffer.from(oauthToken) });
  t.after(() => owner.close());
  assert.throws(
    () =>
      createGitHubDriverFactory({
        // @ts-expect-error The token factory must reject raw App configuration at runtime.
        configuration: githubConfigurationData(),
        authority: owner,
        clock,
        gatewayOrigin: config.gateway.publicOrigin,
        limits: config.limits,
      }),
    { message: "invalid-backend" },
  );
});

test("token routes deny GraphQL by default and for git-read, and inspect every push", (t) => {
  const graphql = head("POST", "/graphql", {}, { kind: "length", bytes: 20 });
  const receivePack = head(
    "POST",
    "/fixture/repository.git/git-receive-pack",
    { "content-type": "application/x-git-receive-pack-request" },
    { kind: "length", bytes: 20 },
  );
  const discovery = head("GET", "/fixture/repository.git/info/refs?service=git-receive-pack");
  const denied = { kind: "denied", status: 400, code: "unsupported-request" };
  const defaults = tokenFactory(t);
  const opted = tokenFactory(t, { token: fineGrainedToken, configuration: { allowGraphql: true } });
  const profiles: GitHubProfile[] = ["git-read", "git-write", "git-full"];
  for (const profile of profiles) {
    assert.deepEqual(bind(defaults, profile).plan(graphql), denied, profile);
  }
  assert.deepEqual(bind(opted, "git-read").plan(graphql), denied);
  // Opted-in GraphQL is read-only: a mutation could write refs outside the push allowlist.
  const query = (text: string) => Buffer.from(JSON.stringify({ query: text }));
  const writeProfiles: GitHubProfile[] = ["git-write", "git-full"];
  for (const profile of writeProfiles) {
    const plan = bind(opted, profile).plan(graphql);
    assert.ok(!("kind" in plan), profile);
    assert.equal(plan.target, "/graphql", profile);
    const { inputPolicy } = plan;
    assert.ok(inputPolicy, profile);
    assert.equal(inputPolicy(query("{ viewer { login } }")), true, profile);
    assert.equal(inputPolicy(query("query { mutationTesting: viewer { login } }")), true);
    const named = { query: "query Q($n: Int) { viewer { login } }", variables: { n: 1 } };
    assert.equal(inputPolicy(Buffer.from(JSON.stringify({ ...named, operationName: "Q" }))), true);
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
      assert.equal(inputPolicy(refused), false, refused.toString());
    }
  }
  // git-read never reaches receive-pack, before any acquisition.
  assert.deepEqual(bind(defaults, "git-read").plan(receivePack), denied);
  assert.deepEqual(bind(defaults, "git-read").plan(discovery), denied);
  const push = bind(defaults, "git-write").plan(receivePack);
  assert.ok(!("kind" in push));
  assert.equal(push.category, "git-push");
  const { inputPolicy } = push;
  assert.ok(inputPolicy);
  const oid = "a".repeat(40);
  const command = (ref: string) => {
    const line = `${oid} ${oid} ${ref}\0report-status`;
    return Buffer.from(`${(line.length + 4).toString(16).padStart(4, "0")}${line}0000`);
  };
  assert.equal(inputPolicy(command("refs/heads/agent/x")), true);
  assert.equal(inputPolicy(command("refs/heads/main")), false);
});

interface AttemptOptions {
  aborted?: boolean;
  deadlineMonoMs?: number;
}

function attemptFor(
  session: Pick<ReturnType<typeof bind>, "authority" | "custody">,
  { aborted = false, deadlineMonoMs = 60000 }: AttemptOptions = {},
) {
  const controller = new AbortController();
  if (aborted) {
    controller.abort();
  }
  const attempt = Object.freeze<AttemptContext>({
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

test("static acquisition checks every bound before borrowing and never dispatches", async (t) => {
  const fixture = tokenFactory(t);
  const session = bind(fixture, "git-write");
  // Settle each attempt the way the lifecycle does, so refused attempts free their slot.
  const outcome = async (options: AttemptOptions, minimumValidityMs = 0) => {
    const { attempt, reservation } = attemptFor(session, options);
    const result = await session.driver.acquire(attempt, undefined, minimumValidityMs);
    await session.driver.settle(result);
    session.custody.settle(reservation);
    return result;
  };
  const capturedCount = () => session.custody.records.size;
  assert.equal((await outcome({ aborted: true })).kind, "not-dispatched");
  assert.equal((await outcome({ deadlineMonoMs: 0 })).kind, "not-dispatched");
  const rejected = await outcome({}, 3600001);
  assert.strictEqual(rejected.kind, "rejected");
  assert.equal(rejected.code, "insufficient-validity");
  assert.equal(capturedCount(), 0, "refused attempts captured nothing");
  const acquired = await outcome({}, 3600000);
  assert.strictEqual(acquired.kind, "acquired");
  assert.equal(acquired.expiresAtWallMs - acquired.observedWallMs, 3600000);
  assert.equal(capturedCount(), 1);
  fixture.owner.close();
  const closed = await outcome({});
  assert.strictEqual(closed.kind, "reauthorization-required");
  assert.equal(closed.code, "authority-unavailable");
  assert.equal(capturedCount(), 1);
});

test("token factory refuses a caller-supplied grant override", (t) => {
  const owner = createGitHubStaticTokenOwner({ token: Buffer.from(oauthToken) });
  t.after(() => owner.close());
  const binding = {
    profile: "git-write",
    identity: { providerInstanceId: "github-test", repositoryId: "73", grantId: "x" },
  };
  assert.throws(() => tokenFactory(t, { owner, options: { binding } }), {
    message: "invalid-configuration",
  });
  assert.throws(() => tokenFactory(t, { owner, options: { binding: undefined } }), {
    message: "invalid-configuration",
  });
});

test("development token upload-pack deadlines fit the configured lease", (t) => {
  const token = tokenFactory(t, {
    configuration: { leaseSeconds: 900 },
    limits: { gitFetchExchangeMs: 1800000, maxExchangeMs: 1800000 },
  });
  const bound = bind(token, "git-read");
  const upload = bound.plan(
    head("POST", "/fixture/repository.git/git-upload-pack", {
      "content-type": "application/x-git-upload-pack-request",
    }),
  );
  assert.ok(!("kind" in upload));
  assert.equal(upload.limits.totalMs, 780000);
  const discovery = bound.plan(
    head("GET", "/fixture/repository.git/info/refs?service=git-upload-pack"),
  );
  assert.ok(!("kind" in discovery));
  assert.equal(discovery.limits.totalMs, 300000);
});
