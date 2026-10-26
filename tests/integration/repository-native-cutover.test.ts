import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { rootCertificates } from "node:tls";
import { socketDirectory } from "../helpers/socket-directory.mjs";
import {
  loadInstallationConfiguration,
  loadStartupConfigurationSnapshot,
} from "../../apps/controller/src/composition/installation-config.ts";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import { startRepositoryReceiptServer } from "../../apps/controller/src/backends/repository-credentials/receipt-server.ts";
import { RepositoryReceiptStore } from "../../apps/controller/src/backends/repository-credentials/receipt-store.ts";
import { createSystemClock } from "../../apps/controller/src/drivers/repo/credentials/clock.ts";
import { validateServiceConfig } from "../../apps/controller/src/drivers/repo/credentials/configuration.ts";
import {
  createControlAdmission,
  handleControl,
} from "../../apps/controller/src/drivers/repo/credentials/control.ts";
import { createCredentialService } from "../../apps/controller/src/drivers/repo/credentials/service.ts";
import { GitHubNativeRepositorySender } from "../../apps/controller/src/drivers/repo/github/driver.ts";
import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import { createPreparedGitHubRegistryFactory } from "../../apps/controller/src/drivers/repo/github/credentials/warm-registry-factory.ts";
import { validateGitHubConfiguration } from "../../apps/controller/src/drivers/repo/github/credentials/config.ts";
import { createGitHubDriverFactory } from "../../apps/controller/src/drivers/repo/github/credentials/factory.ts";
import { createGitHubStaticTokenOwner } from "../../apps/controller/src/drivers/repo/github/credentials/static-token.ts";
import { validateGitHubRepositoryRegistry } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import type { RepositoryServiceFactory } from "../../apps/controller/src/drivers/repo/credentials/backend-contracts.ts";
import type { RepositoryCredentialBoundSessionInput } from "../../apps/controller/src/drivers/repo/credentials/service-contracts.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import {
  seedSessionRevision,
  sessionAttempt,
} from "../conformance/repository-sessions.contract.mjs";
import {
  serviceConfigurationData,
  githubTokenConfigurationData,
} from "../fixtures/repository-credentials/builders.mjs";

