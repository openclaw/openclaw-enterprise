import assert from "node:assert/strict";
import { constants } from "node:fs";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { createServer, get, request, type ServerOptions } from "node:https";
import { json } from "node:stream/consumers";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentRevision,
  ComputeRevisionContext,
  ComputeDriver,
  RepositoryGitDeliveryProfile,
  RepositoryGitSendPermit,
} from "../../packages/contracts/src/index.ts";
import {
  loadInstallationConfiguration,
  readPublicCaBundle,
} from "../../apps/controller/src/composition/installation-config.ts";
import { startPreparedGitHubGitOwner } from "../../apps/controller/src/backends/repository-credentials/prepared-git-owner.ts";
import {
  bindRepositoryGitTransport,
  repositoryGitAuthority,
} from "../../apps/controller/src/composition/repository-credentials/transport.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { signComputeExecutionRelease } from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import { ProtectedExecutionDriver } from "../../apps/controller/src/drivers/compute/protected-execution-driver.ts";
import {
  cleanEnvironment,
  createTlsMaterial,
  listen,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";
import { createBackendController } from "../helpers/postgres-backend-state.mjs";
import { protectedDriverPackage } from "../helpers/protected-driver-package.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import { standingExecutionPlatform } from "../helpers/postgres-standing-execution.ts";
import { standingGitOrigin } from "../helpers/prepared-standing-git-peer.ts";
import { waitFor } from "../helpers/wait-for.mjs";
import {
  expireStoppedClaims,
  waitForRevisionPass,
} from "../helpers/postgres-worker-revision-support.mjs";
import { installationOrigin } from "../fixtures/driver-packages/protected-execution-driver/installation-origin.ts";

import { standingGitConversation } from "../helpers/standing-git-conversation.ts";
import { gitExpiryGateway } from "../helpers/openshell-online-git-journey.mjs";
import { openShellProviderName } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  pluginRuntimeEnvironment,
  pluginRuntimeSpecForRevision,
} from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import { COMPUTE_RELEASE_PUBLIC_KEY } from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";

const conversationRequired = process.env.OCC_TEST_REQUIRE_EXTERNAL_GIT_CONVERSATION === "1";
const codex = process.env.OCC_TEST_STANDING_GIT_CODEX;
if (conversationRequired) {
  assert.ok(
    databaseUrl,
    "external conversation qualification requires an owned PostgreSQL database",
  );
  assert.ok(codex, "external conversation qualification requires the shipped Codex executable");
  await access(codex, constants.X_OK);
}

// Production package selection, OCC deployment, worker and custody. The external package,
// its workload, Kubernetes placement, GitHub and the private Git origin are controlled locally.
const journeyOptions = { ...requiresPostgres, timeout: 240_000 };
test(
  "an installed external Driver fetches private Git across rotation and receives the next fetch after withdrawal",
  journeyOptions,
  externalGitJourney("repository"),
);
test(
  "an installed external Driver uses an explicit GitHub installation for private Git fetch, push, REST and GraphQL until withdrawal",
  journeyOptions,
  externalGitJourney("installation"),
);

test(
  "an online sender uses the admitted GitHub installation for real Git and API requests until withdrawal",
  journeyOptions,
  externalGitJourney("online-installation"),
);

test(
  "a capable external Driver reduces Git on the original running execution through cleanup and worker replacement",
  journeyOptions,
  externalGitJourney("reducible-installation"),
);

test(
  "a capable registered Driver observes only the original lost rotation across worker replacement and withdrawal",
  journeyOptions,
  externalGitJourney("lost-rotation"),
);

function repositoryConfiguration(input: {
  backendId: string;
  registryPath: string;
  privateKeyPath: string;
  custodyKeyPath: string;
  id: string;
  sandbox: Record<string, unknown>;
  issuerCaPath: string;
  apiOrigin: string;
}) {
  const base = createInstallationDriverConfiguration();
  return {
    ...base,
    presets: { includeDefaults: false },
    backend: [
      {
        id: input.backendId,
        type: "github",
        configuration: { registryPath: input.registryPath },
        drivers: { repo: input.backendId },
      },
    ],
    repository: {
      id: input.backendId,
      configuration: { sessionDurationSeconds: 180 },
      preparedGitHub: {
        privateKeyPath: input.privateKeyPath,
        custodyKeyPath: input.custodyKeyPath,
        issuerCaPath: input.issuerCaPath,
        apiOrigin: input.apiOrigin,
      },
    },
    drivers: {
      ...base.drivers,
      sandbox: { id: input.id, package: input.id, configuration: input.sandbox },
      credential_proxy: { id: input.id, configuration: {} },
    },
  };
}

test("production composition separates repository policy from protected and explicitly selected native senders", async (t) => {
  const namespaceId = "composition-policy";
  const origin = await standingGitOrigin(t, namespaceId, 300_000);
  const id = "cedar-composition-fixture";
  const { directory } = await protectedDriverPackage(t, id, "repository-git");
  const registryPath = join(directory, "registry.json");
  const registry = {
    ...origin.registry,
    repositories: origin.registry.repositories.map((repository) => ({
      ...repository,
      namespaces: repository.namespaces.map((policy) => ({
        ...policy,
        transport: "git-and-draft-pr",
        pullRequestBase: "main",
        draftPullLimit: "one-per-grant",
      })),
    })),
  };
  await writeFile(registryPath, JSON.stringify(registry));
  const path = join(directory, "installation.json");
  const configuration = repositoryConfiguration({
    ...origin,
    id,
    registryPath,
    issuerCaPath: origin.tls.certFile,
    apiOrigin: origin.gh.origin,
    sandbox: {
      origin: origin.origin.origin,
      peerOrigin: "https://127.0.0.1:1",
      capabilityOrigin: "https://127.0.0.1:2",
      certFile: origin.tls.certFile,
      releaseKey: "unused-before-release",
    },
  });
  const load = async (value: unknown) => {
    await writeFile(path, JSON.stringify(value));
    return (await loadInstallationConfiguration({
      mode: "production",
      packageRoot: directory,
      environment: { OCC_CONFIG_PATH: path },
    }))!;
  };
  const protectedGit = await load(configuration);
  const policy = protectedGit.repositoryPolicy!;
  assert.equal((await policy.listOptions({ namespaceId })).options.length, 1);
  const binding = policy.resolve({
    namespaceId,
    bindings: [{ repositoryRef: "source", profile: "git-write" }],
  }).bindings[0]!;
  const scope = policy.standingApprovalScope!({ namespaceId, binding })!;
  assert.deepEqual(scope.pushRefAllowlist, ["refs/heads/review"]);
  assert.equal(scope.pullRequestBase, "main");
  assert.equal(scope.draftPullLimit, "one-per-grant");
  await assert.rejects(
    load({
      ...configuration,
      repository: {
        ...configuration.repository,
        configuration: { sessionDurationSeconds: 180, controlSocket: "/unselected/control.sock" },
      },
    }),
    {
      name: "ConfigurationValidationError",
      error: {
        details: [
          {
            path: "",
            code: "UNKNOWN_FIELD",
            message: "Configuration does not satisfy additionalProperties.",
          },
        ],
      },
    },
  );
  await assert.rejects(
    load({
      ...configuration,
      repository: {
        ...configuration.repository,
        nativeSender: {
          controlSocket: "/unselected/control.sock",
          publicCaPath: origin.tls.certFile,
        },
      },
    }),
    /cannot fall back/,
  );
  const { sandbox: _sandbox, credential_proxy: _proxy, ...nativeDrivers } = configuration.drivers;
  await assert.rejects(
    load({ ...configuration, drivers: nativeDrivers }),
    /explicitly selected protected/,
  );
  const native = await load({
    ...configuration,
    repository: {
      ...configuration.repository,
      nativeSender: {
        controlSocket: "/unselected/control.sock",
        publicCaPath: origin.tls.certFile,
      },
    },
    drivers: {
      ...nativeDrivers,
      compute: {
        ...nativeDrivers.compute,
        configuration: {
          ...nativeDrivers.compute.configuration,
          network: {
            ...nativeDrivers.compute.configuration.network,
            repositoryCredentials: {
              namespace: "occ-system",
              podLabels: { app: "repository" },
              port: 8443,
            },
          },
        },
      },
    },
  });
  assert.ok(native.nativeRepositorySender);
  assert.equal(native.repositoryGitDriver, undefined);
  assert.equal(Object.hasOwn(native.installation.drivers, "repo"), false);
  assert.deepEqual(
    native.repositoryPolicy!.resolve({
      namespaceId,
      bindings: [{ repositoryRef: "source", profile: "git-write" }],
    }).bindings,
    [binding],
  );
  assert.deepEqual(
    native.repositoryPolicy!.standingApprovalScope!({ namespaceId, binding }),
    scope,
  );
  // Installation-wide authority is never available through a native session, even with a prepared provider.
  await assert.rejects(
    native.nativeRepositorySender.open(
      {
        namespaceId,
        admissionId: "composition-only",
        binding: { ...binding, profile: "github-installation" },
        durationSeconds: 180,
        deadlineWallMs: Date.now() + 180_000,
      },
      t.signal,
    ),
    /requires the protected Credential Proxy/,
  );
});

