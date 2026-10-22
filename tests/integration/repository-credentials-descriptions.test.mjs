import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import {
  githubConfigurationData,
  requestHead,
  serviceConfigurationData,
} from "../fixtures/repository-credentials/builders.mjs";
import { startGitHubFixture } from "../fixtures/repository-credentials/github.mjs";
import { startRegistryCredentialServiceFixture } from "../fixtures/repository-credentials/registry.mjs";
import {
  controlRequest,
  startCredentialServiceFixture,
} from "../fixtures/repository-credentials/service.mjs";
import { resolveGitHubRepositoryBinding } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import {
  createGitHubDriverFactory,
  createGitHubKeyOwner,
} from "../../apps/controller/src/drivers/repo/github/credentials/index.ts";
import { validateServiceConfig } from "../../apps/controller/src/drivers/repo/credentials/configuration.ts";
import { createCredentialService } from "../../apps/controller/src/drivers/repo/credentials/service.ts";
import { waitFor, waitUntil } from "../helpers/wait-for.mjs";

function descriptions(socketPath, payload) {
  return controlRequest(socketPath, "POST", "/v1/repository-descriptions", payload);
}

function waitForRevocation(github) {
  return waitUntil(
    "the provider token to be revoked",
    () => github.tokenState().every((token) => token.revoked),
    { timeoutMs: 5000, intervalMs: 10 },
  );
}

// Each lookup retires its token through a short-lived service whose shutdown
// grace runs on the fixture clock. The provider marks the token revoked before
// that service reads the reply, so advance the clock only after the shutdown has
// cancelled its grace timer; an earlier jump expires the grace and blocks lookups.
// No other timer on that clock outlives a lookup, so none pending means it finished.
async function waitForRetiredLookup(github, clock) {
  await waitForRevocation(github);
  await waitUntil("the metadata lookup shutdown to finish", () => clock.pendingTimers() === 0, {
    timeoutMs: 5000,
    intervalMs: 10,
  });
}

// Waits until the provider fixture has received `GET target`. On a timeout it first releases
// the response the test holds, so the service can still shut down.
async function waitForProviderRead(github, target, description, release) {
  try {
    await waitUntil(
      description,
      () => github.trace.some((entry) => entry.method === "GET" && entry.target === target),
      { timeoutMs: 5000 },
    );
  } catch (error) {
    release();
    throw error;
  }
}

function within(promise, message) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), 5000);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function settled(socketPath, payload) {
  return waitFor(
    "the metadata lookup to settle",
    async () => {
      const response = await descriptions(socketPath, payload);
      assert.equal(response.status, 200);
      return response.body.pending ? undefined : response.body;
    },
    5000,
  );
}

// Starts a registry whose repositories (repo-a, repo-b, ...) carry `texts` as their GitHub
// descriptions, waits for the lookup to settle and returns the descriptions served, in order.
async function servedDescriptions(t, texts) {
  const refs = texts.map((_text, index) => `repo-${String.fromCharCode(97 + index)}`);
  const fixture = await startRegistryCredentialServiceFixture(t, {
    autoOpen: false,
    gateway: { listen: "127.0.0.1:0" },
    repositories: texts.map((description, index) => ({
      repositoryRef: refs[index],
      repository: `fixture/${refs[index]}`,
      repositoryId: String(73 + index),
      description,
    })),
  });
  const result = await settled(fixture.config.gateway.controlSocket, {
    namespaceId: fixture.namespaceId,
    repositoryRefs: refs,
  });
  return result.descriptions.map((entry) => entry.description);
}

