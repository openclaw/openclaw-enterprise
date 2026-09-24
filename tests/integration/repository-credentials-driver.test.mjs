import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { request } from "node:https";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DependencyUnavailableError, ScopeViolationError } from "../../packages/occ/src/index.ts";
import { GitHubRepoDriver } from "../../apps/controller/src/drivers/repo/github/driver.ts";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import {
  defaultRegistryRepositories,
  startRegistryCredentialServiceFixture,
} from "../fixtures/repository-credentials/registry.mjs";

async function unusedPort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function driverFor(registry, socket, sessionDurationSeconds = 3600, publicCa) {
  return new GitHubRepoDriver(
    {
      id: registry.backendId,
      client: new UnixRepositoryCredentialControlClient({ controlSocket: socket }),
      drivers: { repo: "repository-credentials" },
    },
    registry,
    { sessionDurationSeconds, ...(publicCa === undefined ? {} : { publicCa }) },
  );
}

function assertPublicStatus(status, binding) {
  assert.deepEqual(Object.keys(status).sort(), ["binding", "deadlineWallMs", "sessionId", "state"]);
  assert.deepEqual(Object.keys(status.binding).sort(), [
    "grantId",
    "providerInstanceId",
    "repositoryId",
  ]);
  assert.deepEqual(status.binding, binding);
  assert.equal(Object.isFrozen(status), true);
  assert.equal(Object.isFrozen(status.binding), true);
}

