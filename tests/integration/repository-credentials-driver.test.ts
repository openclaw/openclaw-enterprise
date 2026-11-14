import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { request } from "node:https";
import { join } from "node:path";
import test from "node:test";
import type {
  OpenRepositorySessionInput,
  OpenRepositorySessionResult,
  RepositoryCredentialSessionStatus,
} from "@openclaw-enterprise/contracts";
import { composeRepositoryAccess } from "../../apps/controller/src/composition/repository-credentials/platform.ts";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import { GitHubNativeRepositorySender } from "../../apps/controller/src/drivers/repo/github/driver.ts";
import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import { DependencyUnavailableError, ScopeViolationError } from "../../packages/occ/src/index.ts";
import { startReceiptState } from "../fixtures/repository-credentials/receipt-state.ts";
import { socketDirectory } from "../helpers/socket-directory.mjs";
import { waitUntil } from "../helpers/wait-for.mjs";
import { readJsonObject, startRegistryFixture } from "./repository-credentials-driver-fixture.ts";
import { registerAdmissionCapabilityCases } from "./repository-credentials-driver-admission-capability-cases.ts";

type Registry = ConstructorParameters<typeof GitHubRepositoryPolicy>[1];
type CreatedSession = Extract<OpenRepositorySessionResult, { kind: "created" }>;
type RegistryFixture = NonNullable<Awaited<ReturnType<typeof startRegistryFixture>>>;

function isRetryable(error: unknown): error is { retryable: true } {
  return (
    error !== null && typeof error === "object" && "retryable" in error && error.retryable === true
  );
}

function driverFor(
  backendId: string,
  registry: Registry,
  socket: string,
  sessionDurationSeconds = 3600,
) {
  const backend = {
    id: backendId,
    client: new UnixRepositoryCredentialControlClient({ controlSocket: socket }),
    drivers: { repo: "repository-credentials" },
  };
  return {
    policy: new GitHubRepositoryPolicy(
      { driverId: backend.drivers.repo, backendId: backend.id },
      registry,
      { sessionDurationSeconds },
    ),
    sender: new GitHubNativeRepositorySender(backend, {}),
  };
}

function assertPublicStatus(
  status: RepositoryCredentialSessionStatus | undefined,
  binding: RepositoryCredentialSessionStatus["binding"],
): asserts status is RepositoryCredentialSessionStatus {
  assert.ok(status);
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

function gateway(fixture: RegistryFixture, opened: CreatedSession, repository: string) {
  return new Promise<{ status: number | undefined; body: string }>(
    (resolve, reject: (reason?: unknown) => void) => {
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
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.once("error", reject);
          incoming.once("end", () =>
            resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString() }),
          );
        },
      );
      outgoing.once("error", reject);
      outgoing.end();
    },
  );
}

