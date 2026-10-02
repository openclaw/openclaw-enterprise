import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import {
  githubConfigurationData,
  requestHead,
  serviceConfigurationData,
} from "../fixtures/repository-credentials/builders.mjs";
import { startGitHubFixture } from "../fixtures/repository-credentials/github.mjs";
import { startRegistryCredentialServiceFixture } from "../fixtures/repository-credentials/registry.mjs";
import { startCredentialServiceFixture } from "../fixtures/repository-credentials/service.mjs";
import { resolveGitHubRepositoryBinding } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import {
  createGitHubDriverFactory,
  createGitHubKeyOwner,
} from "../../apps/controller/src/drivers/repo/github/credentials/index.ts";
import { validateServiceConfig } from "../../apps/controller/src/drivers/repo/credentials/configuration.ts";
import { createCredentialService } from "../../apps/controller/src/drivers/repo/credentials/service.ts";

function control(socketPath, path, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        socketPath,
        method: "POST",
        path,
        agent: false,
        headers: {
          host: "localhost",
          "content-type": "application/json",
          "content-length": body.length,
          ...headers,
        },
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("error", reject);
        incoming.on("end", () =>
          resolve({ status: incoming.statusCode, body: JSON.parse(Buffer.concat(chunks)) }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function descriptions(socketPath, payload) {
  return control(socketPath, "/v1/repository-descriptions", payload);
}

async function waitForRevocation(github) {
  const deadline = Date.now() + 5000;
  while (!github.tokenState().every((token) => token.revoked)) {
    if (Date.now() >= deadline) {
      throw new Error("provider token was not revoked");
    }
    await delay(10);
  }
}

async function settled(socketPath, payload) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await descriptions(socketPath, payload);
    assert.equal(response.status, 200);
    if (!response.body.pending) {
      return response.body;
    }
    await delay(20);
  }
  throw new Error("metadata lookup did not settle");
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
    key,
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
  await waitForRevocation(github);
  await delay(50);
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
  const fixture = await startRegistryCredentialServiceFixture(t, {
    autoOpen: false,
    gateway: { listen: "127.0.0.1:0" },
    repositories: [
      {
        repositoryRef: "repo-a",
        repository: "fixture/repository",
        repositoryId: "73",
        description: "Slow metadata",
        beforeMetadataResponse: () => gate,
      },
    ],
  });
  const initial = await descriptions(fixture.config.gateway.controlSocket, {
    namespaceId: fixture.namespaceId,
    repositoryRefs: ["repo-a"],
  });
  assert.equal(initial.body.pending, true);
  const github = fixture.byRef.get("repo-a").github;
  const deadline = Date.now() + 5000;
  while (
    !github.trace.some(
      (entry) => entry.method === "GET" && entry.target === "/repos/fixture/repository",
    )
  ) {
    if (Date.now() >= deadline) {
      throw new Error("metadata read did not start");
    }
    await delay(20);
  }
  // The caller can disappear while the provider has already issued a token.
  // Closing the owning service must abort the read and revoke that token.
  const closing = fixture.close();
  await delay(20);
  release();
  await closing;
  assert.equal(github.tokenState()[0].revoked, true);
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
  await waitForRevocation(github);
  await delay(50);
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
  assert.throws(() =>
    resolveGitHubRepositoryBinding(registry.registry, {
      namespaceId: registry.namespaceId,
      repositoryRef: "repo-a",
      profile: "metadata-read",
    }),
  );
  const binding = resolveGitHubRepositoryBinding(registry.registry, {
    namespaceId: registry.namespaceId,
    repositoryRef: "repo-a",
    profile: "git-read",
  });
  const result = await control(
    registry.config.gateway.controlSocket,
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
  const standaloneResult = await control(
    standalone.config.gateway.controlSocket,
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
  const deadline = Date.now() + 5000;
  while (
    !first.trace.some(
      (entry) => entry.method === "GET" && entry.target === "/repos/fixture/repository",
    )
  ) {
    if (Date.now() >= deadline) {
      release();
      throw new Error("first metadata read did not start");
    }
    await delay(20);
  }
  await descriptions(socket, { namespaceId: fixture.namespaceId, repositoryRefs: ["repo-c"] });
  release();
  const third = fixture.byRef.get("repo-c").github;
  while (
    !third.trace.some((entry) => entry.method === "GET" && entry.target === "/repos/fixture/third")
  ) {
    if (Date.now() >= deadline) {
      releaseCurrent();
      throw new Error("current metadata read did not start");
    }
    await delay(20);
  }
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
  const deadline = Date.now() + 10000;
  while (
    fixture.repositories.reduce((sum, entry) => sum + entry.github.issuesOfTokens.length, 0) < 15
  ) {
    if (Date.now() >= deadline) {
      throw new Error("first metadata rate window did not complete");
    }
    await delay(20);
  }
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
  const deadline = Date.now() + 5000;
  while (
    !github.trace.some(
      (entry) => entry.method === "GET" && entry.target === "/repos/fixture/repository",
    )
  ) {
    if (Date.now() >= deadline) {
      release();
      throw new Error("metadata read did not reach the provider");
    }
    await delay(20);
  }
  await fixture.clock.advance(1001);
  const response = await settled(socket, payload);
  assert.deepEqual(response.descriptions, []);
  release();
  await waitForRevocation(github);
});