test("private metadata sessions reject other methods and routes before issuing a token", async (t) => {
  const clock = createControlledClock();
  const github = await startGitHubFixture(t, { clock });
  const config = validateServiceConfig(serviceConfigurationData());
  const metadataConfig = {
    ...config,
    sessionPolicy: { ...config.sessionPolicy, allowedProfiles: ["metadata-read"] },
  };
  const key = createGitHubKeyOwner({ privateKey: github.privateKey, appId: "12345", clock });
  const factory = createGitHubDriverFactory({
    configuration: githubConfigurationData(),
    metadataOnly: true,
    authority: key,
    clock,
    gatewayOrigin: config.gateway.publicOrigin,
    limits: config.limits,
    trustedEndpoints: { apiOrigin: github.origin, gitOrigin: github.origin, ca: github.tls.ca },
  });
  const service = createCredentialService({ config: metadataConfig, factory, clock });
  try {
    const opened = service.open({ profile: "metadata-read", durationSeconds: 60 });
    for (const [method, target] of [
      ["GET", "/repos/fixture/other"],
      ["GET", "/repos/fixture/repository?per_page=1"],
      ["GET", "/repos/fixture/repository/issues"],
      ["POST", "/repos/fixture/repository"],
      ["POST", "/graphql"],
      ["GET", "/fixture/repository.git/info/refs?service=git-upload-pack"],
      ["GET", "//api.github.com/repos/fixture/repository"],
    ]) {
      const result = service.reserve(
        opened.bearer,
        requestHead(method, target),
        new AbortController().signal,
      );
      assert.equal(result.kind, "denied", `${method} ${target}`);
    }
    assert.equal(github.issuesOfTokens.length, 0);
    assert.equal(github.trace.length, 0);

    const admitted = service.reserve(
      opened.bearer,
      requestHead("GET", "/repos/fixture/repository"),
      new AbortController().signal,
    );
    assert.notEqual(admitted.kind, "denied");
    const plan = service.plan(admitted);
    assert.equal(plan.origin, github.origin);
    assert.equal(plan.method, "GET");
    assert.equal(plan.target, "/repos/fixture/repository");
    service.cancel(admitted);
  } finally {
    await service.shutdown(1000);
    key.close();
  }
});

test("protected metadata lookup restricts scope, caches descriptions, and retires tokens", async (t) => {
  const fixture = await startRegistryCredentialServiceFixture(t, {
    autoOpen: false,
    gateway: { listen: "127.0.0.1:0" },
    repositories: [
      {
        repositoryRef: "repo-a",
        repository: "fixture/repository",
        repositoryId: "73",
        description: "Service\nhealth",
      },
      {
        repositoryRef: "repo-b",
        repository: "fixture/other",
        repositoryId: "74",
        description: "Private details",
      },
    ],
  });
  const socket = fixture.config.gateway.controlSocket;
  // An unapproved namespace cannot use a known ref to discover a private description.
  const denied = await settled(socket, {
    namespaceId: "other-namespace",
    repositoryRefs: ["repo-a"],
  });
  assert.deepEqual(denied.descriptions, []);
  assert.equal(fixture.byRef.get("repo-a").github.issuesOfTokens.length, 0);

  const payload = { namespaceId: fixture.namespaceId, repositoryRefs: ["repo-a"] };
  const result = await settled(socket, payload);
  assert.deepEqual(result.descriptions, [
    { repositoryRef: "repo-a", repositoryId: "73", description: "Service health" },
  ]);
  assert.equal(result.providerInstanceId, "github-fixture-instance");
  assert.equal(result.appId, fixture.registry.appId);
  assert.equal(result.githubInstallationId, fixture.registry.githubInstallationId);
  assert.deepEqual(fixture.byRef.get("repo-a").github.issuesOfTokens[0].permissions, {
    metadata: "read",
  });
  assert.equal(fixture.byRef.get("repo-b").github.issuesOfTokens.length, 0);

  // A cached response does not mint another installation token, and shutdown owns revocation.
  await settled(socket, payload);
  assert.equal(fixture.byRef.get("repo-a").github.issuesOfTokens.length, 1);
  const github = fixture.byRef.get("repo-a").github;
  await waitForRetiredLookup(github, fixture.clock);
  // A provider access change must stop being masked by this display cache after five minutes.
  await fixture.clock.advance(5 * 60_000 + 1);
  const refresh = await descriptions(socket, payload);
  assert.equal(refresh.body.pending, true);
  assert.deepEqual(refresh.body.descriptions, []);
  await settled(socket, payload);
  assert.equal(github.issuesOfTokens.length, 2);
  await fixture.close();
  assert.ok(
    fixture.byRef
      .get("repo-a")
      .github.tokenState()
      .every((token) => token.revoked),
  );
});