function gateway(fixture, opened, repository) {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port: fixture.listeners.address.port,
        path: `/${repository}.git/info/refs?service=git-upload-pack`,
        method: "GET",
        ca: fixture.tls.ca,
        agent: false,
        headers: {
          host: "credentials.example.test",
          authorization: `Basic ${Buffer.from(`gateway-session:${opened.files.bearer}`).toString("base64")}`,
        },
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.once("error", reject);
        incoming.once("end", () =>
          resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

test(
  "concrete Driver resolves locally and controls exact sessions for two repositories",
  { timeout: 30000 },
  async (t) => {
    const fixture = await startRegistryCredentialServiceFixture(t, {
      autoOpen: false,
      repositories: defaultRegistryRepositories.map((entry) =>
        entry.repositoryRef === "repo-b"
          ? { ...entry, pushRefAllowlist: ["refs/heads/agent/*"] }
          : entry,
      ),
      gateway: { listen: `127.0.0.1:${await unusedPort()}` },
    });
    const signal = new AbortController().signal;
    const local = driverFor(fixture.registry, "/nonexistent/repository-control.sock");
    const resolution = local.resolve({
      namespaceId: fixture.namespaceId,
      bindings: [
        { repositoryRef: "repo-a", profile: "git-read" },
        { repositoryRef: "repo-b", profile: "git-full" },
      ],
    });
    assert.equal(resolution.sessionDurationSeconds, 3600);
    assert.throws(
      () =>
        local.resolve({
          namespaceId: fixture.namespaceId,
          bindings: [{ repositoryRef: "repo-a" }, { repositoryRef: "repo-a" }],
        }),
      ScopeViolationError,
    );
    const driver = driverFor(
      fixture.registry,
      fixture.config.gateway.controlSocket,
      3600,
      fixture.tls.ca,
    );
    const client = new UnixRepositoryCredentialControlClient({
      controlSocket: fixture.config.gateway.controlSocket,
    });
    await client.health(signal);
    const contributor = driver.resolve({
      namespaceId: fixture.namespaceId,
      bindings: [{ repositoryRef: "repo-a" }],
    }).bindings[0];
    // This exact registry used to admit the narrower git-write grant under this
    // digest. The real Driver/control/service join must reject its stale authority
    // before either repository's provider sees acquisition or exchange traffic.
    const legacyGrant = "sha256:94c2dc4513de2fa4a6f885c7fd2f857110510100111cb4f4424db6ddf8d37ae5";
    assert.notEqual(contributor.grant.grantId, legacyGrant);
    await assert.rejects(
      driver.open(
        {
          namespaceId: fixture.namespaceId,
          admissionId: `${fixture.clock.wallNow()}-${randomUUID()}`,
          binding: { ...contributor, grant: { ...contributor.grant, grantId: legacyGrant } },
          durationSeconds: 3600,
          deadlineWallMs: fixture.clock.wallNow() + 1800_000,
        },
        signal,
      ),
      ScopeViolationError,
    );
    assert.ok(
      fixture.repositories.every(
        (entry) => entry.github.trace.length === 0 && entry.github.issuesOfTokens.length === 0,
      ),
    );
    const inputs = resolution.bindings.map((binding) => ({
      namespaceId: fixture.namespaceId,
      admissionId: `${fixture.clock.wallNow()}-${randomUUID()}`,
      binding,
      durationSeconds: 3600,
      deadlineWallMs: fixture.clock.wallNow() + 1800_000,
    }));
    const opened = await Promise.all(inputs.map((input) => driver.open(input, signal)));
    for (let index = 0; index < opened.length; index++) {
      assert.equal(opened[index].kind, "created");
      const result = opened[index];
      assertPublicStatus(result.session, inputs[index].binding.grant);
      assert.notEqual(result.session.binding, inputs[index].binding.grant);
      const privateStatus = await client.status(result.session.sessionId, signal);
      assert.equal(typeof privateStatus.activeUses, "number");
      assert.equal(typeof privateStatus.cleanup.pending, "number");
      assert.notEqual(result.session, privateStatus);
      assert.notEqual(result.session.binding, privateStatus.binding);
      assert.equal(result.session.deadlineWallMs, inputs[index].deadlineWallMs);
      assert.equal(result.result, undefined);
      assert.equal(result.bearer, undefined);
      assert.equal(result.files["ca.pem"], fixture.tls.ca.toString("utf8"));
      assert.deepEqual(
        Object.keys(result.files).sort(),
        ["bearer", "ca.pem", "client.json", "gh/config.yml", "gh/hosts.yml", "gitconfig"].sort(),
      );
      assert.equal(JSON.parse(result.files["client.json"]).sessionId, result.session.sessionId);
      assert.deepEqual(
        JSON.parse(result.files["client.json"]).client.pushRefAllowlist,
        index === 1 ? ["refs/heads/agent/*"] : undefined,
      );
      const response = await gateway(fixture, result, fixture.repositories[index].repository);
      assert.equal(response.status, 200, response.body);
      assert.equal(
        (await gateway(fixture, result, fixture.repositories[1 - index].repository)).status,
        400,
      );
      const recovered = await driver.open({ ...inputs[index], recoverOnly: true }, signal);
      assert.equal(recovered.kind, "recovered");
      assert.equal(recovered.status.sessionId, result.session.sessionId);
      assertPublicStatus(recovered.status, inputs[index].binding.grant);
      assert.notEqual(recovered.status, result.session);
      assert.notEqual(recovered.status.binding, result.session.binding);
      assert.equal(recovered.bearer, undefined);
      const status = await driver.status(result.session.sessionId, signal);
      assertPublicStatus(status, inputs[index].binding.grant);
      assert.equal(status.state, "OPEN");
    }
    // Each real provider observed only its exact numeric repository and profile.
    assert.equal(fixture.repositories[0].github.issuesOfTokens.length, 1);
    assert.deepEqual(fixture.repositories[0].github.issuesOfTokens[0].repositoryIds, [73]);
    assert.deepEqual(fixture.repositories[0].github.issuesOfTokens[0].permissions, {
      metadata: "read",
      contents: "read",
      issues: "read",
      pull_requests: "read",
      checks: "read",
      statuses: "read",
    });
    assert.equal(fixture.repositories[1].github.issuesOfTokens.length, 1);
    assert.deepEqual(fixture.repositories[1].github.issuesOfTokens[0].repositoryIds, [74]);
    assert.deepEqual(fixture.repositories[1].github.issuesOfTokens[0].permissions, {
      metadata: "read",
      contents: "write",
      pull_requests: "write",
      issues: "write",
      checks: "read",
      statuses: "read",
    });
    await assert.rejects(
      driver.open({ ...inputs[0], durationSeconds: 3599 }, signal),
      ScopeViolationError,
    );
    const fenced = { ...inputs[0], admissionId: `${fixture.clock.wallNow()}-${randomUUID()}` };
    assert.deepEqual(await driver.open({ ...fenced, recoverOnly: true }, signal), {
      kind: "missing",
    });
    assert.deepEqual(await driver.open(fenced, signal), { kind: "missing" });

    // A changed local Backend registry must not obstruct restrictive cleanup of the old admission.
    const changedProvider = driverFor(
      { ...fixture.registry, backendId: "replacement-provider" },
      fixture.config.gateway.controlSocket,
    );
    assert.equal(
      (await changedProvider.open({ ...inputs[0], recoverOnly: true }, signal)).kind,
      "recovered",
    );
    await assert.rejects(changedProvider.open(inputs[0], signal), ScopeViolationError);

    for (let index = 0; index < opened.length; index++) {
      const closed = await driver.close(opened[index].session.sessionId, signal);
      assertPublicStatus(closed, inputs[index].binding.grant);
      assert.notEqual(closed.state, "OPEN");
    }

    await fixture.restart();
    assert.equal(await driver.status(opened[0].session.sessionId, signal), undefined);
    assert.deepEqual(await driver.open({ ...inputs[0], recoverOnly: true }, signal), {
      kind: "missing",
    });
    await assert.rejects(
      local.status(opened[0].session.sessionId, signal),
      DependencyUnavailableError,
    );
  },
);

test("Unix control rejects malformed status and preserves authoritative absence versus outage", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "repository-control-reply-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const socket = join(directory, "control.sock");
  const id = randomUUID();
  const driver = driverFor(
    {
      version: 1,
      backendId: "github-test",
      providerInstanceId: "instance",
      appId: "1",
      githubInstallationId: "2",
      maximumDurationSeconds: 3600,
      repositories: [
        {
          repositoryRef: "project",
          repositoryId: "73",
          repository: "example/project",
          namespaces: [{ namespaceId: "namespace", profiles: ["git-read"] }],
        },
      ],
    },
    socket,
    1,
  );
  const admitted = driver.resolve({
    namespaceId: "namespace",
    bindings: [{ repositoryRef: "project", profile: "git-read" }],
  }).bindings[0];
  const valid = {
    sessionId: id,
    state: "CLOSED",
    deadlineWallMs: Date.now() + 1000,
    binding: admitted.grant,
    activeUses: 0,
    cleanup: {
      active: 0,
      pending: 1,
      revoked: 0,
      expired: 0,
      uncertain: 0,
      auxiliaryPending: false,
    },
  };
  let reply = { status: 200, body: valid };
  // This independent wire peer supplies invalid protocol packets; it implements no session policy.
  const server = createServer((incoming, response) => {
    incoming.resume();
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(JSON.stringify(reply.body));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new UnixRepositoryCredentialControlClient({ controlSocket: socket });
  const signal = new AbortController().signal;
  assert.equal((await client.close(id, signal)).cleanup.pending, 1);
  for (const body of [
    { ...valid, sessionId: randomUUID() },
    { ...valid, binding: { ...valid.binding, grantId: "x".repeat(513) } },
    { ...valid, activeUses: -1 },
    { ...valid, cleanup: { ...valid.cleanup, pending: "1" } },
    { ...valid, bearer: "unexpected" },
    { ...valid, state: "OPEN" },
    { ...valid, state: "DISPOSED" },
  ]) {
    reply = { status: 200, body };
    await assert.rejects(client.close(id, signal), (error) => error.retryable === true);
  }
  const openInput = {
    namespaceId: "namespace",
    admissionId: `${Date.now()}-${randomUUID()}`,
    binding: admitted,
    durationSeconds: 1,
    deadlineWallMs: valid.deadlineWallMs,
  };
  const configuration = {
    gatewayOrigin: "https://credentials.example.test",
    gitRemote: "https://credentials.example.test/example/project.git",
    gitUsername: "gateway-session",
    canonicalApiHost: "github.com",
    apiHost: "credentials.example.test",
    repository: "example/project",
  };

  await t.test(
    "every public exit validates the complete private observation before projection",
    async () => {
      const open = { ...valid, state: "OPEN" };
      const malformed = [
        { ...open, activeUses: -1 },
        { ...open, activeUses: 0.5 },
        { ...open, activeUses: Number.MAX_SAFE_INTEGER + 1 },
        { ...open, deadlineWallMs: 0 },
        { ...open, deadlineWallMs: "1000" },
        { ...open, deadlineWallMs: Number.MAX_SAFE_INTEGER + 1 },
        { ...open, sessionId: "invalid/id" },
        { ...open, state: "UNKNOWN" },
        { ...open, bearer: "unexpected" },
        ...Object.keys(open).map((key) =>
          Object.fromEntries(Object.entries(open).filter(([name]) => name !== key)),
        ),
        ...Object.keys(open.binding).flatMap((key) => [
          { ...open, binding: { ...open.binding, [key]: "" } },
          { ...open, binding: { ...open.binding, [key]: "invalid\nidentity" } },
          { ...open, binding: { ...open.binding, [key]: "x".repeat(513) } },
          {
            ...open,
            binding: Object.fromEntries(
              Object.entries(open.binding).filter(([name]) => name !== key),
            ),
          },
        ]),
        { ...open, binding: { ...open.binding, extra: "unknown" } },
        ...["active", "pending", "revoked", "expired", "uncertain"].flatMap((key) => [
          { ...open, cleanup: { ...open.cleanup, [key]: -1 } },
          { ...open, cleanup: { ...open.cleanup, [key]: 0.5 } },
          { ...open, cleanup: { ...open.cleanup, [key]: Number.MAX_SAFE_INTEGER + 1 } },
          { ...open, cleanup: { ...open.cleanup, [key]: "0" } },
        ]),
        { ...open, cleanup: { ...open.cleanup, auxiliaryPending: 0 } },
        { ...open, cleanup: { ...open.cleanup, extra: 0 } },
        ...Object.keys(open.cleanup).map((key) => ({
          ...open,
          cleanup: Object.fromEntries(
            Object.entries(open.cleanup).filter(([name]) => name !== key),
          ),
        })),
      ];
      for (const status of malformed) {
        reply = {
          status: 201,
          body: { session: status, bearer: "b".repeat(43), client: configuration },
        };
        await assert.rejects(driver.open(openInput, signal), DependencyUnavailableError);
        reply = { status: 200, body: status };
        await assert.rejects(
          driver.open({ ...openInput, recoverOnly: true }, signal),
          DependencyUnavailableError,
        );
        await assert.rejects(driver.status(id, signal), DependencyUnavailableError);
        // Use CLOSED for otherwise OPEN observations so rejection must inspect the malformed field.
        reply = {
          status: 200,
          body: { ...status, ...(status.state === "OPEN" ? { state: "CLOSED" } : {}) },
        };
        await assert.rejects(driver.close(id, signal), DependencyUnavailableError);
      }
    },
  );

  await t.test(
    "DISPOSED rejects each outstanding obligation but retains historical cleanup counts",
    async () => {
      const disposed = {
        ...valid,
        state: "DISPOSED",
        cleanup: {
          active: 0,
          pending: 0,
          revoked: 2,
          expired: 3,
          uncertain: 0,
          auxiliaryPending: false,
        },
      };
      reply = { status: 200, body: disposed };
      assert.deepEqual(await client.status(id, signal), disposed);
      assert.deepEqual(await client.close(id, signal), disposed);
      for (const status of [
        await driver.status(id, signal),
        await driver.close(id, signal),
        (await driver.open({ ...openInput, recoverOnly: true }, signal)).status,
      ]) {
        assertPublicStatus(status, disposed.binding);
        assert.equal(status.state, "DISPOSED");
      }
      for (const outstanding of [
        { ...disposed, activeUses: 1 },
        ...["active", "pending", "uncertain"].map((key) => ({
          ...disposed,
          cleanup: { ...disposed.cleanup, [key]: 1 },
        })),
        { ...disposed, cleanup: { ...disposed.cleanup, auxiliaryPending: true } },
      ]) {
        reply = { status: 200, body: outstanding };
        await assert.rejects(client.status(id, signal), (error) => error.retryable === true);
        await assert.rejects(client.close(id, signal), (error) => error.retryable === true);
        await assert.rejects(driver.status(id, signal), DependencyUnavailableError);
        await assert.rejects(driver.close(id, signal), DependencyUnavailableError);
        await assert.rejects(
          driver.open({ ...openInput, recoverOnly: true }, signal),
          DependencyUnavailableError,
        );
      }
    },
  );

  await t.test(
    "open retains exact admitted binding, deadline and recovery-only checks",
    async () => {
      const open = { ...valid, state: "OPEN" };
      for (const status of [
        ...Object.keys(open.binding).map((key) => ({
          ...open,
          binding: { ...open.binding, [key]: "different" },
        })),
        { ...open, deadlineWallMs: openInput.deadlineWallMs + 1 },
      ]) {
        reply = {
          status: 201,
          body: { session: status, bearer: "b".repeat(43), client: configuration },
        };
        await assert.rejects(driver.open(openInput, signal), DependencyUnavailableError);
        reply = { status: 200, body: status };
        await assert.rejects(
          driver.open({ ...openInput, recoverOnly: true }, signal),
          DependencyUnavailableError,
        );
      }
      reply = {
        status: 201,
        body: { session: open, bearer: "b".repeat(43), client: configuration },
      };
      await assert.rejects(
        driver.open({ ...openInput, recoverOnly: true }, signal),
        DependencyUnavailableError,
      );
    },
  );

  await t.test("created response rejects a non-string client username", async () => {
    const configuration = {
      gatewayOrigin: "https://credentials.example.test",
      gitRemote: "https://credentials.example.test/example/project.git",
      gitUsername: "gateway-session",
      canonicalApiHost: "github.com",
      apiHost: "credentials.example.test",
      repository: "example/project",
    };
    const input = {
      namespaceId: "namespace",
      repositoryRef: "project",
      profile: "git-read",
      expectedBinding: valid.binding,
      durationSeconds: 1,
      deadlineWallMs: valid.deadlineWallMs,
    };
    const admissionId = `${Date.now()}-${randomUUID()}`;
    reply = {
      status: 201,
      body: {
        session: { ...valid, state: "OPEN" },
        bearer: "b".repeat(43),
        client: configuration,
      },
    };
    assert.deepEqual((await client.open(input, admissionId, signal)).result.client, configuration);
    for (const policy of [null, "refs/heads/main", ["refs/tags/v1"], ["refs/heads/topic/**"]]) {
      reply.body.client = { ...configuration, pushRefAllowlist: policy };
      await assert.rejects(
        client.open(input, admissionId, signal),
        (error) => error.retryable === true,
      );
    }
    // A username bypasses URL parsing but still crosses the untrusted control-response boundary.
    reply.body.client = { ...configuration, gitUsername: 1 };
    await assert.rejects(
      client.open(input, admissionId, signal),
      (error) => error.retryable === true,
    );
  });
  reply = { status: 404, body: { error: "not-found" } };
  assert.equal(await client.status(id, signal), undefined);
  for (const candidate of [
    { status: 503, body: { error: "unavailable" } },
    { status: 404, body: { error: "admission-missing" } },
    { status: 404, body: { message: "missing" } },
  ]) {
    reply = candidate;
    await assert.rejects(
      client.status(id, signal),
      (error) => error.retryable === true && !error.message.includes(socket),
    );
  }
});