// Public discovery has its own listener. It receives no sender, installation or protected authority.
function createCapabilityPeer(
  tls: ServerOptions,
  profile: RepositoryGitDeliveryProfile,
  online: boolean,
  reducible = false,
) {
  const capability = { profile, online, requests: 0 };
  const server = createServer(tls, (req, res) => {
    if (req.method === "GET" && req.url === "/reduction-capability" && reducible) {
      res.writeHead(200).end(JSON.stringify({ version: 2, repositoryGit: true, denyAll: true }));
      return;
    }
    if (req.method !== "GET" || req.url !== "/capability") {
      res.writeHead(404).end();
      return;
    }
    capability.requests++;
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify(
          capability.online
            ? { profile: capability.profile, authorization: "online-request" }
            : capability.profile,
        ),
      );
  });
  return { capability, server };
}

function externalGitJourney(
  scope:
    | "repository"
    | "installation"
    | "online-installation"
    | "reducible-installation"
    | "lost-rotation",
) {
  return async (t: TestContext) => {
    let prepared: Awaited<ReturnType<typeof startPreparedGitHubGitOwner>> | undefined;
    let transport: Awaited<ReturnType<typeof bindRepositoryGitTransport>>;
    let releaseReduction: (() => void) | undefined;
    const workerOutcomes: object[] = [];
    let preparationStage = "not-started";
    let firstFailure: object | undefined;
    let failed = false;
    const recordFailure = (stage: string, error: unknown) => {
      if (firstFailure) {
        return;
      }
      failed = true;
      const failure = error instanceof Error ? (error as Error & { code?: string }) : undefined;
      const frame = failure?.stack
        ?.split("\n")
        .slice(1)
        .map((line) =>
          line.match(
            /^\s*at ([\w.<> ]+) \((?:file:\/\/)?[^)]*\/((?:apps|tests|packages)\/[\w./-]+):(\d+):(\d+)\)$/,
          ),
        )
        .find((match) => match !== null);
      firstFailure = {
        stage,
        name: ["Error", "AssertionError", "TypeError"].includes(failure?.name ?? "")
          ? failure?.name
          : "unclassified",
        code: ["ERR_ASSERTION", "DEPENDENCY_UNAVAILABLE"].includes(failure?.code ?? "")
          ? failure?.code
          : "unclassified",
        frame: frame && { function: frame[1], path: frame[2], line: Number(frame[3]) },
      };
    };
    let deliveryDiagnostic = () => ({});
    const emit = (event: Readonly<Record<string, unknown>>) => {
      if (typeof event.event !== "string") {
        return;
      }
      const code = typeof event.code === "string" ? event.code : undefined;
      const outcome = typeof event.outcome === "string" ? event.outcome : undefined;
      if (code || outcome || event.event === "worker.repository-delivery-pending") {
        workerOutcomes.push({
          event: event.event,
          code,
          outcome,
          step: typeof event.step === "string" ? event.step : undefined,
        });
        if (workerOutcomes.length > 12) {
          workerOutcomes.shift();
        }
      }
    };
    let stopWorker = async () => {};
    t.after(async () => {
      if (failed) {
        t.diagnostic(
          JSON.stringify({
            stage: preparationStage,
            firstFailure,
            delivery: deliveryDiagnostic(),
            scope,
            outcomes: workerOutcomes,
          }),
        );
      }
      // Release test-owned holds before joining workers; close authority before its pool.
      releaseReduction?.();
      try {
        await stopWorker();
      } finally {
        try {
          await transport?.close();
        } finally {
          await prepared?.close();
        }
      }
    });
    const f = await standingExecutionPlatform(t, import.meta.url);
    stopWorker = () => f.stop();
    // OpenShell operator Workspaces use the persisted Namespace's DNS label (at most 19 chars).
    const createdNamespace = await f.controller.createNamespace(f.actor.id, {
      name: "git-" + randomUUID().slice(0, 12),
    });
    await f.controller.handleNamespaceLifecycle(f.actor.id, createdNamespace.id, "ready");
    const namespace = { ...createdNamespace, status: "ready" as const };
    const { id: namespaceId } = namespace;
    const online = scope === "online-installation";
    const lostRotation = scope === "lost-rotation";
    const reducible = scope === "reducible-installation" || lostRotation;
    const broad =
      !lostRotation && scope !== "repository"
        ? await installationOrigin(t, namespaceId)
        : undefined;
    const { registry, backendId, origin, gh, tls, privateKeyPath, custodyKeyPath } =
      broad ?? (await standingGitOrigin(t, namespaceId, 300_000));
    const installationApiOrigin = broad?.gh.origin;
    const conversation =
      scope === "reducible-installation" && codex
        ? await standingGitConversation(t, codex)
        : undefined;
    let askModel: Awaited<ReturnType<NonNullable<typeof conversation>["launch"]>> | undefined;
    let modelEnvironment: Record<string, string> | undefined;
    let modelCustody: ComputeRevisionContext | undefined;
    let modelClient: Awaited<ReturnType<typeof gitExpiryGateway>>["client"];
    const modelSourceId = "cs_" + randomUUID();
    const modelGatewayConfiguration = { binaries: [codex!] };
    const modelGateway = conversation
      ? new OpenShellCredentialGatewayDriver(modelGatewayConfiguration, {
          id: "external-journey-model",
          backend: {
            id: "external-journey-model",
            drivers: { credential_gateway: "external-journey-model" },
            client: { placement: () => undefined, clientForNamespace: () => modelClient },
          } as never,
        })
      : undefined;
    if (modelGateway && conversation) {
      // A ready gateway-held model source is the same state ordinary registration commits.
      // The existing stock-wire fixture supplies its independent model attachment below.
      await f.state.transact(async (unit) => {
        await unit.credentialSources.createCredentialSource({
          id: modelSourceId,
          namespaceId,
          name: "external-journey-model",
          type: "openai",
          config: { base_url: conversation.baseUrl },
          secrets: {},
          ownerCapability: "credential_gateway",
          driverId: modelGateway.id,
          state: "registering",
          createdAt: new Date().toISOString(),
        });
        await unit.credentialSources.markCredentialSourceReady(namespaceId, modelSourceId);
      });
    }
    const id = "cedar-git-fixture";
    const { directory, entry } = await protectedDriverPackage(t, id, "repository-git");
    const cedar = (await import(
      join(entry, "repository-git.mjs")
    )) as typeof import("../fixtures/driver-packages/protected-execution-driver/repository-git.ts");
    const registryPath = join(directory, "registry.json");
    await writeFile(registryPath, JSON.stringify(registry));
    const path = join(directory, "installation.json");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { certFile } = tls;
    const peerOrigin = await listen(t, cedar.createCounterpart(tls));
    const { capability, server } = createCapabilityPeer(
      tls,
      broad ? "github_installation" : "repository_git",
      online,
      reducible,
    );
    const capabilityOrigin = await listen(t, server);
    const releaseKey = publicKey.export({ format: "pem", type: "spki" }).toString();
    const controlSecretFile = join(directory, "driver-control-auth");
    await writeFile(controlSecretFile, randomUUID(), { mode: 0o600 });
    await writeFile(
      path,
      JSON.stringify(
        repositoryConfiguration({
          backendId,
          registryPath,
          privateKeyPath,
          custodyKeyPath,
          id,
          sandbox: {
            origin: origin.origin,
            peerOrigin,
            capabilityOrigin,
            certFile,
            releaseKey,
            installationApiOrigin,
            policyReduction: reducible,
            controlSecretFile,
          },
          issuerCaPath: certFile,
          apiOrigin: gh.origin,
        }),
      ),
    );
    // Production loads this package independently in the API and worker processes. Use separate
    // installed copies here, with the same durable identity and discovery origin; only the worker binds protected authority.
    const load = (packageRoot: string) =>
      loadInstallationConfiguration({
        mode: "production",
        packageRoot,
        environment: { OCC_CONFIG_PATH: path },
      });
    const apiPackage = await protectedDriverPackage(t, id, "repository-git");
    const apiDrivers = (await load(apiPackage.directory))!;
    const loadedDrivers = (await load(directory))!;
    const drivers = modelGateway
      ? {
          ...loadedDrivers,
          credentialGatewayDriver: modelGateway,
          installation: {
            ...loadedDrivers.installation,
            drivers: {
              ...loadedDrivers.installation.drivers,
              credential_gateway: {
                id: modelGateway.id,
                implementation: modelGateway.implementation,
                configuration: modelGatewayConfiguration,
                definition: OpenShellCredentialGatewayDriver,
              },
            },
          },
        }
      : loadedDrivers;
    const { repositoryOwner, repositoryRegistry, repositoryGitDriver: owner } = drivers;
    assert.ok(owner && repositoryOwner && repositoryRegistry && drivers.preparedRepositoryGit);
    assert.equal(repositoryOwner.controlSocket, undefined);
    assert.equal(Object.hasOwn(drivers.installation.drivers, "repo"), false);
    assert.equal(drivers.nativeRepositorySender, undefined);
    assert.equal("open" in drivers.repositoryPolicy!, false);
    assert.equal(drivers.repositoryTransport, undefined);
    const apiOwner = apiDrivers.repositoryGitDriver!;
    assert.notEqual(apiOwner, owner);
    assert.deepEqual(apiOwner.ref, owner.ref);
    const kube = modelGateway
      ? new KubernetesComputeDriver(
          apiDrivers.installation.drivers.compute.configuration as unknown as ConstructorParameters<
            typeof KubernetesComputeDriver
          >[0],
          {
            id: apiDrivers.computeDriver.id,
            implementation: apiDrivers.computeDriver.implementation,
            protectedDriver: apiOwner,
            credentialGatewayDriver: modelGateway,
          },
        )
      : (apiDrivers.computeDriver as KubernetesComputeDriver);
    const release = new ProtectedExecutionDriver(owner);
    // Use production authority and sender composition, including their background maintenance.
    // The short-lived local issuer makes rotation observable without changing stored deadlines.
    const { issuerCaPath, ...preparedConfig } = drivers.preparedRepositoryGit;
    const issuerCa = Buffer.from(await readPublicCaBundle(issuerCaPath!));
    const startOwner = () =>
      startPreparedGitHubGitOwner({
        ...repositoryOwner,
        ...preparedConfig,
        ca: issuerCa,
        pool: f.observerPool,
        registry: repositoryRegistry,
        ...repositoryGitAuthority(drivers),
        report: (code) => emit({ event: "worker.repository-owner", code }),
      });
    prepared = await startOwner();
    transport = await bindRepositoryGitTransport(drivers, prepared, f.observerPool, emit);
    assert.ok(transport);
    const { peer } = cedar;
    deliveryDiagnostic = () => ({
      stage: peer.delivery.stage,
      metadataRefusal: peer.delivery.metadataRefusal,
      attempts: peer.delivery.attempts,
      installs: peer.delivery.installs,
    });

    // The worker opens a real standing session. Workload placement is controlled locally;
    // the optional conversation mode runs shipped Codex with the same admitted model source.
    let preparations = 0;
    let withdrawalStarted = false;
    let preparationsBeforeWithdrawal: number;
    let checkedNegativeCapability = false;
    let stopAttempts = 0;
    t.after(() => {
      if (reducible) {
        assert.equal(stopAttempts, 0, "the running Agent must never be stopped");
      }
    });
    const compute: ComputeDriver = {
      ...f.compute,
      capability: "compute",
      async stopRevision(stopped) {
        // The cases share one database, so this worker can also claim an earlier case's due
        // retirement. Count only this case's Agent.
        if (withdrawalStarted && stopped.namespaceId === namespaceId) {
          stopAttempts++;
          assert.equal(reducible, false, "Git binding withdrawal must never stop the execution");
        }
      },
      id: kube.id,
      implementation: kube.implementation,
      // This Compute adapter places the execution at the local peer under the persisted
      // Namespace name used by prepareRevision, including independent proxy verification.
      async resolveSandboxNamespace(namespace) {
        return namespace;
      },
      validateHarnessAuth: kube.validateHarnessAuth!.bind(kube),
      validateExecutionAdmission: kube.validateExecutionAdmission!.bind(kube),
      validateRepositoryCredentials: kube.validateRepositoryCredentials!.bind(kube),
      async prepareRevision(revision: AgentRevision, custody: ComputeRevisionContext) {
        preparationStage = "prepare-entered";
        preparations++;
        assert.equal(withdrawalStarted, false, "must not prepare after withdrawal");
        const { egressPlan: plan } = revision;
        assert.ok(plan?.repositoryGit && custody.currentEgressInstallation);
        const context = { plan, revision, namespace, signal: t.signal };
        if (conversation && modelGateway) {
          preparationStage = "attach-model-source";
          assert.equal(custody.harnessAuth?.method, "credential_source");
          const auth = custody.harnessAuth;
          assert.ok(auth && auth.method === "credential_source");
          await modelGateway.attachForRevision({
            revision,
            namespace,
            sources: [auth.source],
            signal: t.signal,
          });
          preparationStage = "model-runtime-configuration";
          const login = kube["harnessAuthForRevision"](revision, custody, {
            name: kubernetesNamespaceName(namespaceId),
            plane: "execution",
          });
          assert.equal(login.credentialSource?.config.base_url, conversation.baseUrl);
          const manifest = pluginRuntimeSpecForRevision(revision, undefined, conversation.baseUrl)!;
          modelEnvironment = {
            ...Object.fromEntries(
              login.environment.map(({ name, value }: { name: string; value?: string }) => [
                name,
                value!,
              ]),
            ),
            ...pluginRuntimeEnvironment(manifest),
            OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID: revision.id,
            [COMPUTE_RELEASE_PUBLIC_KEY]: publicKey
              .export({ type: "spki", format: "der" })
              .toString("base64url"),
          };
          modelCustody = custody;
        }
        if (broad && !checkedNegativeCapability) {
          const issuesBefore = gh.issuesOfTokens.length;
          const previousProfile = capability.profile;
          const previousOnline = capability.online;
          try {
            capability.profile = "repository_git";
            await assert.rejects(
              release.configure(context),
              /no longer supports GitHub installation access/,
            );
            assert.equal(
              gh.issuesOfTokens.length,
              issuesBefore,
              "a repository-only sender cannot prepare a broad token",
            );
            capability.profile = previousProfile;
            if (online) {
              capability.online = false;
              await assert.rejects(release.configure(context), /admitted sender guarantee/);
              assert.equal(
                gh.issuesOfTokens.length,
                issuesBefore,
                "cannot downgrade v5 before issuance",
              );
            }
            checkedNegativeCapability = true;
          } finally {
            capability.profile = previousProfile;
            capability.online = previousOnline;
          }
        }
        preparationStage = "configure-protected-execution";
        const wiring = await release.configure(context);
        preparationStage = "enroll-protected-execution";
        assert.equal(
          await release.enroll(
            context,
            wiring,
            custody,
            async () => true,
            async () => ({
              ...context,
              kubernetes: undefined,
              transportToken: "fixture",
              requirements: {
                loginMode: "runtime",
                image: "fixture",
                command: [],
                workspaceMounts: [],
                files: [],
                environment: [],
                labels: {},
                credentialAttachments: [],
                proxyWiring: wiring,
              },
            }),
            (startup, current) => signComputeExecutionRelease(privateKey, startup, current),
          ),
          true,
        );
        preparationStage = "compute-readiness";
        return f.compute.prepareRevision(revision);
      },
      async withdrawCredentialSource(revision, source, signal, options) {
        assert.ok(options?.reducePolicy && revision.egressPlan);
        const result = await options.reducePolicy({
          namespace,
          revision,
          plan: revision.egressPlan,
          signal,
        });
        assert.notEqual(result, "retire-runtime");
        return { sourceId: source.id, state: result === "withdrawn" ? "revoked" : "pending" };
      },
      verifyRepositoryExecution: (revision: AgentRevision, signal: AbortSignal) =>
        release.sandbox.repositoryAccess!.verifyExecution({
          revision,
          signal,
          namespace,
          kubernetes: undefined,
        }),
    };
    const prepareRevision = compute.prepareRevision.bind(compute);
    compute.prepareRevision = async (...args) => {
      try {
        return await prepareRevision(...args);
      } catch (error) {
        recordFailure(preparationStage, error);
        throw error;
      }
    };
    const verifyRepositoryExecution = compute.verifyRepositoryExecution!.bind(compute);
    compute.verifyRepositoryExecution = async (...args) => {
      try {
        return await verifyRepositoryExecution(...args);
      } catch (error) {
        recordFailure("verify-repository-execution", error);
        throw error;
      }
    };
    const { actor, observerPool: pool } = f;
    const backends = apiDrivers.installation.backend;
    const controller = createBackendController(f, { backends });
    const { id: who } = actor;
    if (modelGateway) {
      controller.registerDriver(modelGateway);
      controller.selectDriver("credential_gateway", modelGateway.id);
    }
    controller.installDriver(apiOwner, ["sandbox", "credential_proxy"]);
    for (const d of [apiDrivers.repositoryPolicy!, compute]) {
      controller.registerDriver(d);
      controller.selectDriver(d.capability, d.id);
    }
    const repositoryRef = broad?.installation.repositoryRef ?? "source";
    const approvalId = randomUUID();
    const { id: configurationId } = await controller.createConfiguration(who, {
      namespaceId,
      kind: "agent",
      values: createHarnessConfiguration("codex", conversation ? "fixture-model" : "fixture"),
    });
    const { id: agentId, servicePrincipalId } = await controller.createAgent(
      who,
      {
        namespaceId,
        configurationId,
        name: "External Git",
        executionMode: "dedicated",
        harnessAuth: conversation
          ? { method: "credential_source", sourceId: modelSourceId }
          : { method: "runtime" },
        ...(conversation && { credentialSources: [{ sourceId: modelSourceId }] }),
        repositoryBindings: [
          {
            repositoryRef,
            profile: broad ? "github-installation" : "git-write",
          },
        ],
      },
      resolveApprovedHarness,
    );
    if (conversation) {
      // Model authority is independent of the external proxy's metadata route.
      const role = await controller.createIAMRole(who, {
        namespaceId,
        name: "model-source-use",
        permissions: [{ action: "operate", resourceKind: "credential_source" }],
      });
      await controller.createIAMAccessBinding(who, {
        namespaceId,
        subjectKind: "identity",
        subjectId: servicePrincipalId,
        roleId: role.id,
        resourceKind: "credential_source",
        resourceId: modelSourceId,
      });
    }
    let independentSourceId: string | undefined;
    let independentRequests = 0;
    if (reducible) {
      const independentOrigin = await listen(
        t,
        createServer(tls, (req, res) => {
          assert.equal(req.method, "GET");
          assert.equal(req.url, "/repos/fixture/independent");
          assert.equal(
            req.headers.authorization,
            undefined,
            "independent binding carries no Git token",
          );
          independentRequests++;
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ id: 99, full_name: "fixture/independent" }));
        }),
      );
      const source = await controller.createCredentialSource(who, {
        namespaceId,
        name: "independent-metadata",
        type: "credential-free-repository-metadata",
        config: {
          origin: independentOrigin,
          repository_id: "99",
          repository: "fixture/independent",
          agent_id: agentId,
          authority: "execution",
        },
        secrets: {},
      });
      independentSourceId = source.id;
      const role = await controller.createIAMRole(who, {
        namespaceId,
        name: "independent-metadata-use",
        permissions: [{ action: "operate", resourceKind: "credential_source" }],
      });
      await controller.createIAMAccessBinding(who, {
        namespaceId,
        subjectKind: "identity",
        subjectId: servicePrincipalId,
        roleId: role.id,
        resourceKind: "credential_source",
        resourceId: source.id,
      });
      await controller.updateAgent(
        who,
        {
          namespaceId,
          agentId,
          configurationId,
          credentialSources: [
            ...(conversation ? [{ sourceId: modelSourceId }] : []),
            { sourceId: source.id },
          ],
        },
        resolveApprovedHarness,
      );
      const exchange = await owner.require("credential_proxy").bindExchange!((exchangeOwner) =>
        controller.createCredentialProxy(exchangeOwner),
      );
      t.after(() => exchange.close());
    }
    const independentRead = async (expected: number) => {
      const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
        get(
          new URL("/repos/fixture/independent", peer.url),
          {
            ca: awaitCa,
            headers: { authorization: peer.clientHeader.slice("Authorization: ".length) },
            agent: false,
          },
          resolve,
        ).once("error", reject);
      });
      assert.equal(response.statusCode, expected);
      if (expected === 200) {
        assert.deepEqual(await json(response), { id: 99, full_name: "fixture/independent" });
      } else {
        response.resume();
      }
    };
    const awaitCa = await readFile(certFile);
    const key = { namespaceId, agentId, configurationId };
    const [review] = await controller.listAgentStandingApprovalScopes(
      who,
      namespaceId,
      key.agentId,
    );
    await controller.updateAgent(
      who,
      {
        ...key,
        repositoryStandingApproval: {
          repositoryRef,
          approvalId,
          approved: true,
          duration: "until-removed",
          expectedScopeFingerprint: review!.scopeFingerprint,
        },
      },
      resolveApprovedHarness,
    );
    const deploy = () => controller.deployAgent(who, key, resolveApprovedHarness);
    if (broad) {
      capability.profile = "repository_git";
      await assert.rejects(deploy, /did not confirm installation-wide repository access/);
      assert.equal(gh.issuesOfTokens.length, 0);
      capability.profile = "github_installation";
    }
    const probes = capability.requests;
    const revision = await deploy();
    assert.ok(capability.requests > probes, "API admission reached the capability-only HTTPS peer");
    assert.deepEqual(revision.executionAdmission, {
      version: reducible ? 7 : online ? 5 : 4,
      mode: "protected",
    });
    assert.deepEqual(revision.egressPlan?.driver, owner.ref);
    assert.equal(revision.repositoryCredentials?.standingApprovalId, approvalId);
    assert.equal(revision.harnessAuth.method, conversation ? "credential_source" : "runtime");
    if (conversation) {
      const model = openShellProviderName(modelSourceId);
      ({ client: modelClient } = await gitExpiryGateway(t, {
        model,
        workspace: namespace.name,
        sandbox: "external-model",
        deadline: Date.now() + 240_000,
        platformProfile: false,
        modelSourceId,
        revisionId: revision.id,
      }));
    }
    const ref = { ...key, revisionId: revision.id };
    t.diagnostic("journey revision " + revision.id);
    // Queue cadences are not under test here: waits on a worker pass make this revision's
    // queued passes due.
    try {
      await f.start(compute, {
        emit,
        transformDrivers: () => ({
          ...drivers,
          computeDriver: compute,
          configurationDriver: controller.selectedDriver("configuration"),
        }),
      });
      await waitForRevisionPass(
        "worker's standing execution",
        f,
        revision,
        () => f.state.read((v) => v.repositorySessions.findStandingExecution(ref)),
        25_000,
      );
      const first = await waitFor(
        "worker installs first material",
        () => peer.delivery.settled,
        25_000,
      );
      assert.equal(peer.delivery.attempts, 1);
      assert.equal(peer.delivery.installs, 1);
      if (lostRotation) {
        peer.delivery.loseReply = true;
        peer.delivery.hideObservation = true;
      }
      if (reducible) {
        await waitFor(
          "active execution before independent use",
          () =>
            f.state.read(
              async (view) =>
                (await view.agents.findAgent(namespaceId, agentId))?.activeRevisionId ===
                  revision.id || undefined,
            ),
          25_000,
        );
        await independentRead(200);
        if (conversation) {
          assert.ok(modelEnvironment && modelCustody);
          askModel = await conversation.launch(
            modelEnvironment,
            async () => {
              const receipt = await modelClient.getSandboxProviderStatus(
                namespace.name,
                "external-model",
                openShellProviderName(modelSourceId),
                t.signal,
              );
              assert.equal(receipt?.state, "PROVIDER_READINESS_STATE_READY");
              assert.equal(
                (await f.state.read((view) => view.agents.findAgent(namespaceId, agentId)))
                  ?.activeRevisionId,
                revision.id,
              );
            },
            async (startup) =>
              signComputeExecutionRelease(
                privateKey,
                startup,
                await release.current(
                  { plan: revision.egressPlan!, revision, namespace, signal: t.signal },
                  modelCustody!,
                  async () => true,
                ),
              ),
            revision.egressPlan!.routes.length + 1,
          );
          await askModel("before");
        }
      }

      const cwd = await temporaryDirectory(t, "cedar-git-destination-");
      const env = cleanEnvironment({ GIT_SSL_CAINFO: certFile });
      const git = (args: string[], allowFailure = false) =>
        run("git", ["-C", cwd, ...args], {
          env,
          allowFailure,
          timeout: 15_000,
        });
      await git(["init", "--quiet"]);
      const { traffic } = origin;
      const remote = new URL("/" + origin.repository + ".git", peer.url).href;
      // Actual Git credential protocol: the Driver's 401 makes Git invoke the host-scoped
      // helper. It returns only a marker; the provider separately proves that marker is useless.
      const auth = broad
        ? "credential." +
          peer.url.origin +
          '.helper=!f() { test "$1" != get || printf \'username=x-access-token\\npassword=' +
          peer.gitMarker +
          "\\n'; }; f"
        : "http.extraHeader=" + peer.clientHeader;
      const fetch = (mayDeny = false) =>
        git(["-c", auth, "fetch", "--no-tags", remote, "refs/heads/main"], mayDeny);
      const transfer = async (oid: string) => {
        assert.notEqual(
          (await git(["cat-file", "-e", oid], true)).code,
          0,
          "destination must lack this exact commit",
        );
        const n = traffic().requests;
        await fetch();
        assert.equal(
          traffic().requests,
          n + (broad ? 3 : 2),
          "the real Git discovery and upload reached the private origin",
        );
        assert.equal((await git(["rev-parse", "FETCH_HEAD"])).stdout.trim(), oid);
        assert.equal((await git(["cat-file", "-t", oid])).stdout.trim(), "commit");
      };
      await transfer(await origin.ref("main"));
      if (broad) {
        const provider = broad.installation;
        const { repositories, apiRequests } = provider;
        const [a, b, c] = repositories;
        assert.deepEqual(
          repositories.map((repo) => repo.id),
          [71, 72, 73],
        );
        assert.equal(
          provider.acceptedGitRequests(),
          3,
          "Git v2 discovery, ls-refs and actual pack, with the installation token",
        );
        assert.equal(origin.trace.at(-1)!.gitProtocol, "version=2");
        await peer.replayLastInstallationExchange!();
        assert.equal(
          provider.acceptedGitRequests(),
          3,
          "replaying the exchange did not send a second pack",
        );

        await git(["checkout", "--quiet", "-b", "installation-feature", "FETCH_HEAD"]);
        const commitWork = async (message: string) => {
          await git([
            "-c",
            "user.name=Cedar",
            "-c",
            "user.email=cedar@example.test",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            message,
          ]);
          return (await git(["rev-parse", "HEAD"])).stdout.trim();
        };
        const commit = await commitWork("Work in the second private repository");
        const providerGit = (args: string[], allowFailure = false) =>
          run("git", ["-C", origin.bare, ...args], { env, allowFailure });
        assert.notEqual(
          (await providerGit(["cat-file", "-e", commit], true)).code,
          0,
          "the push must transfer a new object",
        );
        await git(["-c", auth, "push", "--quiet", remote, "HEAD:refs/heads/installation-feature"]);
        assert.equal(await origin.ref("refs/heads/installation-feature"), commit);
        await providerGit(["fsck", "--strict"]);
        await providerGit(["config", "receive.hideRefs", "refs/heads/provider-protected"]);
        const blocked = await git(
          ["-c", auth, "push", remote, "HEAD:refs/heads/provider-protected"],
          true,
        );
        assert.notEqual(blocked.code, 0);
        assert.match(
          blocked.stderr,
          /deny updating a hidden ref/,
          "the provider still enforces its branch policy",
        );

        const api = (
          path: string,
          method = "GET",
          body?: object,
          target = peer.apiUrl,
          host = target.host,
        ) =>
          new Promise<{ status: number; data: Record<string, unknown> }>((resolve, reject) => {
            request(
              target,
              {
                ca: tls.ca,
                agent: false,
                family: 4,
                signal: t.signal,
                path,
                method,
                headers: {
                  host,
                  authorization:
                    target === peer.url
                      ? "Basic " +
                        Buffer.from("x-access-token:" + peer.gitMarker).toString("base64")
                      : "Bearer " + peer.gitMarker,
                  ...(body && { "content-type": "application/json" }),
                },
              },
              (res) => {
                const status = res.statusCode!;
                if (!res.headers["content-type"]?.startsWith("application/json")) {
                  res.resume();
                  resolve({ status, data: {} });
                  return;
                }
                void json(res).then(
                  (data) =>
                    resolve({
                      status,
                      data: data as Record<string, unknown>,
                    }),
                  reject,
                );
              },
            )
              .once("error", reject)
              .end(body && JSON.stringify(body));
          });
        const repos = "/repos/";
        const atB = repos + origin.repository;
        const initial = apiRequests.length;
        for (const [path, target, host] of [
          [atB, peer.url, peer.url.host], // API cannot travel on the Git route
          ["/installation/token", peer.apiUrl, peer.apiUrl.host],
          [atB, peer.apiUrl, "credentials.example.test"],
        ] as const) {
          assert.equal(
            (await api(path, "GET", undefined, target, host)).status,
            403,
            "route denial for " + host + path,
          );
        }
        assert.equal(
          apiRequests.length,
          initial,
          "wrong host, route and credential-owner paths never reached the provider",
        );
        for (const repo of [a!, b!]) {
          const { status, data } = await api(repos + repo.full_name);
          assert.equal(status, 200);
          assert.equal(data.full_name, repo.full_name);
          assert.equal(data.id, repo.id);
          assert.equal(data.private, true);
        }
        for (const resource of ["issues", "pulls"]) {
          const at = atB + "/" + resource;
          const { data, status } = await api(at, "POST", {
            title: "Installation work",
            head: "installation-feature",
            base: "main",
            draft: true,
          });
          assert.equal(status, 201);
          const edit = await api(at + "/" + data.number, "PATCH", {
            title: "Updated work",
          });
          assert.equal(edit.status, 200);
          assert.equal(edit.data.title, "Updated work");
          if (resource === "pulls") {
            // Updating an existing PR must transfer a second object to its actual head,
            // not merely echo a successful push or PATCH response.
            const nextCommit = await commitWork("Follow-up work on the same pull request");
            assert.notEqual(nextCommit, commit);
            assert.notEqual(
              (await providerGit(["cat-file", "-e", nextCommit], true)).code,
              0,
              "the origin must lack the follow-up commit before the push",
            );
            await git([
              "-c",
              auth,
              "push",
              "--quiet",
              remote,
              "HEAD:refs/heads/installation-feature",
            ]);
            const readback = await api(at + "/" + data.number);
            assert.equal(readback.status, 200);
            assert.equal(readback.data.number, data.number);
            assert.equal(readback.data.title, "Updated work");
            assert.equal(readback.data.draft, true);
            assert.equal(
              apiRequests.filter((entry) => entry.path === at && entry.status === 201).length,
              1,
              "follow-up work updates the original draft PR",
            );
            const { base, head } = readback.data as {
              base: { ref: string };
              head: { ref: string };
            };
            assert.equal(base.ref, "main");
            assert.equal(head.ref, "installation-feature");
            assert.equal(await origin.ref("refs/heads/" + head.ref), nextCommit);
            await providerGit(["fsck", "--strict"]);
            t.diagnostic(`original draft PR commits: ${commit} -> ${nextCommit}`);
          }
        }
        const query =
          '{ repository(owner: "fixture", name: "private-b") { nameWithOwner isPrivate } }';
        const graph = await api("/graphql", "POST", { query });
        assert.equal(graph.status, 200);
        const result = (
          graph.data as {
            data: {
              repository: { nameWithOwner: string; isPrivate: boolean };
            };
          }
        ).data.repository;
        assert.equal(result.nameWithOwner, origin.repository);
        assert.equal(result.isPrivate, true);
        assert.equal(
          c!.private,
          true,
          "the provider independently knows that C exists and is private",
        );
        const missing = "fixture/never-existed";
        for (const name of [c!.full_name, missing]) {
          const path = repos + name;
          const masked = { status: 404, data: { message: "Not Found" } };
          assert.deepEqual(await api(path), masked, "the workload sees the same masked 404");
          assert.deepEqual(apiRequests.at(-1), {
            path,
            authenticated: true,
            exists: name !== missing,
            selected: false,
            status: 404,
          });
        }
      }

      // Send raw request targets through the working sender. Even targets resolving to the
      // allowed URL must be refused before authorization or any connection to the private origin.
      const discovery = `/${origin.repository}.git/info/refs?service=git-upload-pack`;
      const upstream = new URL(origin.origin);
      const ca = await readFile(certFile);
      const headers = {
        host: peer.url.host,
        authorization: broad
          ? "Basic " + Buffer.from("x-access-token:" + peer.gitMarker).toString("base64")
          : peer.clientHeader.slice("Authorization: ".length),
      };
      const prior = { traffic: traffic(), decisions: peer.decisions.length };
      // Cross the listeners with a valid workload marker and the protected Host header.
      // Neither public discovery on the sender nor a Git operation on discovery may reach authority.
      for (const [target, path, expectedStatus] of [
        [capabilityOrigin, discovery, 404],
        [peer.url, "/capability", 403],
        [peer.url, `//${upstream.host}${discovery}`, 403],
        [peer.url, peer.url.origin + discovery, 403],
        [peer.url, "/elsewhere/.." + discovery, 403],
      ] as const) {
        const status = await new Promise<number | undefined>((resolve, reject) => {
          get(target, { path, ca, headers, signal: t.signal }, (res) => {
            res.resume();
            resolve(res.statusCode);
          }).once("error", reject);
        });
        assert.equal(status, expectedStatus, path);
        assert.deepEqual({ traffic: traffic(), decisions: peer.decisions.length }, prior, path);
      }

      // The same working sender now holds a committed positive until its actual send cutoff,
      // while the original request is still in time. Never ask for a second authorization.
      for (const holdAt of online || lostRotation
        ? []
        : broad
          ? (["request"] as const)
          : (["connect", "request"] as const)) {
        const before = traffic();
        const decisions = peer.decisions.length;
        const held: {
          permit: RepositoryGitSendPermit;
          releaseAt: number;
          deadlineAt: string;
        }[] = [];
        peer.beforeSend = async (stage, permit, deadlineAt) => {
          if (stage !== holdAt) {
            return;
          }
          const until = Date.parse(permit.sendStartBy);
          let releaseAt = Date.now();
          assert.ok(releaseAt < until, "the sender received a live, committed permit");
          while (releaseAt < until) {
            await delay(until - releaseAt, undefined, { signal: t.signal });
            releaseAt = Date.now();
          }
          held.push({ permit, releaseAt, deadlineAt });
        };
        const expired = await fetch(true);
        delete peer.beforeSend;
        assert.deepEqual(
          traffic(),
          {
            connections: before.connections + Number(holdAt === "request"),
            requests: before.requests,
          },
          `expired permit before ${holdAt} must not start an origin request`,
        );
        assert.equal(
          held.length,
          1,
          "the already issued permit crossed its send cutoff exactly once",
        );
        const { permit, releaseAt, deadlineAt } = held[0]!;
        assert.ok(
          Date.parse(permit.sendStartBy) <= releaseAt && releaseAt < Date.parse(deadlineAt),
        );
        assert.deepEqual(peer.decisions.slice(decisions), [
          { operation: "advertise-upload-pack", decision: permit },
        ]);
        const { rows } = await pool.query(
          `SELECT send_start_by, material_version, attempt_id, request_digest_sha256
           FROM occ.prepared_repository_git_uses WHERE exchange_id=$1`,
          [permit.exchangeId],
        );
        assert.deepEqual(
          rows,
          [
            {
              send_start_by: new Date(permit.sendStartBy),
              material_version: permit.materialVersion,
              attempt_id: permit.preparationAttemptId,
              request_digest_sha256: permit.requestDigestSha256,
            },
          ],
          "possible use remains committed with exactly the permit the sender let expire",
        );
        assert.equal(expired.code, 128);
        assert.match(expired.stderr.toString(), /403/);
        t.diagnostic(
          `expired before ${holdAt}: ${JSON.stringify(before)} -> ${JSON.stringify(traffic())}, one possible use`,
        );
      }

      // Real owner deadlines: the 5-minute fixture token is inside the 10-minute renewal window.
      // Make the persisted next check due now for the owner's background loop, without
      // extending or editing a token or session deadline.
      let second = first;
      if (!broad) {
        const { rowCount } = await pool.query(
          "UPDATE occ.prepared_github_families SET next_check_at=clock_timestamp() WHERE enabled AND source #>> '{session,revisionId}'=$1",
          [revision.id],
        );
        assert.equal(rowCount, 1);
        if (!lostRotation) {
          second = await waitFor(
            "worker rotates material",
            () => {
              const settled = peer.delivery.settled;
              return settled?.materialVersion !== first.materialVersion ? settled : undefined;
            },
            25_000,
          );
        }
        if (lostRotation) {
          await waitFor(
            "recipient stores B before losing the reply",
            () => peer.delivery.installs === 2 || undefined,
            25_000,
          );
          const readDelivery = async () =>
            (
              await pool.query(
                "SELECT revision_id, binding_id, target, operation_fence, target_preparation_attempt_id, target_material_version, preparation_attempt_id, material_version, write_pending, blocked FROM occ.credential_deliveries WHERE revision_id=$1",
                [revision.id],
              )
            ).rows[0];
          const pending = await readDelivery();
          assert.equal(pending.write_pending, "rotate");
          assert.equal(
            pending.material_version,
            first.materialVersion,
            "A is history, never readiness for B",
          );
          assert.notEqual(pending.target_material_version, first.materialVersion);
          assert.equal(gh.issuesOfTokens.length, 2, "only A and B were issued");
          assert.equal(
            peer.delivery.attempts,
            2,
            "exactly A and original lost B reached the recipient",
          );
          const recoveryCounters = () => ({
            issues: gh.issuesOfTokens.length,
            traffic: traffic(),
            attempts: peer.delivery.attempts,
            installs: peer.delivery.installs,
            reductionAttempts: peer.reduction.attempts,
          });
          // Snapshot before the first denied fetch: provider failures cannot enter the baseline.
          const beforeRecovery = recoveryCounters();
          assert.deepEqual(beforeRecovery, {
            issues: 2,
            traffic: { connections: 2, requests: 2 },
            attempts: 2,
            installs: 2,
            reductionAttempts: 0,
          });
          const readReduction = () =>
            f.state.read(async (view) => ({
              records: await view.credentialSources.listCredentialPolicyReductions(
                namespaceId,
                revision.id,
              ),
              installation: await view.credentialSources.findRevisionEgressInstallation(
                namespaceId,
                revision.id,
              ),
            }));
          const beforeWithdrawal = await readReduction();
          assert.deepEqual(beforeWithdrawal.records, []);
          assert.deepEqual(peer.reduction.requests, []);
          assert.deepEqual(peer.reduction.applied, []);
          peer.reduction.beforeApply = async () => {
            const durable = await readReduction();
            const received = peer.reduction.requests.at(-1)!;
            const original = durable.records.find(
              (record) => record.bindingId === "policy:repository-git",
            );
            assert.ok(original);
            assert.equal(withdrawalStarted, true);
            assert.equal(durable.records.length, 1);
            assert.equal(original.observed, undefined);
            assert.equal(peer.reduction.attempts, 1);
            assert.deepEqual(received.operation, original.request);
            assert.deepEqual(received.current, original.request.expected);
            assert.deepEqual(durable.installation, original.request.expected);
            assert.deepEqual(original.request.expected, beforeWithdrawal.installation);
            t.diagnostic(
              `withdrawal dispatch: ${JSON.stringify({
                operationId: original.request.operationId,
                bindingId: original.bindingId,
                generation: original.request.expected.plan.generation,
                retainedGeneration: original.request.retained.generation,
                sandboxId: received.current!.sandboxId,
                durableMatch: true,
                attempts: peer.reduction.attempts,
              })}`,
            );
          };
          let expectedReductionAttempts = 0;
          const assertNoEffect = () =>
            assert.deepEqual(recoveryCounters(), {
              ...beforeRecovery,
              reductionAttempts: expectedReductionAttempts,
            });
          const deniedFetch = async () => {
            const denied = await fetch(true);
            assertNoEffect();
            assert.equal(denied.code, 128);
            assert.ok(/403/.test(denied.stderr.toString()), "sender refuses Git with HTTP 403");
          };
          const decisions = peer.decisions.length;
          await deniedFetch();
          assert.deepEqual(peer.decisions.slice(decisions), [
            {
              operation: "advertise-upload-pack",
              decision: { kind: "denied", reason: "unavailable" },
            },
          ]);
          const pendingPasses = peer.delivery.reconciliations;
          await waitFor(
            "original lost B is observed without another installation attempt",
            () => peer.delivery.reconciliations >= pendingPasses + 2 || undefined,
            10_000,
          );
          assertNoEffect();
          await f.stop();
          await transport!.close();
          await prepared.close();
          prepared = await startOwner();
          transport = await bindRepositoryGitTransport(drivers, prepared, pool, emit);
          await expireStoppedClaims(f, revision);
          await f.start(compute, {
            emit,
            transformDrivers: () => ({
              ...drivers,
              computeDriver: compute,
              configurationDriver: controller.selectedDriver("configuration"),
            }),
          });
          const replacementPasses = peer.delivery.reconciliations;
          await waitFor(
            "replacement observes hidden B without dispatch",
            () => peer.delivery.reconciliations >= replacementPasses + 2 || undefined,
            10_000,
          );
          assertNoEffect();
          // The authenticated peer lies about C. OCC must reject it against the immutable B intent.
          peer.delivery.reportedVersion = {
            preparationAttemptId: randomUUID(),
            materialVersion: randomUUID(),
          };
          peer.delivery.hideObservation = false;
          await waitFor(
            "C cannot confirm B",
            () => peer.delivery.rejectedConfirmations > 0 || undefined,
            25_000,
          );
          assert.deepEqual(await readDelivery(), pending);
          await deniedFetch();
          // Drain the worker before withdrawal. The separate, genuine transport reconciler
          // can settle late B while withdrawal work waits durably for worker replacement.
          await f.stop();
          preparationsBeforeWithdrawal = preparations;
          withdrawalStarted = true;
          await controller.removeAgentStandingApproval(who, {
            ...key,
            approvalId,
            expectedGeneration: 1,
          });
          assertNoEffect();
          delete peer.delivery.reportedVersion;
          await waitFor(
            "late exact B settles history",
            async () => {
              const row = await readDelivery();
              return (
                (row.write_pending === null &&
                  row.material_version === pending.target_material_version &&
                  row) ||
                undefined
              );
            },
            25_000,
          );
          const settled = await readDelivery();
          assertNoEffect();
          assert.equal(settled.revision_id, pending.revision_id);
          assert.equal(settled.binding_id, pending.binding_id);
          assert.deepEqual(settled.target, pending.target);
          assert.equal(settled.operation_fence, pending.operation_fence);
          assert.equal(settled.preparation_attempt_id, pending.target_preparation_attempt_id);
          assert.deepEqual(
            peer.delivery.confirmations.map(({ materialVersion }) => materialVersion),
            [first.materialVersion, pending.target_material_version],
            "only original A and B were confirmed",
          );
          await deniedFetch();
          const passes = peer.delivery.reconciliations;
          await waitFor(
            "maintenance cannot reopen withdrawn B",
            () => peer.delivery.reconciliations >= passes + 2 || undefined,
            10_000,
          );
          await deniedFetch();
          assert.equal(preparations, preparationsBeforeWithdrawal);
          assert.equal(stopAttempts, 0);
          assert.deepEqual((await readReduction()).records, []);
          peer.reduction.loseReply = true;
          peer.reduction.hideObservation = true;
          await expireStoppedClaims(f, revision);
          await f.start(compute, {
            emit,
            transformDrivers: () => ({
              ...drivers,
              computeDriver: compute,
              configurationDriver: controller.selectedDriver("configuration"),
            }),
          });
          const original = await waitFor(
            "original withdrawal applies despite its lost reply",
            async () => {
              const { records } = await readReduction();
              const record = records.find((item) => item.bindingId === "policy:repository-git");
              return record &&
                peer.reduction.applied.some(
                  (item) => item.operationId === record.request.operationId,
                )
                ? record
                : undefined;
            },
            65_000,
          );
          assert.equal(original.observed, undefined);
          const { repositoryGit, ...retained } = beforeWithdrawal.installation!.plan;
          assert.ok(repositoryGit);
          assert.deepEqual(original.request.retained, {
            ...retained,
            generation: retained.generation + 1,
          });
          assert.deepEqual(peer.reduction.requests, [
            {
              operation: original.request,
              current: beforeWithdrawal.installation,
            },
          ]);
          const reduced = await peer.observePolicy();
          assert.deepEqual(reduced.plan, original.request.retained);
          assert.deepEqual(peer.reduction.applied, [
            {
              operationId: original.request.operationId,
              installation: reduced,
            },
          ]);
          expectedReductionAttempts = 1;
          assertNoEffect();
          assert.equal(peer.reduction.applies, 1);
          await deniedFetch();
          // A lost apply response and a hidden observation require real cleanup retries.
          // They must GET the original operation, never send its POST again.
          await waitForRevisionPass(
            "cleanup observes the original operation while hidden",
            f,
            revision,
            async () => {
              return (
                peer.reduction.observations.includes(original.request.operationId) || undefined
              );
            },
            65_000,
          );
          assertNoEffect();
          assert.deepEqual((await readReduction()).records, [original]);
          peer.reduction.hideObservation = false;
          const settledReduction = await waitForRevisionPass(
            "authorized Git withdrawal is durably observed",
            f,
            revision,
            async () => {
              const durable = await readReduction();
              return durable.records[0]?.observed ? durable : undefined;
            },
            65_000,
          );
          assert.deepEqual(settledReduction.records, [{ ...original, observed: reduced }]);
          assert.deepEqual(settledReduction.installation, reduced);
          assert.ok(peer.reduction.observations.length >= 2);
          assert.deepEqual(
            [...new Set(peer.reduction.observations)],
            [original.request.operationId],
          );
          await deniedFetch();
          assert.equal(peer.reduction.applies, 1);
          assert.deepEqual(peer.reduction.requests, [
            { operation: original.request, current: original.request.expected },
          ]);
          assert.deepEqual(await readDelivery(), settled);
          assert.equal(preparations, preparationsBeforeWithdrawal);
          assert.equal(stopAttempts, 0);
          t.diagnostic(
            `withdrawal settled: ${JSON.stringify({
              operationId: original.request.operationId,
              bindingId: original.bindingId,
              generation: original.request.expected.plan.generation,
              retainedGeneration: reduced.plan.generation,
              sandboxId: reduced.sandboxId,
              durableMatch: true,
              attempts: peer.reduction.attempts,
              applies: peer.reduction.applies,
              observations: peer.reduction.observations.length,
            })}`,
          );
          t.diagnostic(
            `lost B through withdrawal and maintenance: ${JSON.stringify(beforeRecovery)} -> ${JSON.stringify(recoveryCounters())}`,
          );
          return;
        }
        assert.notEqual(first.materialVersion, second.materialVersion);
        await transfer(await origin.addCommit());
      }
      const receiptCount = () =>
        pool
          .query(
            "SELECT count(*)::integer n FROM occ.prepared_repository_git_uses WHERE material_version=$1",
            [second.materialVersion],
          )
          .then((r) => r.rows[0].n);
      const committed = await receiptCount();
      if (broad) {
        assert.equal(
          committed,
          broad.installation.acceptedGitRequests() +
            broad.installation.apiRequests.length +
            Number(!online),
          "possible use per Git or API request and, for exact dispatch, the deliberately expired permit",
        );
      } else {
        assert.equal(committed, 2);
      }

      // Send another actual request to the same still-equipped sender. Check the transport and
      // HTTP boundaries before the client result, so an erroneous forward fails at the origin oracle.
      const providerTraffic = () => ({
        ...traffic(),
        // Token Service retirement is lifecycle traffic, not a workload send.
        apiRequests: broad?.installation.apiRequests.filter(
          ({ path }) => path !== "/installation/token",
        ).length,
        issues: gh.issuesOfTokens.length,
      });
      const before = providerTraffic();
      const decisions = peer.decisions.length;
      if (reducible) {
        peer.reduction.loseReply = true;
        peer.reduction.hideObservation = true;
        const hold = new Promise<void>((resolve) => {
          releaseReduction = resolve;
        });
        peer.reduction.beforeApply = () => hold;
      }
      preparationsBeforeWithdrawal = preparations;
      withdrawalStarted = true;
      await controller.removeAgentStandingApproval(who, {
        ...key,
        approvalId,
        expectedGeneration: 1,
      });
      const denied = await fetch(true);
      assert.deepEqual(
        providerTraffic(),
        before,
        "no Git connection, API request or issuance may reach the provider after withdrawal",
      );
      assert.deepEqual(peer.decisions.slice(decisions), [
        {
          operation: "advertise-upload-pack",
          decision: { kind: "denied", reason: "access_withdrawn" },
        },
      ]);
      assert.equal(denied.code, 128);
      assert.match(denied.stderr.toString(), /403/);
      assert.ok(
        Date.now() < Date.parse(second.expiresAt),
        "withdrawal was tested while the installed credential was usable",
      );
      assert.equal(await receiptCount(), committed, "withdrawal did not add a possible use");
      if (broad) {
        const deniedPush = await git(
          ["-c", auth, "push", "--quiet", remote, "HEAD:refs/heads/installation-feature"],
          true,
        );
        assert.notEqual(deniedPush.code, 0);
        assert.match(deniedPush.stderr.toString(), /403/);
        assert.deepEqual(
          providerTraffic(),
          before,
          "withdrawal denies Git writes before the origin",
        );
      }
      if (reducible) {
        releaseReduction!();
        await waitForRevisionPass(
          "Git reduction applied by ordinary cleanup",
          f,
          revision,
          () => peer.reduction.applies === 1 || undefined,
          25_000,
        );
        assert.equal(peer.reduction.attempts, 1);
        await f.stop();
        const reduced = await peer.observePolicy();
        assert.equal(reduced.plan.repositoryGit, undefined);
        assert.deepEqual(reduced.plan.execution, revision.egressPlan!.execution);
        assert.equal(await fetch(true).then((result) => result.code), 128);
        peer.reduction.hideObservation = false;
        await transport!.close();
        await prepared.close();
        prepared = await startOwner();
        transport = await bindRepositoryGitTransport(drivers, prepared, pool, emit);
        await expireStoppedClaims(f, revision);
        await f.start(compute, {
          emit,
          transformDrivers: () => ({
            ...drivers,
            computeDriver: compute,
            configurationDriver: controller.selectedDriver("configuration"),
          }),
        });
        // Cleanup retries after the lost reply on its 30-second cadence.
        await waitForRevisionPass(
          "replacement worker observes the original reduction",
          f,
          revision,
          async () => {
            return f.state.read(
              async (view) =>
                (
                  await view.credentialSources.listCredentialPolicyReductions(
                    namespaceId,
                    revision.id,
                  )
                ).find((reduction) => reduction.bindingId === "policy:repository-git")?.observed ||
                undefined,
            );
          },
          45_000,
        );
        assert.equal(peer.reduction.attempts, 1, "lost acknowledgment never replays POST");
        assert.equal(peer.reduction.applies, 1);
        t.diagnostic("reduction after replacement: attempts=1 applies=1");
        assert.equal(preparations, preparationsBeforeWithdrawal);
        assert.equal(
          (await f.state.read((view) => view.agents.findAgent(namespaceId, agentId)))
            ?.activeRevisionId,
          revision.id,
        );
        assert.deepEqual(
          providerTraffic(),
          before,
          "reduction and restart cannot send Git to the origin",
        );
        await independentRead(200);
        assert.equal(independentRequests, 2);
        await askModel?.("after");
        if (conversationRequired) {
          assert.ok(askModel, "required same-conversation proof ran on v7");
        }
        peer.reduction.loseReply = false;
        await controller.withdrawAgentCredentialSource(who, {
          namespaceId,
          agentId,
          credentialSourceId: independentSourceId!,
        });
        await waitFor(
          "last external proxy route reduced by ordinary withdrawal worker",
          () =>
            f.state.read(
              async (view) =>
                (
                  await view.credentialSources.findCredentialWithdrawal(
                    namespaceId,
                    revision.id,
                    independentSourceId!,
                  )
                )?.state === "revoked" || undefined,
            ),
          25_000,
        );
        await independentRead(403);
        // This is the last route on the external proxy; the model gateway is a separate owner.
        const deniedAll = await peer.observePolicy();
        assert.equal(deniedAll.sandboxId, reduced.sandboxId);
        assert.deepEqual(deniedAll.plan.execution, reduced.plan.execution);
        assert.deepEqual(deniedAll.plan.routes, []);
        assert.equal(deniedAll.plan.repositoryGit, undefined);
        assert.equal(peer.reduction.attempts, 2, "final route removal adds exactly one POST");
        assert.equal(peer.reduction.applies, 2);
        t.diagnostic(
          "final reduction: attempts=2 applies=2; metadata requests=2, final read denied",
        );
        assert.equal(preparations, preparationsBeforeWithdrawal);
        assert.equal(independentRequests, 2, "deny-all prevents a new independent origin request");
        assert.equal(
          (await f.state.read((view) => view.agents.findAgent(namespaceId, agentId)))
            ?.activeRevisionId,
          revision.id,
        );
      }
      if (broad) {
        await broad.installation.verifyTokenStillWorks();
        t.diagnostic(
          "one installation token, private Git v2 pack and two distinct commits pushed to the same PR head, updated PR readback, provider-protected ref, REST and GraphQL; fresh Git denied after withdrawal, zero provider connection or HTTP, then direct proof the same token was still accepted",
        );
        return;
      }
      assert.ok("tokenState" in gh);
      const [, live] = gh.tokenState();
      assert.equal(live?.uses, 2);
      assert.equal(live.revoked, false);
      assert.equal(await receiptCount(), 2);
      t.diagnostic(
        "fetched two previously absent commits using distinct material; withdrawn request reached the same sender, with zero additional origin connections or HTTP requests",
      );
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      releaseReduction?.();
      await f.stop();
    }
  };
}