test("metadata lookup rejects requests larger than the visible-page bound", async (t) => {
  const fixture = await startRegistryCredentialServiceFixture(t, {
    autoOpen: false,
    gateway: { listen: "127.0.0.1:0" },
  });
  const result = await descriptions(fixture.config.gateway.controlSocket, {
    namespaceId: fixture.namespaceId,
    repositoryRefs: Array.from({ length: 21 }, (_, i) => `repo-${i}`),
  });
  assert.equal(result.status, 400);
  assert.equal(fixture.byRef.get("repo-a").github.issuesOfTokens.length, 0);
});

test("shutdown cancels an active metadata read and retires its issued token", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const readStarted = Promise.withResolvers();
  const readClosed = Promise.withResolvers();
  const fixture = await startRegistryCredentialServiceFixture(t, {
    autoOpen: false,
    gateway: { listen: "127.0.0.1:0" },
    repositories: [
      {
        repositoryRef: "repo-a",
        repository: "fixture/repository",
        repositoryId: "73",
        description: "Slow metadata",
        beforeMetadataResponse: ({ response }) => {
          response.once("close", readClosed.resolve);
          readStarted.resolve();
          return gate;
        },
      },
    ],
  });
  const initial = await descriptions(fixture.config.gateway.controlSocket, {
    namespaceId: fixture.namespaceId,
    repositoryRefs: ["repo-a"],
  });
  assert.equal(initial.body.pending, true);
  const github = fixture.byRef.get("repo-a").github;
  await within(readStarted.promise, "metadata read did not start");
  // The caller can disappear while the provider has already issued a token.
  // Closing the owning service must abort the read and revoke that token. The
  // provider still holds its reply, so only that abort can close the read.
  const closing = fixture.close();
  try {
    await within(readClosed.promise, "shutdown did not abort the metadata read");
  } finally {
    release();
  }
  await closing;
  assert.equal(github.tokenState()[0].revoked, true);
});

test("repository metadata preserves supplementary Unicode through the character limit", async (t) => {
  // GitHub permits this 350-character description; its UTF-16 length crosses 512.
  const description = "a".repeat(187) + "😀".repeat(163);
  const [served, cut] = await servedDescriptions(t, [description, "😀".repeat(513)]);
  assert.equal(served, description);
  assert.equal(served.isWellFormed(), true);
  assert.equal(cut, "😀".repeat(512));
});

test("repository metadata replaces controls and invisible or bidi characters", async (t) => {
  // Finding 1628: controls (Cc), format characters (Cf: bidi, zero-width, invisible operators,
  // tags) and line and paragraph separators are replaced; their neighbours and private use stay.
  // Joiners inside words and emoji, and standard subdivision flags, stay: see the next test.
  const hidden = [
    0x00, 0x09, 0x1f, 0x7f, 0x80, 0x85, 0x9f, 0xad, 0x061c, 0x200b, 0x200e, 0x200f, 0x2028, 0x2029,
    0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069,
    0x206a, 0x206f, 0xfeff, 0xfff9, 0xfffb, 0xe0001, 0xe0041, 0xe007f,
  ];
  const kept = [
    0xa0, 0xac, 0xae, 0x061b, 0x061d, 0x200a, 0x2010, 0x2027, 0x202f, 0x205f, 0x2070, 0xfefc,
    0xfffc, 0x1f3f4, 0xe000,
  ];
  const spell = (codes) => codes.map((code) => `x${String.fromCodePoint(code)}`).join("") + "x";
  // Letters, combining marks, CJK, right-to-left scripts and emoji with modifiers stay intact.
  const unicode = "Café 日本語 עברית العربية 😀👍🏽❤️";
  assert.deepEqual(
    await servedDescriptions(t, [`\u202e${spell(hidden)}\u2069`, `${spell(kept)} ${unicode}`]),
    ["x ".repeat(hidden.length) + "x", `${spell(kept)} ${unicode}`],
  );
});