test(
  "concrete Driver resolves locally and controls exact sessions for two repositories",
  { timeout: 30000 },
  async (t) => {
    const fixture = await startRegistryFixture(t, {
      namespaceId: `ns_${randomUUID()}`,
      autoOpen: false,
      gateway: { listen: "127.0.0.1:0" },
    });
    assert.ok(fixture);
    const signal = new AbortController().signal;
    const local = driverFor(
      fixture.backendId,
      fixture.registry,
      "/nonexistent/repository-control.sock",
    );
    const selection = {
      namespaceId: fixture.namespaceId,
      bindings: [
        { repositoryRef: "repo-a", profile: "git-write" },
        { repositoryRef: "repo-b", profile: "git-write" },
      ],
    };
    const resolution = local.policy.resolve(selection);
    assert.equal(resolution.sessionDurationSeconds, 3600);
    assert.throws(
      () =>
        local.policy.resolve({
          namespaceId: fixture.namespaceId,
          bindings: [{ repositoryRef: "repo-a" }, { repositoryRef: "repo-a" }],
        }),
      ScopeViolationError,
    );
    const composed = await composeRepositoryAccess(
      {
        backend: {
          id: fixture.backendId,
          type: "github",
          drivers: { repo: "repository-credentials" },
          configuration: { registryPath: fixture.registryFile },
        },
        selection: {
          id: "repository-credentials",
          implementation: "github",
          configuration: { sessionDurationSeconds: 3600 },
        },
      },
      {
        controlSocket: fixture.config.gateway.controlSocket,
        publicCaPath: fixture.tls.certFile,
      },
    );
    const driver = { policy: composed.repositoryPolicy, sender: composed.nativeRepositorySender };
    assert.deepEqual(driver.policy.resolve(selection), resolution);
    assert.throws(
      () =>
        driver.policy.resolve({
          namespaceId: `${fixture.namespaceId}-unauthorized`,
          bindings: [{ repositoryRef: "repo-a", profile: "git-write" }],
        }),
      ScopeViolationError,
    );
    const client = new UnixRepositoryCredentialControlClient({
      controlSocket: fixture.config.gateway.controlSocket,
    });
    await client.health(signal);
    await driver.sender.checkAdmissionReady(signal);
    const contributor = driver.policy.resolve({
      namespaceId: fixture.namespaceId,
      bindings: [{ repositoryRef: "repo-a" }],
    }).bindings[0];
    assert.ok(contributor);
    // This exact registry used to admit the narrower git-write grant under this
    // digest. The real Driver/control/service join must reject its stale authority
    // before either repository's provider sees acquisition or exchange traffic.
    const deadlineWallMs = fixture.clock.wallNow() + 1800_000;
    const receipts = await startReceiptState(t, fixture, resolution.bindings, deadlineWallMs);
    const staleId = `${fixture.clock.wallNow()}-${randomUUID()}`;
    await receipts.prepare(staleId, contributor.repositoryRef, 3600);
    const legacyGrant = "sha256:94c2dc4513de2fa4a6f885c7fd2f857110510100111cb4f4424db6ddf8d37ae5";
    assert.notEqual(contributor.grant.grantId, legacyGrant);
    await assert.rejects(
      driver.sender.open(
        {
          namespaceId: fixture.namespaceId,
          admissionId: staleId,
          binding: { ...contributor, grant: { ...contributor.grant, grantId: legacyGrant } },
          durationSeconds: 3600,
          deadlineWallMs,
        },
        signal,
      ),
      DependencyUnavailableError,
    );
    await receipts.advance(staleId, "opening", "invalidated");
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
      deadlineWallMs,
      preparedOnly: true as const,
    }));
    for (const input of inputs) {
      await receipts.prepare(input.admissionId, input.binding.repositoryRef, input.durationSeconds);
    }
    const opened = await Promise.all(inputs.map((input) => driver.sender.open(input, signal)));
    for (const [index, result] of opened.entries()) {
      const input = inputs[index];
      assert.ok(input);
      assert.ok("session" in result);
      await receipts.advance(input.admissionId, "opening", "open", result.session.sessionId);
    }
    for (const [index, result] of opened.entries()) {
      const input = inputs[index];
      const repository: RegistryFixture["repositories"][number] | undefined =
        fixture.repositories[index];
      const other: RegistryFixture["repositories"][number] | undefined =
        fixture.repositories[1 - index];
      assert.equal(result.kind, "created");
      assert.ok(input && repository && other);
      assertPublicStatus(result.session, input.binding.grant);
      assert.notEqual(result.session.binding, input.binding.grant);
      const privateStatus = await client.status(result.session.sessionId, signal);
      assert.ok(privateStatus);
      assert.equal(typeof privateStatus.activeUses, "number");
      assert.equal(typeof privateStatus.cleanup.pending, "number");
      assert.notEqual(result.session, privateStatus);
      assert.notEqual(result.session.binding, privateStatus.binding);
      assert.equal(result.session.deadlineWallMs, input.deadlineWallMs);
      assert.equal("result" in result ? result.result : undefined, undefined);
      assert.equal("bearer" in result ? result.bearer : undefined, undefined);
      assert.equal(result.files["ca.pem"], fixture.tls.ca.toString("utf8"));
      assert.deepEqual(
        Object.keys(result.files).sort(),
        ["bearer", "ca.pem", "client.json", "gh/config.yml", "gh/hosts.yml", "gitconfig"].sort(),
      );
      const clientFile = result.files["client.json"];
      assert.ok(clientFile);
      const metadata = readJsonObject(clientFile);
      const configuration = metadata.client;
      assert.ok(
        configuration && typeof configuration === "object" && "pushRefAllowlist" in configuration,
      );
      assert.equal(metadata.sessionId, result.session.sessionId);
      assert.deepEqual(configuration.pushRefAllowlist, [
        `refs/heads/agent-${input.binding.repositoryRef}`,
      ]);
      const response = await gateway(fixture, result, repository.repository);
      assert.equal(response.status, 503, "a sender without prepared material must fail closed");
      assert.equal((await gateway(fixture, result, other.repository)).status, 400);
      const recovered = await driver.sender.open({ ...input, recoverOnly: true }, signal);
      assert.equal(recovered.kind, "recovered");
      assert.equal(recovered.status.sessionId, result.session.sessionId);
      assertPublicStatus(recovered.status, input.binding.grant);
      assert.notEqual(recovered.status, result.session);
      assert.notEqual(recovered.status.binding, result.session.binding);
      assert.equal("bearer" in recovered ? recovered.bearer : undefined, undefined);
      const status = await driver.sender.status(result.session.sessionId, signal);
      assertPublicStatus(status, input.binding.grant);
      assert.equal(status.state, "OPEN");
    }
    assert.ok(
      fixture.repositories.every(
        ({ github, git }) => github.trace.length === 0 && git.trace.length === 0,
      ),
    );
    const [firstInput, secondInput] = inputs;
    const [firstOpened] = opened;
    assert.ok(firstInput && secondInput && firstOpened && "session" in firstOpened);
    await assert.rejects(
      driver.sender.open({ ...firstInput, durationSeconds: 3599 }, signal),
      ScopeViolationError,
    );
    await receipts.advance(firstInput.admissionId, "open", "closing");
    const fenced = { ...firstInput, admissionId: `${fixture.clock.wallNow()}-${randomUUID()}` };
    await receipts.prepare(
      fenced.admissionId,
      fenced.binding.repositoryRef,
      fenced.durationSeconds,
    );
    assert.deepEqual(await driver.sender.open({ ...fenced, recoverOnly: true }, signal), {
      kind: "missing",
    });
    assert.deepEqual(await driver.sender.open(fenced, signal), { kind: "missing" });

    // A changed local Backend registry must not obstruct restrictive cleanup of the old admission.
    const changedProvider = driverFor(
      "replacement-provider",
      { ...fixture.registry, backendId: "replacement-provider" },
      fixture.config.gateway.controlSocket,
    );
    assert.equal(
      (await changedProvider.sender.open({ ...firstInput, recoverOnly: true }, signal)).kind,
      "recovered",
    );
    await assert.rejects(changedProvider.sender.open(firstInput, signal), ScopeViolationError);

    await receipts.advance(secondInput.admissionId, "open", "closing");
    for (const [index, result] of opened.entries()) {
      const input = inputs[index];
      assert.ok(input);
      assert.ok("session" in result);
      const closed = await driver.sender.close(result.session.sessionId, signal);
      assertPublicStatus(closed, input.binding.grant);
      assert.notEqual(closed.state, "OPEN");
    }

    for (const result of opened) {
      assert.ok("session" in result);
      await waitUntil(
        `session ${result.session.sessionId} to be disposed`,
        async () =>
          (await driver.sender.status(result.session.sessionId, signal))?.state === "DISPOSED",
      );
    }
    await fixture.restart();
    assert.equal(
      (await driver.sender.status(firstOpened.session.sessionId, signal))?.state,
      "DISPOSED",
    );
    assert.equal(
      (await driver.sender.open({ ...firstInput, recoverOnly: true }, signal)).kind,
      "recovered",
    );
    await assert.rejects(
      local.sender.status(firstOpened.session.sessionId, signal),
      DependencyUnavailableError,
    );
  },
);