// Loopback transport proof: the counterpart, not an apply acknowledgment, owns the policy.
// The PostgreSQL journey above separately proves the worker, session and provider lifecycle.
test("external Git reduction authenticates and observes exact policy without mutation replay", async (t) => {
  const tls = await createTlsMaterial(t);
  const { entry } = await protectedDriverPackage(t, "reduction-rpc", "repository-git");
  const adapter = (await import(
    join(entry, "repository-git.mjs")
  )) as typeof import("../fixtures/driver-packages/protected-execution-driver/repository-git.ts");
  const origin = await listen(t, adapter.createCounterpart(tls));
  const discovery = createCapabilityPeer(tls, "github_installation", false, true);
  const capabilityOrigin = await listen(t, discovery.server);
  const driver = adapter.createDriver({
    id: "reduction-rpc",
    implementation: "reduction-rpc",
    configuration: {
      origin,
      peerOrigin: origin,
      capabilityOrigin,
      certFile: tls.certFile,
      releaseKey: "unused-in-policy-rpc",
      policyReduction: true,
    },
  });
  const proxy = driver.capabilities.credential_proxy!;
  // None of the material or business-operation ports participates in policy reduction.
  const authority = new Proxy(
    {},
    {
      get() {
        throw new Error("Policy reduction must not use material authority");
      },
    },
  ) as import("../../packages/contracts/src/index.ts").ProtectedRepositoryGitAuthority;
  const binding = await proxy.bindRepositoryGit!(authority);
  t.after(() => binding.close());
  const reducer = proxy.policyReduction!;
  assert.equal(reducer.version, 2);
  if (reducer.version !== 2) {
    throw new Error("Expected reduction v2");
  }
  await reducer.assertAvailable(t.signal);
  const plan: import("../../packages/contracts/src/index.ts").ProxyPlan = {
    id: randomUUID(),
    generation: 1,
    execution: {
      installationId: "ins_" + randomUUID(),
      namespaceId: "ns_" + randomUUID(),
      agentId: "agt_" + randomUUID(),
      servicePrincipalId: "sp_" + randomUUID(),
      revisionId: "rev_" + randomUUID(),
      executionId: randomUUID(),
    },
    sandboxDriverId: "reduction-rpc",
    egressDriverId: "reduction-rpc",
    driver: {
      id: "reduction-rpc",
      implementation: "reduction-rpc",
      configurationId: "a".repeat(64),
    },
    policyReductionVersion: 2,
    repositoryGit: {
      driver: { id: "repo", implementation: "github" },
      deadlineWallMs: Date.now() + 60000,
      bindings: [
        {
          backendId: "repo",
          repositoryRef: "repository",
          profile: "git-write",
          grant: { providerInstanceId: "provider", repositoryId: "1", grantId: "grant" },
        },
      ],
    },
    routes: [],
  };
  // This adapter's configure operation consumes only the exact plan. No runtime release is claimed.
  const context = {
    plan,
    signal: t.signal,
  } as import("../../packages/contracts/src/index.ts").ProxyRevisionContext;
  await proxy.configureRevision(context);
  const initial = await adapter.peer.observePolicy();
  const { repositoryGit, ...remaining } = plan;
  assert.ok(repositoryGit);
  const operation: import("../../packages/contracts/src/index.ts").CredentialPolicyReduction = {
    version: 2,
    operationId: randomUUID(),
    expected: initial,
    retained: { ...remaining, generation: 2 },
  };
  adapter.peer.reduction.loseReply = true;
  await assert.rejects(reducer.apply(context, operation), /socket hang up/);
  adapter.peer.reduction.hideObservation = true;
  assert.equal(
    await reducer.observe(context, operation),
    undefined,
    "missing evidence cannot become a successful observation",
  );
  adapter.peer.reduction.hideObservation = false;
  const observed = await reducer.observe(context, operation);
  assert.deepEqual(observed?.installation.plan, operation.retained);
  assert.equal(observed?.installation.sandboxId, initial.sandboxId);
  assert.deepEqual(observed?.installation.plan.execution, initial.plan.execution);
  assert.equal(adapter.peer.reduction.attempts, 1);
  assert.equal(adapter.peer.reduction.applies, 1);
  // Observation is authenticated; possession of the URL does not expose the installation.
  const certificate = await readFile(tls.certFile);
  const unauthorized = await new Promise<number | undefined>((resolve, reject) => {
    get(
      new URL("/policy-reduction/" + operation.operationId, origin),
      { ca: certificate, agent: false },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    ).once("error", reject);
  });
  assert.equal(unauthorized, 403);
  await assert.rejects(proxy.configureRevision(context), /exactly one execution/);
  await assert.rejects(reducer.apply(context, operation), /502.*204|204/);
  assert.equal(adapter.peer.reduction.attempts, 2, "duplicate POST reaches the recipient");
  assert.equal(adapter.peer.reduction.applies, 1, "duplicate operation cannot mutate policy");
  assert.deepEqual(
    adapter.peer.reduction.requests.map((entry) => entry.operation),
    [operation, operation],
  );
  assert.deepEqual(adapter.peer.reduction.applied, [
    { operationId: operation.operationId, installation: observed!.installation },
  ]);
  t.diagnostic("deliberate duplicate: attempts=2 applies=1");
  assert.deepEqual(await reducer.observe(context, operation), observed);
  await assert.rejects(
    reducer.apply(context, {
      ...operation,
      operationId: randomUUID(),
      expected: { ...observed!.installation, sandboxId: randomUUID() },
    }),
    /204/,
  );
  assert.equal(
    adapter.peer.reduction.applies,
    1,
    "a different recipient cannot change the reduced policy",
  );
  assert.equal(adapter.peer.reduction.attempts, 3, "wrong-recipient POST is also counted");
});