test("repository metadata keeps joiners in words and emoji and subdivision flags", async (t) => {
  // Finding 1633: a joiner between letters, marks or symbols, and a subdivision flag's tag
  // sequence stay, so emoji and Persian or Indic words keep their shape. Other joiners and tag
  // text are still replaced.
  const scotland = "\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}";
  const kept = [
    "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}", // family: man, woman, girl
    "\u{1f469}\u{1f3fd}\u200d\u{1f4bb}", // woman technologist with a skin tone modifier
    "\u{1f3f3}\ufe0f\u200d\u{1f308}", // rainbow flag: variation selector, then joiner
    "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645", // Persian with a non-joiner
    "\u0915\u094d\u200d\u0937", // Hindi conjunct: virama, then joiner
    "\u0d9a\u200d\u0dca\u0dc2", // Sinhala touching letters: joiner, then virama
    scotland,
    "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}", // England
    "\u{1f3f4}\u{e0067}\u{e0062}\u{e0077}\u{e006c}\u{e0073}\u{e007f}", // Wales
  ].join(" ");
  const replaced = [
    ["\u200dlead", " lead"],
    ["space \u200cword", "space  word"],
    ["double\u200d\u200djoiner", "double  joiner"],
    ["trail\u200d end", "trail  end"],
    ["tags\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}", "tags      "],
    ["\u{1f3f4}\u{e0067}\u{e0062}\u{e007f}", "\u{1f3f4}   "], // no subdivision code
    ["\u{1f3f4}\u{e0063}\u{e006e}\u{e0031}\u{e0031}\u{e007f}", "\u{1f3f4}     "], // not standard
    [
      "\u{1f3f4}\u{e0067}\u{e0062}\u{e0061}\u{e0062}\u{e0063}\u{e0064}\u{e0065}\u{e007f}",
      "\u{1f3f4}        ",
    ], // code too long
    ["\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}", "\u{1f3f4}     "], // no cancel tag
    ["\u{1f3f4}\u{e0047}\u{e0042}\u{e0073}\u{e0063}\u{e0074}\u{e007f}", "\u{1f3f4}      "], // capital region
    ["\u{1f3f4}\u{e0067}\u{e0062}\u{e0053}\u{e0043}\u{e0054}\u{e007f}", "\u{1f3f4}      "], // capital code
  ];
  assert.deepEqual(
    await servedDescriptions(t, [
      kept,
      `start ${replaced.map(([raw]) => raw).join("|")} end`,
      // The 512 code point cut can leave a joiner or flag unfinished; it is filtered again.
      `${"a".repeat(511)}\u200db`,
      `${"a".repeat(508)}${scotland}`,
    ]),
    [
      kept,
      `start ${replaced.map(([, shown]) => shown).join("|")} end`,
      "a".repeat(511),
      `${"a".repeat(508)}\u{1f3f4}`,
    ],
  );
});

