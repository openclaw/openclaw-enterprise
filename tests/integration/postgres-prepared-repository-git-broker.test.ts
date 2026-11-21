import assert from "node:assert/strict";
import { join } from "node:path";
import { request, Agent, type RequestOptions } from "node:https";
import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
} from "node:http";
import { createNativeClientMaterial } from "../fixtures/repository-credentials/clients.ts";
import { connect, createServer as createTcpServer } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { buffer } from "node:stream/consumers";
import test, { after, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";

import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { repositoryRemovalWorkKey } from "../../packages/occ/src/repository-withdrawal.ts";
import {
  createAuthenticatedControllerRequest,
  createTestAuthPrincipal,
} from "../helpers/auth-session.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { relaySockets } from "../helpers/socket-relay.ts";
import { fixture, prepare } from "../fixtures/prepared-repository-git.mjs";
import {
  cleanEnvironment,
  listen,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.ts";
import { startGitSmartHttpFixture } from "../fixtures/repository-credentials/git.ts";
import { serviceConfigurationData } from "../fixtures/repository-credentials/builders.ts";
import { createCredentialService } from "../fixtures/repository-credentials/service.ts";
import { createSystemClock } from "../../apps/controller/src/drivers/repo/access/clock.ts";
import { validateServiceConfig } from "../../apps/controller/src/drivers/repo/access/configuration.ts";
import { startListeners } from "../../apps/controller/src/drivers/repo/access/server.ts";
import type { RefusalRecord } from "../../apps/controller/src/drivers/repo/access/transport/agent.ts";
import { createPreparedGitHubRegistryFactory } from "../../apps/controller/src/drivers/repo/github/access/warm-registry-factory.ts";
import { startPreparedGitHubGitOwner } from "../../apps/controller/src/backends/repository-credentials/prepared-git-owner.ts";
import { startRepositoryReceiptServer } from "../../apps/controller/src/backends/repository-credentials/receipt-server.ts";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import {
  backendDefinition,
  createAccessTokenServiceAccount,
  createBackendWorkerDrivers,
  poolWithOneBackendBindingReadFault,
  seedBackendBinding,
} from "../helpers/postgres-backend-state.mjs";
import type {
  BackendDefinition,
  ComputeDriver,
  RepositoryCredentialRuntimeBinding,
} from "../../packages/contracts/src/index.ts";
import { GitHubNativeRepositorySender } from "../../apps/controller/src/drivers/repo/github/driver.ts";
import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.ts";
import { startRegistryCredentialServiceFixture } from "../fixtures/repository-credentials/registry.ts";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import { removeAccessBindings } from "../helpers/postgres-worker-revision-support.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.ts";
import { protectedRepositoryGitRelease } from "../helpers/protected-repository-git-release.ts";
import { waitFor } from "../helpers/wait-for.ts";

type BrokerInput = Parameters<
  NonNullable<NonNullable<Parameters<typeof fixture>[1]>["openBroker"]>
>[0];
type BrokerRequest = {
  method?: string;
  headers?: OutgoingHttpHeaders;
  body?: string | Buffer | undefined;
  beforeBody?: () => Promise<void>;
};
type BrokerResponse = { status: number; text: string };
type Broker = Awaited<ReturnType<typeof startBroker>>;

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function jsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  return object(value);
}

async function readResponse(response: IncomingMessage): Promise<BrokerResponse> {
  const { statusCode } = response;
  if (statusCode === undefined) {
    throw new Error("Expected an HTTP response status");
  }
  return { status: statusCode, text: (await buffer(response)).toString() };
}

async function readProviderPulls(url: string, options: RequestOptions): Promise<unknown[]> {
  // The request callback cannot propagate promise rejections to its caller.
  const response = await new Promise<BrokerResponse>(
    (resolve, reject: (reason: unknown) => void) => {
      request(url, options, (message) => {
        void readResponse(message).then(resolve, reject);
      })
        .once("error", reject)
        .end();
    },
  );
  assert.equal(response.status, 200, "Expected a successful provider pull list");
  const value: unknown = JSON.parse(response.text);
  assert.ok(Array.isArray(value), "Expected the provider's list of pull requests");
  return value;
}

async function startBroker(
  t: TestContext,
  {
    gh,
    registry,
    socketPath,
    namespaceId,
    binding,
    pushRef,
    deadlineWallMs,
    repository,
  }: BrokerInput,
) {
  const tls = gh.tls;
  const observed: { method: string | undefined; url: string | undefined }[] = [];
  const origin = await startGitSmartHttpFixture(t, {
    tls,
    repository,
    authorize: gh.authorize,
    observeRequest: (method, url) => observed.push({ method, url }),
  });
  // Control the time of verified upstream TLS without trusting a substitute sender.
  let slow = false;
  const tcp = createTcpServer(async (socket) => {
    if (slow) {
      await delay(5250);
    }
    if (socket.destroyed) {
      return;
    }
    relaySockets(socket, connect(Number(new URL(origin.origin).port), "127.0.0.1"));
  });
  const gitOrigin = await listen(t, tcp);
  const clock = createSystemClock();
  const gatewayOrigin = "https://127.0.0.1";
  const config = validateServiceConfig(
    serviceConfigurationData({
      limits: { connectMs: 12000, stallMs: 12000, gitFetchStallMs: 12000 },
      gateway: {
        publicOrigin: gatewayOrigin,
        listen: "127.0.0.1:8443",
        controlSocket: join(socketPath, "..", "control.sock"),
      },
    }),
  );
  const factory = createPreparedGitHubRegistryFactory({
    registry,
    clock,
    socketPath,
    gitOrigin,
    apiOrigin: gh.origin,
    gatewayOrigin,
    limits: config.limits,
  });
  const service = createCredentialService({ config, factory, clock });
  t.after(() => service.shutdown(5000));
  // The production composition writes each refusal record to the broker's log (finding 2411).
  const logs: RefusalRecord[] = [];
  const server = await startListeners({
    service,
    factory,
    clock,
    tls,
    log: (record) => logs.push(record),
    config: { ...config, gateway: { ...config.gateway, listen: "127.0.0.1:0" } },
    upstreamCa: tls.ca,
    trustedUpstreamOrigins: factory.trustedUpstreamOrigins,
  });
  t.after(() => server.close());
  const address = gatewayOrigin + ":" + server.address.port;
  const openSession = () =>
    service.open({
      durationSeconds: 600,
      namespaceId,
      repositoryRef: binding.repositoryRef,
      profile: binding.profile,
      expectedBinding: binding.grant,
      deadlineWallMs,
      preparedOnly: true,
    });
  const opened = openSession();
  const authorization =
    "Basic " + Buffer.from("gateway-session:" + opened.bearer).toString("base64");
  const agent = new Agent({ ca: tls.ca, keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  function http(
    path: string,
    { method = "GET", headers, body, beforeBody }: BrokerRequest = {},
  ): Promise<BrokerResponse> {
    return new Promise((resolve, reject: (reason: unknown) => void) => {
      const req = request(
        address + path,
        { agent, method, headers: { authorization, host: "127.0.0.1", ...headers } },
        (res) => {
          void readResponse(res).then(resolve, reject);
        },
      );
      req.once("error", reject);
      if (beforeBody) {
        req.once("continue", () => {
          const socket = req.socket;
          void beforeBody()
            .then(() => {
              assert.equal(req.socket, socket);
              req.end(body);
            })
            .catch((error: unknown) => {
              req.destroy();
              reject(error);
            });
        });
        req.flushHeaders();
      } else {
        req.end(body);
      }
    });
  }
  const env = cleanEnvironment({
    GIT_SSL_CAINFO: tls.certFile,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_2: "http.extraHeader",
    GIT_CONFIG_VALUE_2: "Host: 127.0.0.1",
    GIT_CONFIG_KEY_1: "http.extraHeader",
    GIT_CONFIG_VALUE_1: "Authorization: " + authorization,
  });
  return {
    http,
    address,
    origin,
    observed,
    logs,
    identity: {
      sessionId: opened.session.sessionId,
      namespaceId,
      repositoryRef: binding.repositoryRef,
    },
    opened,
    openSession,
    env,
    pushRef,
    repository,
    slow(value: boolean) {
      slow = value;
    },
  };
}

// Exercise the normal authenticated HTTP withdrawal against the exact same State as
// the worker. This component test does not start Compute or a model/chat session.
// Finding 2411: each refused authenticated request logs exactly one record with the code
// the Agent received (an error envelope's code, or a receipt's error), where it was refused,
// the operation once known, and the session.
function refusedOnceBy(
  b: Broker,
  response: BrokerResponse,
  reason: RefusalRecord["reason"],
  operation?: RefusalRecord["operation"],
  upstreamConnect?: RefusalRecord["upstreamConnect"],
) {
  assert.ok(response.status >= 400, response.text);
  const { error } = jsonObject(response.text);
  const reasonCode = typeof error === "string" ? error : object(error).code;
  assert.equal(typeof reasonCode, "string");
  assert.deepEqual(b.logs.splice(0), [
    {
      event: "repository-credentials.denied",
      status: response.status,
      reasonCode,
      reason,
      ...(operation === undefined ? {} : { operation }),
      ...(upstreamConnect === undefined ? {} : { upstreamConnect }),
      ...b.identity,
    },
  ]);
}

const { setup: setupNativeWithdrawal, cleanup: cleanupNativeWithdrawal } =
  createWorkerRevisionFixtures(import.meta.url);
after(cleanupNativeWithdrawal);

function discoverNativeBearer(
  port: number,
  ca: Buffer,
  bearer: string,
): Promise<number | undefined> {
  return nativeBrokerStatus(
    port,
    ca,
    bearer,
    "/fixture/repository.git/info/refs?service=git-upload-pack",
  );
}

function nativeBrokerStatus(
  port: number,
  ca: Buffer,
  bearer: string,
  path: string,
  { method = "GET", headers, body }: BrokerRequest = {},
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        ca,
        agent: false,
        timeout: 8000,
        headers: {
          host: "credentials.example.test",
          authorization: `Basic ${Buffer.from(`gateway-session:${bearer}`).toString("base64")}`,
          ...headers,
        },
      },
      (incoming) => {
        incoming.resume();
        incoming.once("error", reject);
        incoming.once("end", () => resolve(incoming.statusCode));
      },
    );
    outgoing.once("timeout", () => outgoing.destroy(new Error("Git discovery timed out")));
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

for (const outcome of [
  "settled",
  "unconfirmed revocation",
  "runtime observation is unavailable",
  "custody read recovers",
  "unexpected custody family",
  "settled draft-capable transport",
  "unsettled draft receipt",
  "draft provider reply lost",
  "unissued draft-capable transport",
  "stored execution admission incompatible",
  "model account changes",
  "model account binding revoked",
  "model account lookup fault cannot mask lost actor authority",
  "model account Backend missing",
  "model account binding revoked after custody read",
  "model account final IAM fault with revoked binding",
  "model account final read recovers",
  "model Secret unavailable",
] as const) {
  test(
    `finite native Git binding removal: ${outcome}`,
    { ...requiresPostgres, timeout: 65_000 },
    async (t) => {
      const backendId = "github-fixture";
      const driverId = "repository-credentials";
      const modelProvider = outcome.startsWith("model account") ? backendDefinition() : undefined;
      const modelBackends = modelProvider === undefined ? [] : [modelProvider];
      const gitBackend: BackendDefinition = {
        id: backendId,
        type: "github",
        configuration: { registryPath: "/unused/controlled-registry.json" },
        drivers: { repo: driverId },
      };
      const f = await setupNativeWithdrawal(t, { backends: [...modelBackends, gitBackend] });
      const lostDraftReply = outcome === "draft provider reply lost";
      const draftMustRetire = lostDraftReply || outcome === "unsettled draft receipt";
      const transientRuntime = outcome === "runtime observation is unavailable";
      const modelBindingRevokedAfterCustody =
        outcome === "model account binding revoked after custody read";
      const draftTransport =
        outcome === "settled draft-capable transport" ||
        transientRuntime ||
        draftMustRetire ||
        outcome === "unissued draft-capable transport";
      const withoutFamily = outcome === "unissued draft-capable transport";
      const clock = createControlledClock();
      const startedWall = clock.wallNow();
      const git = await startRegistryCredentialServiceFixture(t, {
        namespaceId: f.namespace.id,
        backendId,
        repositories: [
          {
            repositoryRef: "repo-a",
            repository: "fixture/repository",
            repositoryId: "73",
            ...(draftTransport && { transport: "git-and-draft-pr", pullRequestBase: "main" }),
          },
        ],
        autoOpen: false,
        clock: { ...clock, wallNow: () => Date.now() + clock.wallNow() - startedWall },
        gateway: { listen: "127.0.0.1:0" },
      });
      const socket = git.config.gateway.controlSocket;
      const driver = new GitHubRepositoryPolicy({ driverId, backendId }, git.registry, {
        sessionDurationSeconds: 60,
      });
      const sender = new GitHubNativeRepositorySender(
        {
          id: git.backendId,
          client: new UnixRepositoryCredentialControlClient({ controlSocket: socket }),
          drivers: { repo: driver.id },
        },
        { publicCa: git.tls.ca },
      );
      const receipts = await startRepositoryReceiptServer({
        state: f.state,
        controlSocket: socket,
        driverId: driver.id,
        implementation: driver.implementation,
        backendId: git.backendId,
      });
      t.after(() => receipts.close());
      const subject = git.byRef.get("repo-a")!;
      const provider = subject.github;
      const keyDirectory = await temporaryDirectory(t, "native-withdrawal-owner-");
      const privateKeyPath = join(keyDirectory, "app.pem");
      const custodyKeyPath = join(keyDirectory, "custody");
      await writeFile(
        privateKeyPath,
        provider.privateKey.export({ type: "pkcs8", format: "pem" }),
        { mode: 0o600 },
      );
      await writeFile(custodyKeyPath, randomBytes(32), { mode: 0o600 });
      const issuer = new URL(provider.origin);
      assert.equal(issuer.hostname, "127.0.0.1");
      const prepared = await startPreparedGitHubGitOwner({
        registry: git.registry,
        pool: f.observerPool,
        driverId,
        backendId,
        implementation: driver.implementation,
        privateKeyPath,
        custodyKeyPath,
        controlSocket: socket,
        apiOrigin: issuer.origin,
        ca: git.tls.ca,
        startWorker: false,
        repositoryGitCustody: { kind: "native-broker" },
      });
      t.after(() => prepared.close());
      f.controller.registerDriver(driver);
      f.controller.selectDriver("repo", driver.id);
      const modelAccount =
        modelProvider === undefined
          ? undefined
          : await createAccessTokenServiceAccount(f.state, f.namespace.id, "native-model");
      if (modelAccount !== undefined) {
        await seedBackendBinding(f.observerPool, modelAccount);
      }
      const owner = await f.agent("finite-native-withdrawal", {
        executionMode: "dedicated",
        ...(modelAccount &&
          modelProvider && {
            serviceAccountId: modelAccount.id,
            backendId: modelProvider.id,
          }),
      });
      const selections = [{ repositoryRef: "repo-a", profile: "git-write" }];
      await f.controller.updateAgent(f.actor.id, {
        namespaceId: f.namespace.id,
        agentId: owner.id,
        configurationId: owner.configurationId,
        repositoryBindings: selections,
      });
      const binding = driver.resolve({
        namespaceId: f.namespace.id,
        bindings: selections,
      }).bindings;
      const disposableDeployer =
        outcome === "model account lookup fault cannot mask lost actor authority"
          ? "deployer-" + randomUUID()
          : undefined;
      if (disposableDeployer) {
        await f.copyActorGrants(disposableDeployer);
      }
      const candidate = await f.revision(owner, 1, {
        ...(disposableDeployer && { actorId: disposableDeployer }),
        repositoryCredentials: {
          driver: { id: driver.id, implementation: driver.implementation },
          deadlineWallMs: Date.now() + 55_000,
          bindings: binding,
        },
      });
      const deliveries: Extract<RepositoryCredentialRuntimeBinding, { kind: "new" }>[] = [];
      const stops: string[] = [];
      let preparations = 0;
      let runtimeObservations = 0;
      let runtimeStatus: "running" | "unknown" | "timeout" = "running";
      let failFinalModelRead = false;
      let failedFinalModelReads = 0;
      let failFinalIamRead = false;
      let failedFinalIamReads = 0;
      let checkIncompatibleAdmission = false;
      const incompatibleCompute =
        outcome === "stored execution admission incompatible"
          ? createTestKubernetesComputeDriver(f.compute.id, {
              protectedDriver: protectedRepositoryGitRelease(() =>
                assert.fail("stored admission cannot call repository access"),
              ).owner,
            })
          : undefined;
      const revokeModelBinding = async () => {
        assert.ok(modelAccount);
        const binding = await f.observerPool.query(
          "UPDATE occ.service_account_driver_bindings SET external_credential_id=NULL WHERE namespace_id=$1 AND service_account_id=$2",
          [f.namespace.id, modelAccount.id],
        );
        assert.equal(binding.rowCount, 1);
      };
      const compute: ComputeDriver = {
        ...f.compute,
        validateExecutionAdmission(revision, source) {
          if (checkIncompatibleAdmission) {
            assert.ok(incompatibleCompute);
            incompatibleCompute.validateExecutionAdmission(revision, source);
          }
        },
        validateRepositoryCredentials(harness, sandboxDriverId) {
          assert.equal(harness.mode, "dedicated");
          assert.equal(sandboxDriverId, undefined);
        },
        async prepareRevision(revision, context) {
          preparations++;
          const delivery = context?.repositoryCredentials?.find((value) => value.kind === "new");
          if (delivery) {
            deliveries.push(delivery);
          }
          return f.compute.prepareRevision(revision, context);
        },
        // The native removal must use its prepared custodian.
        async retireExpiredRepositoryAccess() {
          return "retire-runtime";
        },
        async observeRevision(revision) {
          assert.equal(revision.id, candidate.id);
          runtimeObservations++;
          if (runtimeStatus === "timeout") {
            throw new DOMException("Controlled Kubernetes status read timeout", "TimeoutError");
          }
          return { state: runtimeStatus };
        },
        async stopRevision(revision) {
          stops.push(revision.id);
          return f.compute.stopRevision(revision);
        },
      };
      const statuses: Readonly<Record<string, unknown>>[] = [];
      const observeNativeRepositoryWithdrawal = prepared.observeNativeWithdrawal;
      assert.ok(observeNativeRepositoryWithdrawal);
      let failCustodyRead = false;
      let failedCustodyReads = 0;
      const configured = createBackendWorkerDrivers(compute, modelBackends);
      let omitModelSecret = false;
      let modelSecretMisses = 0;
      const auth = candidate.harnessAuth;
      // Active references protect this Secret from deletion. Inject a successful
      // empty result at its exact storage read to exercise the authoritative miss.
      const modelReadPool: Parameters<typeof createControllerWorker>[0]["pool"] = {
        end: () => f.workerPool.end(),
        query: (sql, values) =>
          f.workerPool.query(sql, values === undefined ? undefined : [...values]),
        async connect() {
          const client = await f.workerPool.connect();
          return {
            release: (discard) => client.release(discard),
            async query(sql, values) {
              if (failFinalIamRead && sql.includes("FROM occ.iam_identities) v")) {
                failFinalIamRead = false;
                failedFinalIamReads++;
                return client.query("SELECT 1 / 0");
              }
              if (
                failFinalModelRead &&
                sql.includes("FROM occ.service_account_driver_bindings AS b") &&
                values?.[0] === f.namespace.id &&
                values[1] === modelAccount?.id
              ) {
                failFinalModelRead = false;
                failedFinalModelReads++;
                if (outcome === "model account lookup fault cannot mask lost actor authority") {
                  // Exercise a PostgreSQL statement failure that aborts its read transaction.
                  return client.query("SELECT 1 / 0");
                }
                throw Object.assign(new Error("controlled connection loss reading model binding"), {
                  code: "08006",
                });
              }
              const result = await client.query(
                sql,
                values === undefined ? undefined : [...values],
              );
              if (
                omitModelSecret &&
                "source" in auth &&
                auth.source.kind === "secret" &&
                sql.includes("FROM occ.secrets AS s") &&
                values?.[0] === auth.source.namespaceId &&
                values[1] === auth.source.id
              ) {
                assert.equal(result.rowCount, 1);
                modelSecretMisses++;
                return { ...result, rows: [], rowCount: 0 };
              }
              return result;
            },
          };
        },
      };
      const startWorker = async (
        pool: Parameters<typeof createControllerWorker>[0]["pool"] = f.workerPool,
        driverConfiguration = configured,
      ) => {
        const worker = createControllerWorker({
          pool,
          pollIntervalMs: 15,
          leaseDurationMs: 5_000,
          maxAttempts: 12,
          drivers: {
            ...driverConfiguration,
            secretDriver: f.secretDriver,
            repositoryPolicy: driver,
            nativeRepositorySender: sender,
          },
          async observeNativeRepositoryWithdrawal(revision, sessions) {
            if (failCustodyRead) {
              failCustodyRead = false;
              failedCustodyReads++;
              throw Object.assign(new Error("controlled connection loss reading custody"), {
                code: "08006",
              });
            }
            const result = await observeNativeRepositoryWithdrawal(revision, sessions);
            if (result === "disposed") {
              if (
                modelBindingRevokedAfterCustody ||
                outcome === "model account final IAM fault with revoked binding"
              ) {
                // Commit model revocation after custody observation and before the locked decision.
                await revokeModelBinding();
                failFinalIamRead = outcome === "model account final IAM fault with revoked binding";
              }
              if (outcome === "model account final read recovers" && failedFinalModelReads === 0) {
                failFinalModelRead = true;
              }
            }
            return result;
          },
          emit: (event) => {
            if (event.event === "worker.completed") {
              statuses.push(event);
            }
          },
        });
        f.database.workers.add(worker);
        await worker.start();
        return worker;
      };
      let worker = await startWorker(
        outcome === "model Secret unavailable" ||
          outcome === "model account final read recovers" ||
          outcome === "model account final IAM fault with revoked binding" ||
          outcome === "model account lookup fault cannot mask lost actor authority"
          ? modelReadPool
          : f.workerPool,
      );
      t.after(() => worker.stop());
      await f.work(candidate, "succeeded");
      assert.equal((await f.currentAgent(owner))?.activeRevisionId, candidate.id);
      assert.equal(deliveries.length, 1, "runtime gets one admitted broker bearer");
      const admit = deliveries[0]!;
      if (!withoutFamily) {
        await prepared.maintain();
      }
      assert.equal(
        provider.issuesOfTokens.length,
        withoutFamily ? 0 : 1,
        "only the prepared owner can issue a provider token",
      );
      const origin = subject.git;
      const initial = origin.traffic().requests;
      const draftPath = "/repos/" + subject.repository + "/pulls";
      const draft = () =>
        nativeBrokerStatus(git.listeners.address.port, git.tls.ca, admit.files.bearer, draftPath, {
          method: "POST",
          headers: {
            authorization: "Bearer " + admit.files.bearer,
            "content-type": "application/json",
            "x-oce-operation-id": randomUUID(),
          },
          body: JSON.stringify({
            title: "Fixture review",
            head: "agent-repo-a",
            base: "main",
            body: "Finite binding witness",
            draft: true,
          }),
        });
      if (!draftTransport) {
        assert.equal(
          await discoverNativeBearer(git.listeners.address.port, git.tls.ca, admit.files.bearer),
          200,
        );
        assert.equal(origin.traffic().requests, initial + 1);
      }
      const issuedDraft = draftTransport && !withoutFamily;
      const hold = issuedDraft ? origin.holdNextFetch({ beforeHeaders: true }) : undefined;
      const held =
        hold &&
        nativeBrokerStatus(
          git.listeners.address.port,
          git.tls.ca,
          admit.files.bearer,
          "/" + subject.repository + ".git/git-upload-pack",
          {
            method: "POST",
            headers: {
              "git-protocol": "version=2",
              "content-type": "application/x-git-upload-pack-request",
            },
            body: "0014command=ls-refs\n00010000",
          },
        ).catch((error: unknown) => error);
      if (hold) {
        t.after(() => hold.release());
        await Promise.race([
          hold.observed,
          held?.then(() => assert.fail("the admitted upload never reached the held origin")),
          delay(5000).then(() => assert.fail("the admitted upload did not start")),
        ]);
        if (lostDraftReply) {
          provider.disconnectAfterMutation("POST", draftPath);
        }
        assert.equal(await draft(), lostDraftReply ? 409 : 201);
        assert.equal(provider.pulls.size, 1);
      }
      const preparationsBeforeRemoval = preparations;
      const removed = await f.controller.updateAgent(f.actor.id, {
        namespaceId: owner.namespaceId,
        agentId: owner.id,
        configurationId: owner.configurationId,
        repositoryBindings: [],
      });
      assert.equal(removed.activeRevisionId, candidate.id);
      if (hold) {
        hold.release();
        await held;
      }
      const key = repositoryRemovalWorkKey(candidate.id);
      const readWork = async () =>
        (
          await f.observerPool.query(
            "SELECT state, reason_code FROM occ.controller_work WHERE idempotency_key=$1",
            [key],
          )
        ).rows[0];
      const first = await waitFor(
        "exact finite removal first disposition",
        async () => {
          const row = await readWork();
          const last = statuses.find(({ workId }) => workId === key);
          return row?.state === "queued" && last
            ? last
            : row?.state === "succeeded"
              ? { code: row.reason_code }
              : undefined;
        },
        10000,
      );
      const receipt = await f.state.read((view) =>
        view.repositorySessions.findBrokerReceiptBySession(admit.sessionId),
      );
      assert.ok(receipt);
      assert.equal(receipt.state, "disposed");
      assert.ok(receipt.generation);
      assert.equal(
        await observeNativeRepositoryWithdrawal(candidate, [
          {
            admissionId: receipt.admissionId,
            sessionId: admit.sessionId,
            generation: randomUUID(),
          },
        ]),
        "unsafe",
        "the prepared owner refuses proof from another broker generation",
      );
      assert.equal(
        await discoverNativeBearer(git.listeners.address.port, git.tls.ca, admit.files.bearer),
        401,
      );
      assert.equal(
        origin.traffic().requests,
        initial + (withoutFamily ? 0 : 1),
        "fresh old-bearer request never reaches Git origin",
      );
      if (withoutFamily) {
        const readback = await f.observerPool.query(
          `SELECT source#>>'{grant,profile}' AS profile,
                  (SELECT custody FROM occ.prepared_github_attempts WHERE source_id=f.source_id) AS custody
           FROM occ.prepared_github_families f WHERE source_id=$1`,
          ["repository-git:" + receipt.admissionId],
        );
        assert.deepEqual(readback.rows, []);
        assert.equal(first.code, "REPOSITORY_RUNTIME_RETIREMENT_QUEUED");
        await waitFor(
          "terminal work to stop the exact draft-capable revision",
          async () =>
            (await f.currentAgent(owner))?.activeRevisionId === undefined ? true : undefined,
          10_000,
        );
        assert.deepEqual(stops, [candidate.id]);
        assert.equal(runtimeObservations, 0);
        assert.equal(deliveries.length, 1);
        return;
      }
      assert.equal(
        first.code,
        "REPOSITORY_CLEANUP_PENDING",
        "broker disposal alone cannot certify provider settlement",
      );
      assert.equal((await f.currentAgent(owner))?.activeRevisionId, candidate.id);
      assert.deepEqual(stops, []);
      assert.equal(runtimeObservations, 0);
      // Re-adding the desired binding cannot restore the old revision's admission or its bearer.
      await f.controller.updateAgent(f.actor.id, {
        namespaceId: owner.namespaceId,
        agentId: owner.id,
        configurationId: owner.configurationId,
        repositoryBindings: selections,
      });
      const runCleanupPass = async () => {
        const beforeRetry = statuses.length;
        assert.equal(
          (
            await f.observerPool.query(
              "UPDATE occ.controller_work SET available_at=clock_timestamp() WHERE idempotency_key=$1 AND state='queued'",
              [key],
            )
          ).rowCount,
          1,
        );
        return waitFor(
          "the same finite cleanup claim to publish its outcome",
          async () => statuses.slice(beforeRetry).find(({ workId }) => workId === key),
          10_000,
        );
      };
      if (issuedDraft) {
        const apiCalls = provider.trace.filter(
          ({ method, target }) => method === "POST" && target === draftPath,
        ).length;
        assert.equal(apiCalls, 1);
        assert.equal(
          await draft(),
          401,
          "removal refuses even a syntactically valid draft before its origin",
        );
        assert.equal(
          provider.trace.filter(({ method, target }) => method === "POST" && target === draftPath)
            .length,
          apiCalls,
        );
        const readback = await f.observerPool.query(
          "SELECT outcome, settled_at IS NOT NULL AS settled FROM occ.prepared_repository_draft_pulls WHERE admission_id=$1",
          [receipt.admissionId],
        );
        assert.deepEqual(readback.rows, [
          { outcome: lostDraftReply ? "outcome_unknown" : "created", settled: true },
        ]);
        if (outcome === "unsettled draft receipt") {
          // A broker crash after the provider reply can leave the original authorization
          // committed with no final receipt. Reproduce that exact persisted boundary.
          const unresolved = await f.observerPool.query(
            "UPDATE occ.prepared_repository_draft_pulls SET outcome='outcome_unknown', projection=NULL, settled_at=NULL WHERE admission_id=$1",
            [receipt.admissionId],
          );
          assert.equal(unresolved.rowCount, 1);
        }
      }
      if (outcome === "stored execution admission incompatible") {
        // The replacement configuration admits a protected pair. The stock validator
        // consequently refuses a saved unprotected native repository revision.
        checkIncompatibleAdmission = true;
        const retirement = await runCleanupPass();
        assert.equal(retirement.code, "REPOSITORY_RUNTIME_RETIREMENT_QUEUED");
        await waitFor(
          "terminal work to stop the incompatible revision",
          async () =>
            (await f.currentAgent(owner))?.activeRevisionId === undefined ? true : undefined,
          10_000,
        );
        assert.deepEqual(stops, [candidate.id]);
        assert.equal(runtimeObservations, 0);
        assert.equal(deliveries.length, 1);
        return;
      }
      if (
        outcome.startsWith("model ") &&
        !modelBindingRevokedAfterCustody &&
        outcome !== "model account final IAM fault with revoked binding" &&
        outcome !== "model account final read recovers"
      ) {
        // Leave the issuer unconfirmed after the first fenced cleanup pass.
        if (outcome === "model account changes") {
          assert.ok(modelAccount);
          await worker.stop();
          worker = await startWorker(poolWithOneBackendBindingReadFault(f.createWorkerPool()));
          const interrupted = await runCleanupPass();
          assert.equal(interrupted.code, "REPOSITORY_CLEANUP_PENDING");
          assert.equal((await f.currentAgent(owner))?.activeRevisionId, candidate.id);
          assert.deepEqual(stops, []);
          assert.ok(
            (
              await f.state.transact((unit) =>
                unit.serviceAccounts.updateCredential(f.namespace.id, modelAccount.id, {
                  kind: "access_token",
                  secretRef: { name: `rotated-model-${randomUUID()}`, key: "token" },
                }),
              )
            )?.credential,
          );
        } else if (outcome === "model account binding revoked") {
          await revokeModelBinding();
        } else if (outcome === "model account lookup fault cannot mask lost actor authority") {
          const original = await f.state.read((view) => view.operations.findWork(key));
          assert.ok(original);
          assert.equal(original.actorId, disposableDeployer);
          const revoked = await removeAccessBindings(f, original.actorId);
          assert.ok(revoked.rowCount && revoked.rowCount > 0);
          const refusal = await new NativeIAMDriver(f.state).authorize({
            principalId: original.actorId,
            action: "deploy",
            resource: { kind: "agent", namespaceId: owner.namespaceId, id: owner.id },
          });
          assert.equal(refusal.allowed, false, "Native IAM denies the exact recorded deployer");
          failFinalModelRead = true;
        } else if (outcome === "model account Backend missing") {
          await worker.stop();
          worker = await startWorker(f.createWorkerPool(), createBackendWorkerDrivers(compute, []));
        } else {
          omitModelSecret = true;
        }
        const retirement = await runCleanupPass();
        assert.equal(retirement.code, "REPOSITORY_RUNTIME_RETIREMENT_QUEUED");
        await waitFor(
          "terminal work to stop the exact original revision",
          async () =>
            (await f.currentAgent(owner))?.activeRevisionId === undefined ? true : undefined,
          10_000,
        );
        assert.deepEqual(stops, [candidate.id]);
        assert.equal(runtimeObservations, 0);
        if (outcome === "model Secret unavailable") {
          assert.equal(modelSecretMisses, 1);
        }
        if (outcome === "model account lookup fault cannot mask lost actor authority") {
          assert.equal(failedFinalModelReads, 1);
        }
        assert.equal(
          await discoverNativeBearer(git.listeners.address.port, git.tls.ca, admit.files.bearer),
          401,
        );
        assert.equal(origin.traffic().requests, initial + 1);
        assert.equal(subject.github.issuesOfTokens.length, 1);
        assert.equal(
          subject.github.trace.filter(
            ({ method, target }) => method === "DELETE" && target === "/installation/token",
          ).length,
          0,
        );
        assert.equal(deliveries.length, 1);
        return;
      }
      if (outcome === "unconfirmed revocation") {
        subject.github.disconnectAfterMutation("DELETE", "/installation/token");
        await assert.rejects(prepared.maintain(), { message: "provider-unavailable" });
      } else {
        await prepared.maintain();
      }
      assert.equal(
        subject.github.trace.filter(
          ({ method, target }) => method === "DELETE" && target === "/installation/token",
        ).length,
        1,
      );
      const { rows } = await f.observerPool.query(
        "SELECT custody FROM occ.prepared_github_attempts WHERE source_id=$1",
        ["repository-git:" + receipt.admissionId],
      );
      assert.deepEqual(rows, [
        { custody: outcome === "unconfirmed revocation" ? "unknown" : "revoked" },
      ]);
      if (outcome === "settled") {
        // Recover the cleanup from durable receipts on a replacement Worker.
        await worker.stop();
        worker = await startWorker(f.createWorkerPool());
      }
      if (outcome === "unexpected custody family") {
        // The metadata family shape accepts unrelated source fields. An extra family
        // correlated to this admission must not disappear behind its canonical key.
        const additionalId = `unexpected-family-${randomUUID()}`;
        const extra = await f.observerPool.query(
          `INSERT INTO occ.prepared_github_families(source_id, source, issuer, admission)
           SELECT $2, source || jsonb_build_object('adoption','prepared',
             'key', jsonb_build_object('source', jsonb_build_object('id',$2::text)),
             'grant', source->'grant' || '{"profile":"metadata-read"}'::jsonb),
             '{"backendRef":{}}'::jsonb, admission || jsonb_build_object('familyId',$2::text)
           FROM occ.prepared_github_families WHERE source_id=$1`,
          ["repository-git:" + receipt.admissionId, additionalId],
        );
        assert.equal(extra.rowCount, 1);
      }
      if (outcome === "custody read recovers") {
        failCustodyRead = true;
        const deferred = await runCleanupPass();
        assert.equal(deferred.code, "REPOSITORY_CLEANUP_PENDING");
        assert.equal(failedCustodyReads, 1);
        assert.equal((await f.currentAgent(owner))?.activeRevisionId, candidate.id);
        assert.deepEqual(stops, []);
        assert.equal(runtimeObservations, 0);
        await prepared.maintain();
      }
      const cleanup = runCleanupPass();
      if (outcome === "model account final read recovers") {
        // Settled custody is insufficient when the locked authority read fails.
        // The lease must permit a safe retry without minting a credential or stopping the Agent.
        await waitFor(
          "the locked model read to fail after the custody observation",
          async () => (failedFinalModelReads === 1 ? true : undefined),
          4_000,
        );
        const work = await f.state.read((view) => view.operations.findWork(key));
        assert.equal(work?.state, "claimed");
        assert.equal((await f.currentAgent(owner))?.activeRevisionId, candidate.id);
        assert.deepEqual(stops, []);
      }
      const completion = await cleanup;
      assert.equal(
        await discoverNativeBearer(git.listeners.address.port, git.tls.ca, admit.files.bearer),
        401,
      );
      assert.equal(origin.traffic().requests, initial + 1);
      assert.equal(subject.github.issuesOfTokens.length, 1);
      if (issuedDraft) {
        assert.equal(await draft(), 401);
        assert.equal(
          provider.trace.filter(({ method, target }) => method === "POST" && target === draftPath)
            .length,
          1,
        );
      }
      if (
        outcome === "unexpected custody family" ||
        draftMustRetire ||
        modelBindingRevokedAfterCustody ||
        outcome === "model account final IAM fault with revoked binding"
      ) {
        assert.equal(completion.code, "REPOSITORY_RUNTIME_RETIREMENT_QUEUED");
        await waitFor(
          "terminal work to stop the exact original revision",
          async () =>
            (await f.currentAgent(owner))?.activeRevisionId === undefined ? true : undefined,
          10_000,
        );
        assert.deepEqual(stops, [candidate.id]);
        if (outcome === "model account final IAM fault with revoked binding") {
          assert.equal(failedFinalIamReads, 1);
        }
      } else {
        assert.equal(
          completion.code,
          outcome === "unconfirmed revocation"
            ? "REPOSITORY_CLEANUP_PENDING"
            : "REPOSITORY_ACCESS_WITHDRAWN",
        );
        assert.equal((await f.currentAgent(owner))?.activeRevisionId, candidate.id);
        assert.deepEqual(stops, []);
      }
      assert.equal(
        subject.github.trace.filter(
          ({ method, target }) => method === "DELETE" && target === "/installation/token",
        ).length,
        1,
        "cleanup observation cannot replay provider revocation",
      );
      if (outcome === "settled" || transientRuntime) {
        const gitAtWithdrawal = origin.traffic();
        const providerAtWithdrawal = provider.trace.length;
        for (const status of transientRuntime
          ? (["timeout", "unknown", "running"] as const)
          : (["running"] as const)) {
          runtimeStatus = status;
          const due = await f.advanceMaintenance(candidate);
          assert.equal(due.rowCount, 1);
          const observed = await waitFor(
            "ordinary maintenance to supervise the same revision without Git",
            async () => statuses.find(({ workId }) => workId === due.rows[0]?.idempotency_key),
            10_000,
          );
          assert.equal(observed.code, "REPOSITORY_ACCESS_WITHDRAWN");
          assert.equal((await f.currentAgent(owner))?.activeRevisionId, candidate.id);
          assert.deepEqual(stops, []);
        }
        if (transientRuntime) {
          assert.equal(
            await discoverNativeBearer(git.listeners.address.port, git.tls.ca, admit.files.bearer),
            401,
          );
          assert.equal(await draft(), 401);
          assert.deepEqual(origin.traffic(), gitAtWithdrawal);
          assert.equal(provider.trace.length, providerAtWithdrawal);
        }
      } else if (outcome === "unconfirmed revocation") {
        await prepared.maintain();
        assert.equal(
          subject.github.trace.filter(
            ({ method, target }) => method === "DELETE" && target === "/installation/token",
          ).length,
          1,
          "the owner did not replay a lost revocation acknowledgement",
        );
      }
      assert.equal(
        deliveries.length,
        1,
        "withdrawal does not prepare or deliver another credential",
      );
      assert.equal(preparations, preparationsBeforeRemoval);
      assert.equal(runtimeObservations, 0, "withdrawal never queries runtime availability");
    },
  );
}

async function withdrawRepositoryBinding(
  t: TestContext,
  {
    state,
    pool,
    agent,
    revision,
  }: Pick<Awaited<ReturnType<typeof fixture>>, "state" | "pool" | "agent" | "revision">,
) {
  const original = await state.read((unit) =>
    unit.operations.findWork(`agent_revision:${revision.id}:reconcile`),
  );
  assert.ok(original);
  const installation = await state.read((unit) => unit.installations.getInstallation());
  assert.ok(installation);
  const auth = await createTestAuthPrincipal({ installationId: installation.id });
  assert.notEqual(original.actorId, auth.seed.principal.id);
  const iam = new NativeIAMDriver({
    async loadNativeIAMState() {
      return {
        identities: [auth.seed.principal],
        groups: [],
        memberships: [],
        roles: [...auth.seed.roles],
        bindings: [...auth.seed.bindings],
        restrictions: [],
      };
    },
  });
  const controller = new OpenClawController(installation, { state });
  controller.registerDriver(iam);
  controller.selectDriver(iam.capability, iam.id);
  const app = createFastifyApp({
    controller,
    iamDriver: iam,
    auditSink: new InMemoryAuditSink(),
    resolveHarness: resolveApprovedHarness,
    durableRequestAuditSink: state.auditSink,
    auth: auth.auth,
    development: {
      enabled: true,
      installationId: installation.id,
      browserOrigin: "https://console.oce.localhost",
    },
  });
  t.after(() => app.close());
  const api: (method: "PATCH", path: string, payload: Record<string, unknown>) => Promise<unknown> =
    await createAuthenticatedControllerRequest(app, auth);
  const response: unknown = await api(
    "PATCH",
    "/namespaces/" + agent.namespaceId + "/agents/" + agent.id,
    {
      configurationId: agent.configurationId,
      repositoryBindings: [],
    },
  );
  const result = object(response);
  assert.equal(result.status, 200, JSON.stringify(result.error));
  assert.deepEqual(object(result.data).repositoryBindings ?? [], []);
  const { requestId } = object(result.meta);
  assert.equal(typeof requestId, "string");
  // Cleanup retains the original deployer, even when another principal removes Git.
  const workId = repositoryRemovalWorkKey(revision.id);
  const withdrawal = await state.read((unit) => unit.operations.findWork(workId));
  assert.ok(withdrawal);
  assert.equal(withdrawal.actorId, original.actorId);
  const replay: unknown = await api(
    "PATCH",
    "/namespaces/" + agent.namespaceId + "/agents/" + agent.id,
    {
      configurationId: agent.configurationId,
      repositoryBindings: [],
    },
  );
  const replayResult = object(replay);
  assert.equal(replayResult.status, 200, JSON.stringify(replayResult.error));
  // Only the request that queued withdrawal is linked to this job.
  const events = await pool.query<Record<string, unknown>>(
    `SELECT details->'__occAuditMetadata'->>'requestId' AS request_id, actor_id,
            resource_kind, resource_id, namespace_id, details->>'agentId' AS agent_id
     FROM occ.audit_events WHERE action = 'openclaw.controller_work.queued'
       AND details->>'workId' = $1`,
    [workId],
  );
  assert.deepEqual(events.rows, [
    {
      request_id: requestId,
      actor_id: original.actorId,
      resource_kind: "agent_revision",
      resource_id: revision.id,
      namespace_id: agent.namespaceId,
      agent_id: agent.id,
    },
  ]);
}

test(
  "prepared broker uses committed Git material for native clone, exact-ref push and independent fetch; withdrawal denies a fetch already admitted on the same TLS connection",
  {
    ...requiresPostgres,
    timeout: 75000,
  },
  async (t) => {
    const {
      broker: b,
      pool,
      admissionId,
      gh,
      owner,
      permissions,
      state,
      agent,
      revision,
    } = await fixture<Broker>(t, {
      openBroker: (input) => startBroker(t, input),
      recordDeploymentOperation: true,
    });
    assert.ok(b);
    const repo = "/" + b.repository + ".git/";
    const discovery = repo + "info/refs?service=git-upload-pack";
    const useCount = async () => {
      const { rows } = await pool.query<{ n: unknown }>(
        "SELECT count(*)::int AS n FROM occ.prepared_repository_git_uses WHERE admission_id=$1",
        [admissionId],
      );
      const [count] = rows;
      if (typeof count?.n !== "number") {
        throw new Error("Expected a PostgreSQL use count");
      }
      return count.n;
    };

    const refusedOnce = (
      response: BrokerResponse,
      reason: RefusalRecord["reason"],
      operation?: RefusalRecord["operation"],
    ) => refusedOnceBy(b, response, reason, operation);
    const logged: RefusalRecord[] = [];
    const keep = () => logged.push(...b.logs);

    // No prepared material yet: the owner cannot authorize the send, so nothing is sent.
    const cold = await b.http(discovery);
    assert.equal(cold.status, 503);
    keep();
    refusedOnce(cold, "not_dispatched", "git-discovery");
    assert.equal(gh.issuesOfTokens.length, 0);
    await prepare({ gh, owner, permissions });
    assert.equal((await b.http(discovery)).status, 200);
    const before = await useCount();
    const beforeOrigin = b.observed.length;
    const packet = (text: string) => (text.length + 4).toString(16).padStart(4, "0") + text;
    const line = (ref: string) => packet("0".repeat(40) + " " + "1".repeat(40) + " " + ref + "\n");
    // The server receives a mixed-ref update directly, independent of any client hooks.
    const mixed = await b.http(repo + "git-receive-pack", {
      method: "POST",
      headers: { "content-type": "application/x-git-receive-pack-request" },
      body: line(b.pushRef) + line("refs/heads/main") + "0000",
    });
    assert.equal(mixed.status, 400);
    keep();
    refusedOnce(mixed, "input_refused", "git-push");
    // Another repository, GitHub REST and GraphQL are outside the Git-only route, so the
    // session's Git credential is not accepted there; the record still names the session.
    for (const path of [
      discovery.replace(b.repository, "wrong/other"),
      "/repos/" + b.repository,
      "/graphql",
    ]) {
      const response = await b.http(path);
      keep();
      refusedOnce(response, "credential_refused");
    }
    // Finding 2429: a head refused before authentication (here a wrong Host that the
    // certificate still names) is logged when its credential names the open session; the
    // route is not known yet, so the record has no operation.
    const wrongHost = await b.http(discovery, { headers: { host: "localhost" } });
    assert.equal(wrongHost.status, 400);
    keep();
    refusedOnce(wrongHost, "request_refused");
    // With an API credential, the Git-only route refuses the REST request itself.
    const rest = await b.http("/repos/" + b.repository, {
      headers: { authorization: "Bearer " + b.opened.bearer },
    });
    keep();
    refusedOnce(rest, "request_refused");
    assert.equal(await useCount(), before);
    assert.equal(b.observed.length, beforeOrigin);

    // The owner commits a use, TLS completes, but no HTTP request crosses an expired send window.
    b.slow(true);
    const late = await b.http(discovery);
    assert.equal(late.status, 503);
    keep();
    refusedOnce(late, "not_dispatched", "git-discovery");
    b.slow(false);
    assert.equal(await useCount(), before + 1);
    assert.equal(b.observed.length, beforeOrigin);

    const negotiation = packet("command=ls-refs\n") + "00010000";
    // Unchanged identity input retains chunked framing at the Git origin.
    const beforeIdentity = b.origin.trace.length;
    const identity = await b.http(repo + "git-upload-pack", {
      method: "POST",
      headers: {
        "git-protocol": "version=2",
        "transfer-encoding": "chunked",
        "content-type": "application/x-git-upload-pack-request",
      },
      body: negotiation,
    });
    assert.equal(identity.status, 200);
    assert.equal(b.origin.trace.length, beforeIdentity + 1);
    const identityRequest = b.origin.trace[beforeIdentity];
    assert.ok(identityRequest);
    assert.equal(identityRequest.method, "POST");
    assert.equal(identityRequest.path, repo + "git-upload-pack");
    assert.equal(identityRequest.contentEncoding, undefined);
    assert.equal(identityRequest.contentLength, undefined);

    // The deadline is to start sending, not a five-second limit on completing a large fetch.
    const beforeGzip = b.origin.trace.length;
    const hold = b.origin.holdNextFetch({ beforeHeaders: true });
    const started = b.http(repo + "git-upload-pack", {
      method: "POST",
      headers: {
        "git-protocol": "version=2",
        "content-encoding": "gzip",
        "content-type": "application/x-git-upload-pack-request",
      },
      body: gzipSync(negotiation),
    });
    await hold.observed;
    await delay(5200);
    hold.release();
    assert.equal((await started).status, 200);
    assert.equal(b.origin.trace.length, beforeGzip + 1);
    const decodedRequest = b.origin.trace[beforeGzip];
    assert.ok(decodedRequest);
    assert.equal(decodedRequest.method, "POST");
    assert.equal(decodedRequest.path, repo + "git-upload-pack");
    assert.equal(decodedRequest.contentEncoding, undefined);
    assert.equal(decodedRequest.contentLength, String(Buffer.byteLength(negotiation)));

    const remote = b.opened.client.gitRemote.replace("https://127.0.0.1", b.address);
    const cwd = await temporaryDirectory(t, "warm-native-git-");
    const git = (args: string[], allowFailure = false) =>
      run("git", args, { cwd, env: b.env, allowFailure });
    await git(["clone", remote, "writer"]);
    await writeFile(join(cwd, "writer", "review.txt"), "Native Git wrote this review\n");
    const writer = (...args: string[]) => git(["-C", "writer", ...args]);
    await writer("add", "review.txt");
    const author = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test"];
    await writer(...author, "commit", "-m", "Propose review");
    const head = (await writer("rev-parse", "HEAD")).stdout.trim();
    await writer("push", "origin", "HEAD:" + b.pushRef);
    assert.equal(await b.origin.ref(b.pushRef), head);
    await git(["clone", remote, "reader"]);
    await git(["-C", "reader", "pull", "--ff-only", "origin", b.pushRef]);
    assert.equal((await git(["-C", "reader", "rev-parse", "HEAD"])).stdout.trim(), head);
    assert.equal(
      await readFile(join(cwd, "reader", "review.txt"), "utf8"),
      "Native Git wrote this review\n",
    );

    // Lose a successful local receive-pack response. Reconcile by reading, never by replay.
    await writer(...author, "commit", "--allow-empty", "-m", "Inconclusive push");
    const next = (await writer("rev-parse", "HEAD")).stdout.trim();
    b.origin.disconnectAfterNextAcceptedPush();
    const pushes = () => b.observed.filter(({ url }) => url?.endsWith("/git-receive-pack")).length;
    const count = pushes();
    const uncertain = await git(["-C", "writer", "push", "origin", "HEAD:" + b.pushRef], true);
    assert.notEqual(uncertain.code, 0);
    assert.equal(await b.origin.ref(b.pushRef), next);
    assert.equal(pushes(), count + 1);

    assert.equal((await b.http(discovery)).status, 200);
    // Successful Git requests and an uncertain push are not refusals.
    assert.deepEqual(b.logs, []);
    const sent = b.observed.length;
    const used = await useCount();
    // The production listener deliberately serves only one request per TLS connection.
    // A 100 Continue proves the broker already admitted this exact request/session.
    // Withdraw before finishing its body: the subsequent owner read must deny this fetch.
    let withdrawn = false;
    const revoked = await b.http(repo + "git-upload-pack", {
      method: "POST",
      headers: {
        expect: "100-continue",
        "git-protocol": "version=2",
        "content-type": "application/x-git-upload-pack-request",
      },
      body: packet("command=ls-refs\n") + "00010000",
      async beforeBody() {
        await withdrawRepositoryBinding(t, { state, pool, agent, revision });
        withdrawn = true;
      },
    });
    assert.equal(withdrawn, true);
    assert.equal(revoked.status, 503);
    keep();
    refusedOnce(revoked, "not_dispatched", "git-fetch");
    const after = await b.http(discovery);
    assert.equal(after.status, 503);
    keep();
    refusedOnce(after, "not_dispatched", "git-discovery");
    // Records name the session, never its bearer, the token, a ref or the repository.
    const text = JSON.stringify(logged);
    for (const secret of [b.opened.bearer, b.pushRef, b.repository]) {
      assert.ok(!text.includes(secret));
    }
    assert.equal(b.observed.length, sent);
    assert.equal(await useCount(), used);
    assert.equal(gh.issuesOfTokens.length, 1);
  },
);

for (const mode of [
  "Git only",
  "connection failed before any write",
  "created",
  "created in GitHub's spelling",
  "lost provider reply",
  "mismatched provider 201",
]) {
  test("prepared draft pull: " + mode, { ...requiresPostgres, timeout: 45000 }, async (t) => {
    const draftPull = mode !== "Git only";
    const settles = mode.startsWith("created");
    // The registry lowercases the repository; GitHub answers with its own spelling (finding 2236).
    const spelled = mode === "created in GitHub's spelling";
    const spell = (url: string) =>
      url.replace(/(?<=^https:\/\/github\.com\/)[^/]+\/[^/]+/, (name) => name.toUpperCase());
    const {
      broker: b,
      gh,
      owner,
      permissions,
      withdraw,
      admitReplacement,
    } = await fixture<Broker>(t, {
      draftPull,
      draftResponse:
        mode === "mismatched provider 201"
          ? (body) => ({ ...body, base: body.head })
          : spelled
            ? (body) => ({ ...body, html_url: spell(body.html_url) })
            : undefined,
      openBroker: (input) => startBroker(t, input),
    });
    assert.ok(b);
    const path = "/repos/" + b.repository + "/pulls";
    const head = b.pushRef.slice("refs/heads/".length);
    const base = "main";
    const title = "Scoped review";
    const body = settles ? "Check: tests passed" : "";
    const operationId = randomUUID();
    const packet = { title, head, base, body, draft: true };
    const headers = {
      "content-type": "application/json",
      authorization: "Bearer " + b.opened.bearer,
      "x-oce-operation-id": operationId,
    };
    const send = (input: Partial<BrokerRequest> = {}) =>
      b.http(path, { method: "POST", headers, body: JSON.stringify(packet), ...input });
    let invoke:
      | ((extra: string[], operation?: string, target?: string) => ReturnType<typeof run>)
      | undefined;
    const observed = () => gh.trace.filter((q) => q.method === "POST" && q.target === path);
    if (!draftPull) {
      await prepare({ gh, owner, permissions });
      assert.equal((await send()).status, 400);
      assert.equal(observed().length, 0);
      // An unauthenticated observer must report the real provider's refusal to its caller.
      await assert.rejects(readProviderPulls(gh.origin + path, { ca: gh.tls.ca }), {
        code: "ERR_ASSERTION",
        actual: 401,
        expected: 200,
      });
      return;
    }
    // A cold request cannot mint a token or leave a durable operation.
    assert.equal((await send()).status, 503);
    assert.equal(gh.issuesOfTokens.length, 0);
    await prepare({ gh, owner, permissions });
    for (const input of [
      { body: JSON.stringify({ ...packet, head: "main" }) },
      { body: JSON.stringify({ ...packet, base: "other" }) },
      { body: JSON.stringify({ ...packet, draft: false }) },
      { body: JSON.stringify(packet).replace('"head":', '"he\\u0061d":"wrong","head":') },
      { headers: { ...headers, "x-github-api-version": "2022-01-01" } },
      { method: "GET", body: undefined },
    ]) {
      assert.equal((await send(input)).status, 400);
    }
    assert.equal(observed().length, 0);
    assert.equal(gh.issuesOfTokens.length, 1);

    if (mode === "connection failed before any write") {
      // Finding 2429: the GitHub connection fails before TLS, so the broker settles the create
      // as not sent. The Agent gets a recorded 409 and the operator one not_dispatched line;
      // a same-operation replay returns that receipt and is logged the same way. Only the
      // attempt that connected names the failed provider connect (finding 3183), and the
      // receipt the Agent reads never carries it.
      b.logs.splice(0);
      gh.refuseNextConnection();
      const api = new URL(gh.origin);
      for (let i = 0; i < 2; i++) {
        const response = await send();
        assert.equal(response.status, 409);
        const value = jsonObject(response.text);
        assert.equal(value.operationId, operationId);
        assert.equal(value.error, "not-submitted");
        assert.equal(value.upstreamConnect, undefined);
        const connect =
          i === 0
            ? {
                host: api.hostname,
                addresses: [api.hostname],
                port: Number(api.port),
                error: "ECONNRESET",
              }
            : undefined;
        refusedOnceBy(b, response, "not_dispatched", "api", connect);
      }
      assert.equal(observed().length, 0);
      assert.equal(gh.pulls.size, 0);
      return;
    }

    if (settles) {
      // Exercise the shipping client and real computed manifest through an obligatory CONNECT.
      // The TLS broker listens on a random port unreachable at the client's selected port 443.
      const { root } = await createNativeClientMaterial(
        t,
        [{ opened: b.opened, repositoryRef: "source" }],
        { ca: gh.tls.ca },
      );
      const proxy = createHttpServer();
      const tunnels: (string | undefined)[] = [];
      proxy.on("connect", (req, socket, early) => {
        tunnels.push(req.url);
        const upstream = connect(Number(new URL(b.address).port), "127.0.0.1", () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        });
        // Bytes the client sent after CONNECT go first; the socket queues them until connected.
        upstream.write(early);
        relaySockets(socket, upstream);
      });
      const proxyAddress = (await listen(t, proxy)).replace(/^https:/, "http:");
      const client = fileURLToPath(
        new URL("../fixtures/repository-credentials/native-draft-child.ts", import.meta.url),
      );
      const args = (operation: string, target: string) => [
        "pr-create",
        "--operation-id",
        operation,
        "--draft",
        "--head",
        head,
        "--base",
        target,
        "--title",
        title,
      ];
      // The helper's own entry point, so its exit code and failure line are the Agent's view.
      invoke = (extra, operation = operationId, target = base) =>
        run(process.execPath, [client, root, ...args(operation, target), ...extra], {
          env: { ...cleanEnvironment(), HTTPS_PROXY: proxyAddress },
          allowFailure: true,
        });
      const bodyFile = join(await temporaryDirectory(t), "body.txt");
      await writeFile(bodyFile, "file contents must stay local");
      const refused = await invoke(["--body-file", bodyFile]);
      assert.notEqual(refused.code, 0);
      assert.match(refused.stderr, /Unknown option '--body-file'/);
      assert.deepEqual(tunnels, [], "file input must be refused before contacting the broker");
      const output = await invoke(["--body", body]);
      assert.equal(output.code, 0, output.stderr);
      assert.deepEqual(tunnels, ["127.0.0.1:443"]);
      const receipt = jsonObject(output.stdout);
      assert.equal(receipt.operationId, operationId);
      assert.equal(object(receipt.head).ref, head);
      assert.equal(object(receipt.base).ref, base);
      assert.equal(receipt.draft, true);
      assert.equal(typeof receipt.number, "number");
      const url = "https://github.com/" + b.repository + "/pull/" + receipt.number;
      assert.equal(receipt.url, spelled ? spell(url) : url);
      assert.equal(spelled, receipt.url !== url);
      assert.ok(
        !output.stdout.includes("must-not-escape"),
        "upstream nested credentials must never be returned",
      );
      // Finding 2410: a definite broker refusal names its code and says GitHub received
      // nothing; only an unknown outcome prints "Draft not confirmed".
      const refusal = (result: Awaited<ReturnType<typeof run>>) => {
        assert.equal(result.code, 1, result.stderr);
        assert.doesNotMatch(result.stderr, /Draft not confirmed/);
        return result.stderr.trim().split("\n").at(-1) ?? "";
      };
      assert.equal(
        refusal(await invoke(["--body", body], randomUUID(), "other")),
        "Draft not created: the repository broker refused it (unsupported-request); GitHub did not receive it. This repository binding does not allow this create; do not retry it. Ask an operator if the branch or base should change.",
      );
      assert.match(
        refusal(await invoke(["--body", body], randomUUID())),
        /^Draft not created: the grant's draft-create allowance was already used\. GitHub did not receive this request\./,
      );
      assert.equal(observed().length, 1, "neither refusal reached GitHub");
      const repeat = await send();
      assert.equal(repeat.status, 201);
      assert.deepEqual(
        jsonObject(repeat.text),
        receipt,
        "same operation returns the committed safe projection",
      );
    } else {
      // Provider creates the PR and drops its response. We can inspect that projection here;
      // the production broker must preserve uncertainty rather than claim that evidence or re-POST.
      if (mode === "lost provider reply") {
        gh.disconnectAfterMutation("POST", path);
      }
      b.logs.splice(0);
      for (let i = 0; i < 2; i++) {
        const response = await send();
        assert.equal(response.status, 409);
        const value = jsonObject(response.text);
        assert.equal(value.operationId, operationId);
        assert.equal(value.error, "outcome_unknown");
      }
      // GitHub may have created this draft, so the operator log records no refusal.
      assert.deepEqual(b.logs, []);
    }
    // Finding 2429: another operation or a changed request gets the spent allowance's receipt.
    // GitHub received nothing for it, so each is one operation_conflict line.
    b.logs.splice(0);
    const other = await send({ headers: { ...headers, "x-oce-operation-id": randomUUID() } });
    assert.equal(other.status, 409);
    assert.equal(jsonObject(other.text).error, "operation_conflict");
    refusedOnceBy(b, other, "operation_conflict", "api");
    const changed = await send({ body: JSON.stringify({ ...packet, title: "different" }) });
    assert.equal(jsonObject(changed.text).error, "operation_conflict");
    refusedOnceBy(b, changed, "operation_conflict", "api");
    // An independently authenticated observer reconciles by reading, never by trying another create.
    // Its observation cannot be presented as a delivered result to the Agent which lost the reply.
    const observer = randomUUID();
    gh.acceptStatic(observer);
    const query = new URLSearchParams({ base, head: b.repository.split("/")[0] + ":" + head });
    const visible = await readProviderPulls(gh.origin + path + "?" + query, {
      ca: gh.tls.ca,
      headers: { authorization: "Bearer " + observer },
    });
    assert.equal(visible.length, 1);
    const created = object(visible[0]);
    assert.equal(created.body, body);
    assert.equal(object(created.head).ref, head);
    assert.equal(object(created.base).ref, base);
    assert.equal(created.maintainer_can_modify, false);
    assert.equal(gh.pulls.size, 1);
    const [attempt] = observed();
    assert.ok(attempt);
    if (mode !== "lost provider reply") {
      assert.equal(attempt.usedBearer, true);
      assert.equal(attempt.forwardedOperationId, false);
    }
    assert.equal(attempt.apiVersion, "2026-03-10");
    assert.equal(attempt.tokenIndex, 1);
    assert.equal(
      observed().length,
      1,
      "exactly one provider create attempt, including ambiguous response",
    );
    await withdraw();
    assert.equal((await send()).status, 503, "cannot replay even a receipt after withdrawal");
    if (invoke) {
      const withdrawn = await invoke(["--body", body], randomUUID());
      assert.equal(withdrawn.code, 1, withdrawn.stderr);
      assert.equal(
        withdrawn.stderr.trim().split("\n").at(-1),
        "Draft not created: the repository broker refused it (unavailable); GitHub did not receive it. Retry once; if it is refused again, ask an operator to check the repository-credentials container log in the worker Pod.",
      );
    }
    assert.equal(observed().length, 1);
    // A legitimate replacement with the identical grant and old client operation cannot obtain
    // the prior admission's receipt, a second permit, or a fresh token by trying this endpoint.
    const replacement = b.openSession();
    await admitReplacement(replacement.session.sessionId);
    const next = await send({
      headers: { ...headers, authorization: "Bearer " + replacement.bearer },
    });
    assert.equal(next.status, 409);
    assert.deepEqual(jsonObject(next.text), { error: "operation_conflict" });
    assert.equal(observed().length, 1);
    assert.equal(gh.issuesOfTokens.length, 1, "no request-time mint or permission escalation");
  });
}