async function fixture(t: TestContext) {
  const directory = await socketDirectory(t, "native-cutover-");
  const socket = join(directory, "c");
  const clock = createSystemClock();
  const config = validateServiceConfig(
    serviceConfigurationData({ gateway: { controlSocket: socket } }),
  );
  const namespaceId = `ns_${randomUUID()}`;
  const registry = validateGitHubRepositoryRegistry({
    version: 1,
    backendId: "repository-provider",
    providerInstanceId: "github-test",
    appId: "123",
    githubInstallationId: "456",
    maximumDurationSeconds: 600,
    repositories: [
      {
        repositoryRef: "project",
        repositoryId: "789",
        repository: "example/project",
        namespaces: [
          {
            namespaceId,
            profiles: ["git-write"],
            transport: "git-only",
            pushRefAllowlist: ["refs/heads/review"],
          },
        ],
      },
    ],
  });
  const client = new UnixRepositoryCredentialControlClient({ controlSocket: socket });
  const backend = { id: registry.backendId, drivers: { repo: "repository-credentials" }, client };
  const policy = new GitHubRepositoryPolicy(backend, registry, { sessionDurationSeconds: 600 });
  const binding = policy.resolve({
    namespaceId,
    bindings: [{ repositoryRef: "project", profile: "git-write" }],
  }).bindings[0]!;
  const sender = new GitHubNativeRepositorySender(backend, {});
  const state = new InMemoryPlatformState();
  const deadlineWallMs = Date.now() + 600_000;
  const { revision } = await seedSessionRevision(
    state,
    {
      driver: { id: sender.id, implementation: sender.implementation },
      bindings: [binding],
      deadlineWallMs,
    },
    { namespaceId, createdAt: new Date().toISOString() },
  );
  const owner = {
    driverId: sender.id,
    implementation: sender.implementation,
    backendId: backend.id,
  };
  const receipts = new RepositoryReceiptStore(state, owner);
  const listener = await startRepositoryReceiptServer({ controlSocket: socket, state, ...owner });
  t.after(() => listener.close());
  const prepared = createPreparedGitHubRegistryFactory({
    registry,
    clock,
    limits: config.limits,
    gatewayOrigin: config.gateway.publicOrigin,
    socketPath: join(directory, "use"),
  });
  async function serve(factory: RepositoryServiceFactory) {
    const service = createCredentialService({ config, factory, clock });
    let opens = 0;
    const admissions = createControlAdmission(
      {
        open(input, standing) {
          opens++;
          return service.open(input, standing);
        },
        status: service.status,
        close: service.close,
      },
      config,
      clock,
      factory.resolveBound !== undefined,
      "createPrepared" in factory,
    );
    const stop = service.observeDisposal(admissions.observe);
    const server = createServer((request, response) => {
      void handleControl(request, response, config, clock, admissions);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    let closed = false;
    const close = async () => {
      if (closed) {
        return;
      }
      closed = true;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await service.shutdown(1000);
      await admissions.flush();
      stop();
      admissions.dispose();
    };
    t.after(close);
    return { close, service, opens: () => opens };
  }
  async function attempt(protocol: 1 | 3 = 3) {
    const admissionId = `${Date.now()}-${randomUUID()}`;
    await state.transact((unit) =>
      unit.repositorySessions.createAttempt(
        sessionAttempt(revision, {
          admissionId,
          durationSeconds: 600,
          repositoryRef: binding.repositoryRef,
          brokerProtocol: protocol,
        }),
      ),
    );
    const input = { namespaceId, admissionId, binding, durationSeconds: 600, deadlineWallMs };
    const wire: RepositoryCredentialBoundSessionInput = {
      namespaceId,
      repositoryRef: binding.repositoryRef,
      expectedBinding: binding.grant,
      profile: binding.profile,
      durationSeconds: 600,
      deadlineWallMs,
      durableAdmission: true,
      ...(protocol === 3 ? { preparedOnly: true } : {}),
    };
    return { input, wire };
  }
  return {
    client,
    sender,
    state,
    revision,
    receipts,
    attempt,
    serve,
    prepared,
    config,
    clock,
    binding,
    directory,
    registry,
  };
}

test("legacy native selection fails before worker composition in every mode", async () => {
  for (const mode of ["production", "development"] as const) {
    await assert.rejects(
      loadInstallationConfiguration({
        mode,
        environment: {},
        startupConfiguration: {
          logging: { level: "info" },
          configuration: {
            occ: { cluster: "local" },
            presets: { includeDefaults: false },
            drivers: {
              repo: {
                id: "repository-credentials",
                configuration: {
                  controlSocket: "/run/repository/control.sock",
                  publicCaPath: "/run/repository/ca.pem",
                  sessionDurationSeconds: 600,
                },
              },
            },
          },
        },
      }),
      /Drain accepted work ON THE ORIGINAL owner before cutover/,
    );
  }
});

test("prepared sender opens through the actual control handler and binds durable authority", async (t) => {
  const f = await fixture(t);
  await f.serve(f.prepared);
  const { input, wire } = await f.attempt();
  await f.sender.checkAdmissionReady(AbortSignal.timeout(3000));
  const opened = await f.sender.open(input, AbortSignal.timeout(3000));
  assert.equal(opened.kind, "created");
  if (opened.kind !== "created") {
    return;
  }
  const receipt = await f.state.read((view) =>
    view.repositorySessions.findBrokerReceipt(input.admissionId),
  );
  assert.equal(receipt?.state, "active");
  assert.equal(receipt?.sessionId, opened.session.sessionId);
  // An unmarked lookup cannot reinterpret the prepared attempt as a v1 authority.
  const { preparedOnly: _marker, ...unmarked } = wire;
  await assert.rejects(
    f.receipts.admission(input.admissionId, unmarked, randomUUID(), true),
    /RECEIPT_UNAVAILABLE/,
  );
  const recovered = await f.sender.open(
    { ...input, preparedOnly: true, recoverOnly: true },
    AbortSignal.timeout(3000),
  );
  assert.equal(recovered.kind, "recovered");
  assert.equal(
    (await f.sender.close(opened.session.sessionId, AbortSignal.timeout(3000)))?.state,
    "DISPOSED",
  );
  assert.equal(
    (await f.state.read((view) => view.repositorySessions.findBrokerReceipt(input.admissionId)))
      ?.state,
    "disposed",
  );
});

test("a development-token peer swapped after readiness cannot serve prepared OPEN", async (t) => {
  const f = await fixture(t);
  const first = await f.serve(f.prepared);
  await f.sender.checkAdmissionReady(AbortSignal.timeout(3000));
  await first.close();
  const authority = createGitHubStaticTokenOwner({ token: Buffer.from("gho_" + "x".repeat(36)) });
  t.after(() => authority.close());
  const factory = createGitHubDriverFactory({
    authority,
    configuration: validateGitHubConfiguration(githubTokenConfigurationData()),
    gatewayOrigin: f.config.gateway.publicOrigin,
    limits: f.config.limits,
    clock: f.clock,
  });
  const current = await f.serve(factory);
  const { input } = await f.attempt();
  await assert.rejects(f.sender.open(input, AbortSignal.timeout(3000)), /request was rejected/);
  assert.equal(
    await f.state.read((view) => view.repositorySessions.findBrokerReceipt(input.admissionId)),
    undefined,
  );
  // The independently selected direct development tool remains supported.
  const direct = current.service.open({ durationSeconds: 60, profile: "git-read" });
  assert.equal(direct.session.state, "OPEN");
  current.service.close(direct.session.sessionId);
});

test("v1 unknown recovery fences its original id without creating a replacement", async (t) => {
  const f = await fixture(t);
  await f.serve(f.prepared);
  const { input, wire } = await f.attempt(1);
  // Even an otherwise matching old fresh request cannot reserve an attempt.
  await assert.rejects(
    f.client.open(wire, input.admissionId, AbortSignal.timeout(3000)),
    /rejected/,
  );
  assert.equal(
    await f.state.read((view) => view.repositorySessions.findBrokerReceipt(input.admissionId)),
    undefined,
  );
  assert.deepEqual(
    await f.sender.open({ ...input, recoverOnly: true }, AbortSignal.timeout(3000)),
    { kind: "missing" },
  );
  assert.deepEqual(
    await f.sender.open({ ...input, recoverOnly: true }, AbortSignal.timeout(3000)),
    { kind: "missing" },
  );
  const attempts = await f.state.read((view) =>
    view.repositorySessions.listRevisionAttempts({
      namespaceId: f.revision.namespaceId,
      agentId: f.revision.agentId,
      revisionId: f.revision.id,
    }),
  );
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.admissionId, input.admissionId);
  assert.equal(
    (await f.state.read((view) => view.repositorySessions.findBrokerReceipt(input.admissionId)))
      ?.state,
    "fenced",
  );
});

test("v1 terminal lookup and close preserve the original session and receipt", async (t) => {
  const f = await fixture(t);
  const { input } = await f.attempt(1);
  const generation = randomUUID();
  const sessionId = randomUUID();
  // Simulate a persisted disposal from the original owner, using real State transitions.
  await f.state.transact(async (unit) => {
    const sessions = unit.repositorySessions;
    await sessions.createBrokerReceipt({
      admissionId: input.admissionId,
      state: "reserved",
      generation,
    });
    await sessions.advanceBrokerReceipt({
      admissionId: input.admissionId,
      expectedState: "reserved",
      state: "active",
      generation,
      sessionId,
      deadlineWallMs: input.deadlineWallMs,
    });
    await sessions.advanceAttempt({
      admissionId: input.admissionId,
      expectedPhase: "opening",
      phase: "open",
      sessionId,
      updatedAt: new Date().toISOString(),
    });
    await sessions.advanceAttempt({
      admissionId: input.admissionId,
      expectedPhase: "open",
      phase: "closing",
      updatedAt: new Date().toISOString(),
    });
    await sessions.advanceBrokerReceipt({
      admissionId: input.admissionId,
      expectedState: "active",
      state: "disposed",
      generation,
      sessionId,
      deadlineWallMs: input.deadlineWallMs,
      revoked: 1,
      expired: 0,
    });
  });
  await f.serve(f.prepared);
  const recovered = await f.sender.open({ ...input, recoverOnly: true }, AbortSignal.timeout(3000));
  assert.equal(recovered.kind, "recovered");
  if (recovered.kind !== "recovered") {
    return;
  }
  assert.equal(recovered.status.sessionId, sessionId);
  assert.equal(recovered.status.state, "DISPOSED");
  assert.equal((await f.sender.close(sessionId, AbortSignal.timeout(3000)))?.sessionId, sessionId);
  assert.equal(
    (await f.state.read((view) => view.repositorySessions.findBrokerReceipt(input.admissionId)))
      ?.generation,
    generation,
  );
});

test("complete native configuration requires explicit selection and custody without protected fallback", async (t) => {
  const f = await fixture(t);
  const registryPath = join(f.directory, "registry.json");
  const publicCaPath = join(f.directory, "ca.pem");
  await writeFile(registryPath, JSON.stringify(f.registry), { mode: 0o600 });
  await writeFile(publicCaPath, rootCertificates[0]!, { mode: 0o600 });
  const snapshot = await loadStartupConfigurationSnapshot({
    mode: "production",
    environment: {
      OCC_CONFIG_PATH: join(process.cwd(), "deploy/examples/production/installation.yaml"),
    },
  });
  const configuration = structuredClone(snapshot.configuration)! as Record<string, unknown>;
  const drivers = configuration.drivers as Record<string, unknown>;
  delete drivers.plugin;
  const compute = drivers.compute as { configuration: { network: Record<string, unknown> } };
  compute.configuration.network.gatewayTrustedProxyCidrs = ["127.0.0.1/32"];
  compute.configuration.network.repositoryCredentials = {
    namespace: "controller",
    podLabels: { app: "worker" },
    port: 8443,
  };
  configuration.backend = [
    {
      id: f.registry.backendId,
      type: "github",
      configuration: { registryPath },
      drivers: { repo: f.sender.id },
    },
  ];
  const repository = {
    id: f.sender.id,
    configuration: { sessionDurationSeconds: 600 },
    nativeSender: { controlSocket: f.config.gateway.controlSocket, publicCaPath },
    preparedGitHub: {
      custodyKeyPath: join(f.directory, "custody.key"),
      privateKeyPath: join(f.directory, "app.pem"),
    },
  };
  configuration.repository = repository;
  const load = () =>
    loadInstallationConfiguration({
      mode: "production",
      environment: {},
      startupConfiguration: { ...snapshot, configuration },
    });
  assert.ok((await load())?.nativeRepositorySender);
  configuration.repository = { ...repository, preparedGitHub: undefined };
  await assert.rejects(load(), /requires prepared GitHub custody/);
  // Selecting a Sandbox never downgrades protected delivery to the native socket.
  configuration.repository = repository;
  drivers.sandbox = { id: "sandbox", configuration: {} };
  await assert.rejects(load(), /protected Git cannot fall back/);
  delete drivers.sandbox;
  delete configuration.repository;
  drivers.repo = {
    id: f.sender.id,
    configuration: { ...repository.configuration, ...repository.nativeSender },
  };
  await assert.rejects(load(), /Drain accepted work ON THE ORIGINAL owner/);
});

test("v1 unknown reserved result remains unresolved without a second acquisition", async (t) => {
  const f = await fixture(t);
  const { input } = await f.attempt(1);
  const generation = randomUUID();
  await f.state.transact((unit) =>
    unit.repositorySessions.createBrokerReceipt({
      admissionId: input.admissionId,
      state: "reserved",
      generation,
    }),
  );
  const server = await f.serve(f.prepared);
  for (let pass = 0; pass < 2; pass++) {
    await assert.rejects(
      f.sender.open({ ...input, recoverOnly: true }, AbortSignal.timeout(3000)),
      /unavailable/,
    );
  }
  assert.equal(server.opens(), 0);
  const receipt = await f.state.read((view) =>
    view.repositorySessions.findBrokerReceipt(input.admissionId),
  );
  assert.equal(receipt?.state, "reserved");
  assert.equal(receipt?.generation, generation);
});