test("missing and temporarily unavailable descriptions do not block selection", async (t) => {
  const fixture = await startRegistryCredentialServiceFixture(t, {
    autoOpen: false,
    gateway: { listen: "127.0.0.1:0" },
    repositories: [
      {
        repositoryRef: "repo-a",
        repository: "fixture/repository",
        repositoryId: "73",
        description: null,
      },
      {
        repositoryRef: "repo-b",
        repository: "fixture/other",
        repositoryId: "74",
        description: "Available after retry",
      },
    ],
  });
  const socket = fixture.config.gateway.controlSocket;
  const github = fixture.byRef.get("repo-b").github;
  github.disconnectAfterMutation("GET", "/repos/fixture/other");
  const payload = { namespaceId: fixture.namespaceId, repositoryRefs: ["repo-a", "repo-b"] };
  const first = await settled(socket, payload);
  assert.deepEqual(first.descriptions, []);
  assert.equal(github.issuesOfTokens.length, 1);
  await settled(socket, payload);
  assert.equal(github.issuesOfTokens.length, 1);
  await waitForRetiredLookup(github, fixture.clock);
  // Transient errors enter a bounded cooldown; a later request can recover.
  await fixture.clock.advance(60_001);
  const retried = await settled(socket, payload);
  assert.deepEqual(retried.descriptions, [
    { repositoryRef: "repo-b", repositoryId: "74", description: "Available after retry" },
  ]);
});

test("ordinary registry and standalone session admission reject the private metadata profile", async (t) => {
  const registry = await startRegistryCredentialServiceFixture(t, {
    autoOpen: false,
    gateway: { listen: "127.0.0.1:0" },
  });
  // The registry's profile set excludes the private metadata profile outright, before any
  // Namespace policy lookup.
  assert.throws(
    () =>
      resolveGitHubRepositoryBinding(registry.registry, {
        namespaceId: registry.namespaceId,
        repositoryRef: "repo-a",
        profile: "metadata-read",
      }),
    /invalid-repository-registry/,
  );
  const binding = resolveGitHubRepositoryBinding(registry.registry, {
    namespaceId: registry.namespaceId,
    repositoryRef: "repo-a",
    profile: "git-read",
  });
  const result = await controlRequest(
    registry.config.gateway.controlSocket,
    "POST",
    "/v1/sessions",
    {
      namespaceId: registry.namespaceId,
      repositoryRef: "repo-a",
      profile: "metadata-read",
      expectedBinding: binding.grant,
      durationSeconds: 60,
      deadlineWallMs: registry.clock.wallNow() + 60_000,
    },
    { "x-admission-id": `${registry.clock.wallNow()}-${randomUUID()}` },
  );
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "invalid-request");
  assert.equal(registry.byRef.get("repo-a").github.issuesOfTokens.length, 0);

  const standalone = await startCredentialServiceFixture(t, { gateway: { listen: "127.0.0.1:0" } });
  assert.throws(() => standalone.factory.resolve("metadata-read"), /unsupported-profile/);
  const standaloneResult = await controlRequest(
    standalone.config.gateway.controlSocket,
    "POST",
    "/v1/sessions",
    {
      profile: "metadata-read",
      durationSeconds: 60,
    },
    { "x-admission-id": `${standalone.clock.wallNow()}-${randomUUID()}` },
  );
  assert.equal(standaloneResult.status, 400);
  assert.equal(standaloneResult.body.error, "invalid-request");
  assert.equal(standalone.github.issuesOfTokens.length, 0);
});