test("Unix control rejects malformed status and preserves authoritative absence versus outage", async (t) => {
  const directory = await socketDirectory(t, "repository-control-reply-");
  const socket = join(directory, "control.sock");
  const id = randomUUID();
  const driver = driverFor(
    "github-test",
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
  const admitted = driver.policy.resolve({
    namespaceId: "namespace",
    bindings: [{ repositoryRef: "project", profile: "git-read" }],
  }).bindings[0];
  assert.ok(admitted);
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
  let reply: { status: number; body: unknown } = { status: 200, body: valid };
  let requests = 0;
  // This independent wire peer supplies invalid protocol packets; it implements no session policy.
  const server = createServer((incoming, response) => {
    requests++;
    incoming.resume();
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve, reject: (reason?: unknown) => void) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const client = new UnixRepositoryCredentialControlClient({ controlSocket: socket });
  const signal = new AbortController().signal;
  assert.equal((await client.close(id, signal))?.cleanup.pending, 1);
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
    await assert.rejects(client.close(id, signal), isRetryable);
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

  await t.test("native installation refusal never contacts the broker", async () => {
    const before = requests;
    // Installation access belongs to protected delivery, including recovery attempts.
    for (const recoverOnly of [false, true]) {
      const input: OpenRepositorySessionInput = {
        ...openInput,
        binding: { ...admitted, profile: "github-installation" },
      };
      // Exercise both values supplied by JavaScript callers at the Driver boundary.
      Reflect.set(input, "recoverOnly", recoverOnly);
      await assert.rejects(driver.sender.open(input, signal), ScopeViolationError);
      assert.equal(requests, before);
    }
  });

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
        await assert.rejects(driver.sender.open(openInput, signal), DependencyUnavailableError);
        reply = { status: 200, body: status };
        await assert.rejects(
          driver.sender.open({ ...openInput, recoverOnly: true }, signal),
          DependencyUnavailableError,
        );
        await assert.rejects(driver.sender.status(id, signal), DependencyUnavailableError);
        // Use CLOSED for otherwise OPEN observations so rejection must inspect the malformed field.
        reply = {
          status: 200,
          body: {
            ...status,
            ...("state" in status && status.state === "OPEN" ? { state: "CLOSED" } : {}),
          },
        };
        await assert.rejects(driver.sender.close(id, signal), DependencyUnavailableError);
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
      const statusById = await driver.sender.status(id, signal);
      const closed = await driver.sender.close(id, signal);
      const recovered = await driver.sender.open({ ...openInput, recoverOnly: true }, signal);
      assert.equal(recovered.kind, "recovered");
      for (const status of [statusById, closed, recovered.status]) {
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
        await assert.rejects(client.status(id, signal), isRetryable);
        await assert.rejects(client.close(id, signal), isRetryable);
        await assert.rejects(driver.sender.status(id, signal), DependencyUnavailableError);
        await assert.rejects(driver.sender.close(id, signal), DependencyUnavailableError);
        await assert.rejects(
          driver.sender.open({ ...openInput, recoverOnly: true }, signal),
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
        await assert.rejects(driver.sender.open(openInput, signal), DependencyUnavailableError);
        reply = { status: 200, body: status };
        await assert.rejects(
          driver.sender.open({ ...openInput, recoverOnly: true }, signal),
          DependencyUnavailableError,
        );
      }
      reply = {
        status: 201,
        body: { session: open, bearer: "b".repeat(43), client: configuration },
      };
      await assert.rejects(
        driver.sender.open({ ...openInput, recoverOnly: true }, signal),
        DependencyUnavailableError,
      );
    },
  );

  await t.test("created response rejects a non-string client username", async () => {
    const input = {
      namespaceId: "namespace",
      repositoryRef: "project",
      profile: "git-read",
      expectedBinding: valid.binding,
      durationSeconds: 1,
      deadlineWallMs: valid.deadlineWallMs,
    };
    const admissionId = `${Date.now()}-${randomUUID()}`;
    const body = {
      session: { ...valid, state: "OPEN" },
      bearer: "b".repeat(43),
      client: configuration,
    };
    reply = { status: 201, body };
    const opened = await client.open(input, admissionId, signal);
    assert.equal(opened.kind, "created");
    assert.deepEqual(opened.result.client, configuration);
    for (const policy of [null, "refs/heads/main", ["refs/tags/v1"], ["refs/heads/topic/**"]]) {
      reply = {
        status: 201,
        body: { ...body, client: { ...configuration, pushRefAllowlist: policy } },
      };
      await assert.rejects(client.open(input, admissionId, signal), isRetryable);
    }
    // A username bypasses URL parsing but still crosses the untrusted control-response boundary.
    reply = { status: 201, body: { ...body, client: { ...configuration, gitUsername: 1 } } };
    await assert.rejects(client.open(input, admissionId, signal), isRetryable);
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
      (error: unknown) =>
        isRetryable(error) &&
        "message" in error &&
        typeof error.message === "string" &&
        !error.message.includes(socket),
    );
  }
});

registerAdmissionCapabilityCases();