test("a newly visible page takes priority over older queued descriptions", async (t) => {
  let release;
  let releaseCurrent;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const currentGate = new Promise((resolve) => {
    releaseCurrent = resolve;
  });
  const fixture = await startRegistryCredentialServiceFixture(t, {
    autoOpen: false,
    gateway: { listen: "127.0.0.1:0" },
    repositories: [
      {
        repositoryRef: "repo-a",
        repository: "fixture/repository",
        repositoryId: "73",
        description: "First",
        beforeMetadataResponse: () => gate,
      },
      {
        repositoryRef: "repo-b",
        repository: "fixture/other",
        repositoryId: "74",
        description: "Old page",
      },
      {
        repositoryRef: "repo-c",
        repository: "fixture/third",
        repositoryId: "75",
        description: "New page",
        beforeMetadataResponse: () => currentGate,
      },
    ],
  });
  const socket = fixture.config.gateway.controlSocket;
  await descriptions(socket, {
    namespaceId: fixture.namespaceId,
    repositoryRefs: ["repo-a", "repo-b"],
  });
  const first = fixture.byRef.get("repo-a").github;
  await waitForProviderRead(
    first,
    "/repos/fixture/repository",
    "the first metadata read to start",
    release,
  );
  await descriptions(socket, { namespaceId: fixture.namespaceId, repositoryRefs: ["repo-c"] });
  release();
  const third = fixture.byRef.get("repo-c").github;
  await waitForProviderRead(
    third,
    "/repos/fixture/third",
    "the current metadata read to start",
    releaseCurrent,
  );
  assert.equal(fixture.byRef.get("repo-b").github.issuesOfTokens.length, 0);
  releaseCurrent();
  const current = await settled(socket, {
    namespaceId: fixture.namespaceId,
    repositoryRefs: ["repo-c"],
  });
  assert.equal(current.descriptions[0].description, "New page");
  await settled(socket, { namespaceId: fixture.namespaceId, repositoryRefs: ["repo-b"] });
  await waitForRevocation(fixture.byRef.get("repo-b").github);
});

test("metadata issuance is rate-limited across a visible page", { timeout: 30000 }, async (t) => {
  const repositories = Array.from({ length: 16 }, (_, index) => {
    const name = String(index + 1).padStart(2, "0");
    return {
      repositoryRef: `repo-${name}`,
      repository: `fixture/repo-${name}`,
      repositoryId: String(100 + index),
      description: `Repository ${name}`,
    };
  });
  const fixture = await startRegistryCredentialServiceFixture(t, {
    autoOpen: false,
    gateway: { listen: "127.0.0.1:0" },
    repositories,
  });
  const socket = fixture.config.gateway.controlSocket;
  const payload = {
    namespaceId: fixture.namespaceId,
    repositoryRefs: repositories.map((repository) => repository.repositoryRef),
  };
  await descriptions(socket, payload);
  await waitUntil(
    "the first metadata rate window to complete",
    () =>
      fixture.repositories.reduce((sum, entry) => sum + entry.github.issuesOfTokens.length, 0) >=
      15,
    { timeoutMs: 10000 },
  );
  for (const entry of fixture.repositories.slice(0, 15)) {
    await waitForRevocation(entry.github);
  }
  const pending = await descriptions(socket, payload);
  assert.equal(pending.body.pending, true);
  assert.equal(fixture.byRef.get("repo-16").github.issuesOfTokens.length, 0);
  // A queued lookup resumes once the bounded issuance window opens again.
  await fixture.clock.advance(60_001);
  const complete = await settled(socket, payload);
  assert.equal(complete.descriptions.length, 16);
  assert.equal(fixture.byRef.get("repo-16").github.issuesOfTokens.length, 1);
});

test("a stalled provider header respects the configured timeout and leaves the picker usable", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fixture = await startRegistryCredentialServiceFixture(t, {
    autoOpen: false,
    gateway: { listen: "127.0.0.1:0" },
    limits: { firstHeaderMs: 1000 },
    repositories: [
      {
        repositoryRef: "repo-a",
        repository: "fixture/repository",
        repositoryId: "73",
        description: "Delayed metadata",
        beforeMetadataResponse: () => gate,
      },
    ],
  });
  const socket = fixture.config.gateway.controlSocket;
  const payload = { namespaceId: fixture.namespaceId, repositoryRefs: ["repo-a"] };
  await descriptions(socket, payload);
  const github = fixture.byRef.get("repo-a").github;
  await waitForProviderRead(
    github,
    "/repos/fixture/repository",
    "the metadata read to reach the provider",
    release,
  );
  await fixture.clock.advance(1001);
  const response = await settled(socket, payload);
  assert.deepEqual(response.descriptions, []);
  release();
  await waitForRevocation(github);
});
