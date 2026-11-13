import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { gitExpiryGateway } from "../helpers/openshell-online-git-journey.mjs";
import {
  OpenShellPreparedGitProvider,
  type OpenShellPreparedGitInstalled,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts";
import { witnessOpenShellGitLaunch } from "../../apps/controller/src/drivers/egress-proxy/openshell-expired-git.ts";
import { openShellGitExecutionIdentity } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-installation.ts";

import { standingExecutionPlatform } from "../helpers/postgres-standing-execution.ts";
import { protectedDriverPackage } from "../helpers/protected-driver-package.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
import { signedLeaf } from "../helpers/certificates.mjs";
import {
  loadInstallationConfiguration,
  type InstallationRuntimeDrivers,
} from "../../apps/controller/src/composition/installation-config.ts";
import { repositoryApprovalFingerprint } from "../../packages/occ/src/index.ts";
import { waitUntil } from "../helpers/wait-for.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { CREDENTIAL_GATEWAY_FIXTURE_ID } from "../helpers/postgres-worker-revision-fixture.mjs";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import {
  createGitHubRepositoryDeliveryResolver,
  validateGitHubRepositoryRegistry,
} from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
import {
  OpenShellGitRuntime,
  openShellRepositoryAccess,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { PostgresOpenShellGitRouteStore } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts";
import type { EgressAuthorityConfiguration } from "../../apps/controller/src/composition/egress-authority.ts";

// Historical persisted facts only: never prepare or adopt this retired live profile.
test(
  "historical v5 installation cannot renew and settles the original lost detach without replay",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const f = await standingExecutionPlatform(t, import.meta.url);
    const gateway = new OpenShellCredentialGatewayDriver(
      { binaries: ["/usr/bin/codex"] },
      {
        id: CREDENTIAL_GATEWAY_FIXTURE_ID,
        backend: {
          id: "historical-gateway",
          drivers: { credential_gateway: CREDENTIAL_GATEWAY_FIXTURE_ID },
          client: {
            placement: () => undefined,
            clientForNamespace: () => {
              throw new Error("no credential access");
            },
          },
        } as never,
      },
    );
    const registry = validateGitHubRepositoryRegistry({
      version: 1,
      backendId: "historical-standing",
      providerInstanceId: "historical-provider",
      appId: "123",
      githubInstallationId: "456",
      maximumDurationSeconds: 180,
      allowStandingApprovals: true,
      installationAccess: {
        repositoryRef: "team-installation",
        namespaces: [
          { namespaceId: f.namespace.id, accessMode: "installation", allowStandingApproval: true },
        ],
      },
      repositories: [
        {
          repositoryRef: "source",
          repositoryId: "789",
          repository: "example/source",
          namespaces: [
            {
              namespaceId: f.namespace.id,
              profiles: ["git-write"],
              transport: "git-only",
              allowStandingApproval: true,
              pushRefAllowlist: ["refs/heads/review"],
            },
          ],
        },
      ],
    });
    const id = "historical-protected-git";
    const { directory, entry } = await protectedDriverPackage(t, id, "repository-git");
    const tls = await harnessTlsFixture(t);
    const loopback = await signedLeaf(tls.directory, tls.authority, {
      name: "historical-loopback",
      commonName: "Historical protected Git fixture",
      subjectAltName: "IP:127.0.0.1",
      keyPem: undefined,
      days: 1,
    });
    const serverTls = { cert: loopback.cert, key: loopback.key };
    const packageFixture = (await import(
      pathToFileURL(join(entry, "repository-git.mjs")).href
    )) as typeof import("../fixtures/driver-packages/protected-execution-driver/repository-git.ts");
    const sender = packageFixture.createCounterpart(serverTls);
    // Advertise the historical profile through the installed package's real negotiation.
    // No delivery request is made: the cold OpenShell verifier below must refuse first.
    const capability = createServer(serverTls, (_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ profile: "github_installation", authorization: "online-request" }),
      );
    });
    const origins: string[] = [];
    for (const server of [sender, capability]) {
      t.after(
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          }),
      );
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      origins.push(`https://127.0.0.1:${address.port}`);
    }
    const registryPath = join(directory, "registry.json");
    const caPath = join(directory, "ca.pem");
    await writeFile(registryPath, JSON.stringify(registry), { mode: 0o600 });
    await writeFile(caPath, tls.caBundle, { mode: 0o600 });
    const base = createInstallationDriverConfiguration();
    const { gatewayClients: _clients, ...network } = base.drivers.compute.configuration.network;
    const path = join(directory, "installation.json");
    await writeFile(
      path,
      JSON.stringify({
        ...base,
        presets: { includeDefaults: false },
        runtime: { nativeWorkerSupport: "custom-image" },
        backend: [{ id: registry.backendId, type: "github", configuration: { registryPath } }],
        repository: {
          id: registry.backendId,
          configuration: { sessionDurationSeconds: 120 },
          preparedGitHub: {
            custodyKeyPath: join(directory, "custody"),
            privateKeyPath: join(directory, "signer"),
          },
        },
        drivers: {
          ...base.drivers,
          compute: {
            ...base.drivers.compute,
            configuration: {
              ...base.drivers.compute.configuration,
              network,
              gatewayRouting: {
                hostname: "agents.example.test",
                gatewayName: "gateways",
                gatewayNamespace: "occ-system",
                envoyNamespace: "envoy",
              },
            },
          },
          sandbox: {
            id,
            package: id,
            configuration: {
              origin: origins[0],
              peerOrigin: origins[0],
              capabilityOrigin: origins[1],
              installationApiOrigin: origins[0],
              certFile: caPath,
              releaseKey: "unused-before-release",
            },
          },
          credential_proxy: { id, configuration: {} },
        },
      }),
      { mode: 0o600 },
    );
    const loaded = await loadInstallationConfiguration({
      mode: "production",
      packageRoot: directory,
      environment: { OCC_CONFIG_PATH: path },
    });
    assert.ok(loaded?.repositoryRuntime?.protectedDriver);
    assert.equal(loaded.repositoryRuntime.computeDriver, loaded.computeDriver);
    assert.equal(loaded.repositoryRuntime.protectedDriver, loaded.protectedDriver);
    assert.equal(loaded.repositoryRuntime.tokenService, loaded.tokenService);
    const protectedOwner = loaded.repositoryRuntime.protectedDriver;
    assert.equal(protectedOwner.require("sandbox"), loaded.sandboxDriver);
    assert.equal(protectedOwner.require("credential_proxy"), loaded.proxyDriver);
    let unexpectedEffects = 0;
    const noEffect = () => {
      unexpectedEffects++;
      assert.fail("historical verification must not provision credentials or a harness");
    };
    t.after(() => assert.equal(unexpectedEffects, 0));
    loaded.computeDriver.provisionAgentRuntimeCredentials = noEffect;
    protectedOwner.require("sandbox").provisionHarness = noEffect;
    const driver = loaded.repositoryRuntime.admission.policy;
    f.controller.installDriver(protectedOwner, ["sandbox", "credential_proxy"]);
    f.controller.registerDriver(gateway);
    f.controller.selectDriver("credential_gateway", gateway.id);
    // Retain the normal fixture's dedicated harness admission before recording history.
    Object.assign(f.compute, {
      normalizeHarnessOverrides: loaded.computeDriver.normalizeHarnessOverrides?.bind(
        loaded.computeDriver,
      ),
      resolveHarnessConfiguration: loaded.computeDriver.resolveHarnessConfiguration?.bind(
        loaded.computeDriver,
      ),
      admitRevision: loaded.computeDriver.admitRevision?.bind(loaded.computeDriver),
    });
    const owner = await f.agent("execution-fence", {
      executionMode: "dedicated",
      auth: "credential_source",
    });
    const bindings = [
      { repositoryRef: "team-installation", profile: "github-installation" as const },
    ];
    const { bindings: resolvedBindings } = await driver.resolveBindings({
      namespaceId: f.namespace.id,
      bindings,
    });
    const [binding] = resolvedBindings;
    assert.ok(binding);
    await f.observerPool.query("UPDATE occ.agents SET repository_bindings=$1 WHERE id=$2", [
      JSON.stringify(bindings),
      owner.id,
    ]);
    assert.ok(driver.standingApprovalScope);
    const approvalScope = await driver.standingApprovalScope({
      namespaceId: f.namespace.id,
      binding,
    });
    assert.ok(approvalScope);
    const fingerprint = repositoryApprovalFingerprint({
      namespaceId: f.namespace.id,
      agentId: owner.id,
      binding,
      scope: approvalScope,
    });
    const approval = await f.state.transact((u) =>
      u.repositorySessions.approveStanding({
        id: randomUUID(),
        namespaceId: f.namespace.id,
        agentId: owner.id,
        binding,
        scope: approvalScope,
        scopeFingerprint: fingerprint,
        approvedBy: f.actor.id,
        createdAt: new Date().toISOString(),
      }),
    );
    const revisionOptions = {
      actorId: f.actor.id,
      compute: {
        id: loaded.computeDriver.id,
        implementation: loaded.computeDriver.implementation,
      },
      protectedRepositoryDriver: protectedOwner,
      repositoryCredentials: {
        driver: { id: driver.id, implementation: driver.implementation },
        bindings: [binding],
        deadlineWallMs: Date.now() + 20_000,
        standingApprovalId: approval.id,
        standingApprovalGeneration: approval.generation,
        standingApprovalScopeFingerprint: fingerprint,
      },
    };
    const revision = await f.revision(owner, 1, revisionOptions);
    const key = { namespaceId: f.namespace.id, agentId: owner.id, revisionId: revision.id };
    await f.state.transact((u) =>
      u.agents.compareAndSetActiveRevision(key.namespaceId, key.agentId, undefined, key.revisionId),
    );
    const persisted = await f.state.read((v) =>
      v.revisions.findRevision(key.namespaceId, key.agentId, key.revisionId),
    );
    assert.ok(persisted);
    assert.deepEqual(persisted.executionAdmission, { version: 5, mode: "protected" });
    assert.deepEqual(persisted.egressPlan?.driver, protectedOwner.ref);
    assert.equal(persisted.egressPlan?.repositoryGitAuthorization, "online-request");
    assert.equal(persisted.repositoryCredentials?.bindings[0]?.profile, "github-installation");
    assert.equal((await f.currentAgent(owner))?.activeRevisionId, revision.id);
    const workspace = "historical-git";
    const sandbox = "original-sandbox";
    const executionId = revision.id;
    const sandboxId = randomUUID();
    const model = "original-model";
    const deadline = persisted.repositoryCredentials!.deadlineWallMs;
    const { client, world } = await gitExpiryGateway(t, {
      workspace,
      sandbox,
      revisionId: executionId,
      model,
      deadline,
      platformProfile: false,
    });
    const scope = {
      workspace,
      workspaceId: "workspace-id",
      sandbox,
      executionId,
      installationId: "456",
      gitOrigin: "https://github.com",
      apiOrigin: "https://api.github.com",
      binaries: [
        "/usr/bin/git",
        "/usr/lib/git-core/git-remote-https",
        "/usr/lib/git-core/git-remote-http",
        "/usr/libexec/git-core/git-remote-https",
        "/usr/libexec/git-core/git-remote-http",
        "/usr/bin/curl",
        "/usr/local/bin/node",
        "/usr/bin/node",
        "/usr/bin/gh",
        "/usr/local/bin/gh",
      ],
    };
    const definition = new OpenShellPreparedGitProvider(client, scope);
    // Use the adapter's exact profile and ownership, serialized by the stock client.
    // The controlled gateway stores public historical metadata only. No token,
    // credential worker, issuance, or runtime.prepare is involved in wire setup.
    const profile = definition["profile"];
    await client.importProviderProfile(workspace, profile, t.signal);
    const provider = await client.createProvider(
      {
        workspace,
        name: profile.id,
        type: profile.id,
        labels: profile.annotations,
        credentials: {},
      },
      t.signal,
    );
    world.id = sandboxId;
    const storedProfile = await client.getProviderProfile(workspace, profile.id, t.signal);
    assert.ok(storedProfile);
    assert.ok(provider.id);
    const generation = {
      providerId: provider.id,
      profileVersion: storedProfile.resourceVersion,
      resourceVersion: provider.resourceVersion,
      credentialState: "active" as const,
      expiresAt: new Date(deadline).toISOString(),
    };
    // Persist the original historical witness while its environment is still READY.
    // Once expiry withholds the whole environment, a cold reader cannot reconstruct it.
    const status = await client.getSandboxProviderStatus(workspace, sandbox, profile.id, t.signal);
    assert.equal(status.state, "PROVIDER_READINESS_STATE_READY");
    const desired = status.receipt?.desired;
    const report = status.observed;
    assert.ok(desired && report && status.networkInstanceId);
    const observed: OpenShellPreparedGitInstalled = {
      workspace,
      sandbox,
      sandboxId: desired.sandboxId,
      executionId,
      provider: profile.id,
      providerId: desired.providerId,
      providerResourceVersion: desired.providerResourceVersion,
      profileVersion: generation.profileVersion,
      credentialState: generation.credentialState,
      attachmentEpoch: desired.attachmentEpoch,
      providerEnvRevision: desired.providerEnvRevision,
      configRevision: desired.configRevision,
      policyHash: desired.policyHash,
      supervisorSessionId: report.sessionId,
      processInstanceId: report.processInstanceId!,
      networkInstanceId: status.networkInstanceId,
    };
    assert.equal(observed.sandboxId, sandboxId);
    const workload = "original-workload-uid";
    const continuity = { model, workload: async () => workload };
    const box = await client.getSandbox({ workspace, name: sandbox }, t.signal);
    assert.ok(box);
    const hash = await witnessOpenShellGitLaunch(client, continuity, box, observed, t.signal, {
      kind: "installation",
    });
    assert.match(hash!, /^[0-9a-f]{64}$/);
    const identity = openShellGitExecutionIdentity(observed);
    const routes = new PostgresOpenShellGitRouteStore(f.observerPool);
    const plan = persisted.egressPlan!;
    assert.ok(plan.driver);
    const bindingId = plan.execution.executionId;
    await routes.open({ ...key, workspace, sandbox, bindingId }, randomUUID());
    // Complete the initial empty bootstrap reservation, then reserve historical material.
    assert.equal(
      await routes.record(executionId, 1, {
        generation: { ...generation, credentialState: "bootstrap", expiresAt: "" },
        material: undefined,
        observed: undefined,
      }),
      true,
    );
    const material = { materialVersion: randomUUID(), preparationAttemptId: randomUUID() };
    const fence = await routes.writing(executionId, 1, "rotate", material);
    assert.ok(fence);
    assert.equal(
      await routes.record(executionId, fence, {
        generation,
        material,
        observed,
        retainedLaunchHash: hash!,
      }),
      true,
    );

    await f.state.transact((u) =>
      u.credentialSources.recordEgressInstallation({
        plan,
        sandboxId,
        sender: protectedOwner.require("credential_proxy").sourceControl.sender,
        installedAt: new Date().toISOString(),
        enforcement: {
          authorityScope: "execution",
          instanceId: "historical-enforcement",
          configurationId: plan.id,
          policyHash: observed.policyHash,
          repositoryGitRecipient: {
            providerId: observed.providerId,
            attachmentEpoch: observed.attachmentEpoch,
            processInstanceId: observed.processInstanceId,
            networkInstanceId: observed.networkInstanceId,
            authorization: "online-request",
            deliveryProfile: "github_installation",
          },
        },
      }),
    );
    await f.state.transact((u) => u.repositorySessions.recordStandingExecution(key, identity));
    await assert.rejects(
      f.state.transact((u) =>
        u.repositorySessions.recordStandingExecution(key, {
          ...identity,
          fingerprint: "0".repeat(64),
        }),
      ),
      { name: "ScopeViolationError" },
    );
    const accepted = await routes.standing(persisted);
    assert.ok(accepted, "real PostgreSQL reader must accept the historical installation");
    assert.deepEqual(accepted.route.observed, observed);
    assert.equal(accepted.executionFingerprint, identity.fingerprint);
    assert.equal(accepted.retainedLaunchHash, hash);
    const durable = async () =>
      (
        await f.observerPool.query(
          `
    SELECT row_to_json(d) AS delivery, row_to_json(e) AS execution, row_to_json(p) AS installation,
      a.active_revision_id, v.admitted_spec
    FROM occ.credential_deliveries d
    JOIN occ.repository_standing_executions e USING (namespace_id,agent_id,revision_id)
    JOIN occ.egress_installations p USING (namespace_id,agent_id,revision_id)
    JOIN occ.agents a ON a.id=d.agent_id AND a.namespace_id=d.namespace_id
    JOIN occ.agent_revisions v ON v.id=d.revision_id
    WHERE d.revision_id=$1`,
          [executionId],
        )
      ).rows;
    const baseline = await durable();
    const mutations = () => ({
      writes: world.writes,
      creates: [...world.providerCreates],
      imports: [...world.profileImports],
      detaches: [...world.detaches],
    });
    const before = mutations();
    let authorityCalls = 0;
    const noAuthority = async () => {
      authorityCalls++;
      throw new Error("cold or retiring runtime must not ask for Git authority or material");
    };
    const checks: string[] = [];
    const newOwner = () => {
      const runtime = new OpenShellGitRuntime(
        { registrationName: "oce-prepared-git", authority: {} as EgressAuthorityConfiguration },
        createGitHubRepositoryDeliveryResolver(registry),
      );
      runtime["routes"] = new PostgresOpenShellGitRouteStore(f.observerPool);
      runtime["owner"] = {
        readOpenShellMaterial: noAuthority,
        authorizeOnlineRequest: noAuthority,
      };
      runtime["emit"] = (event: Readonly<Record<string, unknown>>) => {
        if (event.event === "worker.openshell-git-expiry") {
          checks.push(event.outcome + ":" + event.check);
        }
      };
      t.after(() => runtime.close());
      return {
        runtime,
        access: openShellRepositoryAccess(runtime, () => ({
          client,
          workspace,
          sandbox,
          continuity,
        })),
      };
    };
    const { runtime: cold, access } = newOwner();
    const lookup = t.mock.method(cold, "lookup", async () => {
      throw new Error("cold identity must not perform request lookup");
    });
    assert.equal(f.namespace.status, "ready");
    const context = {
      revision: persisted,
      namespace: { ...f.namespace, status: "ready" as const },
      kubernetes: undefined,
      signal: t.signal,
    };
    const admissionExpired = async () =>
      (
        await f.observerPool.query(
          "SELECT clock_timestamp() >= to_timestamp($1::double precision / 1000) AS expired",
          [persisted.repositoryCredentials!.deadlineWallMs],
        )
      ).rows[0].expired === true;
    assert.equal(
      await admissionExpired(),
      false,
      "record the original witness within its admission",
    );
    assert.equal(cold["entries"].size, 0);
    assert.equal(await access.verifyExecution(context), undefined);
    assert.equal(cold["entries"].size, 0);
    assert.equal(authorityCalls, 0);
    assert.equal(lookup.mock.callCount(), 0);
    assert.deepEqual(await routes.standing(persisted), accepted);
    assert.deepEqual(await durable(), baseline);
    assert.deepEqual(mutations(), before);
    assert.equal(
      (await client.getSandboxProviderStatus(workspace, sandbox, model, t.signal)).state,
      "PROVIDER_READINESS_STATE_READY",
    );

    // A historical witness is still useful for cleanup, but the worker must not use it
    // to renew this retired profile. Exercise the real queue and session lifecycle while
    // the original session is inside the standing renewal window.
    const admissionId = randomUUID();
    await f.state.transact(async (u) => {
      await u.repositorySessions.createAttempt({
        ...key,
        repositoryRef: persisted.repositoryCredentials!.bindings[0]!.repositoryRef,
        admissionId,
        durationSeconds: 20,
        deadlineWallMs: deadline,
        createdAt: new Date().toISOString(),
        brokerProtocol: 2,
      });
      await u.repositorySessions.advanceAttempt({
        admissionId,
        expectedPhase: "opening",
        phase: "open",
        sessionId: randomUUID(),
        updatedAt: new Date().toISOString(),
      });
    });
    const attemptsBefore = await f.state.read((v) =>
      v.repositorySessions.listRevisionAttempts(key),
    );
    const maintenanceKey = `agent_revision:${revision.id}:maintenance:0`;
    await f.state.transactWithQueue(async (_unit, queue) => {
      const original = await queue.claim();
      assert.ok(original);
      assert.equal(original.idempotencyKey, `agent_revision:${revision.id}:reconcile`);
      await queue.complete(original, { code: "REVISION_ALREADY_ACTIVE" });
      await queue.enqueue({
        idempotencyKey: maintenanceKey,
        ...key,
        actorId: f.actor.id,
        availableAt: new Date(),
      });
    });
    let stopped: Promise<void> | undefined;
    let maintenanceCode: string | undefined;
    let preparations = 0;
    let verifications = 0;
    // Wrap only effects on the selected Compute instance. Its constructor-bound owner,
    // policy, Token Service and admission validators stay identical to the sealed runtime.
    const compute = loaded.computeDriver;
    Object.assign(compute, {
      preflight: undefined,
      setLifecycleDrivers: undefined,
      getAgentRuntimeCredentialStatus: undefined,
      async verifyRepositoryExecution() {
        verifications++;
        return access.verifyExecution(context);
      },
      async prepareRevision() {
        preparations++;
        throw new Error("historical execution cannot be prepared");
      },
      async observeRevision() {
        return { state: "running" as const };
      },
    });
    assert.equal(packageFixture.peer, undefined, "verification fixture has no bound sender");
    await f.start(compute, {
      emit(event) {
        if (event?.event === "worker.completed" && event.revisionId === revision.id && !stopped) {
          maintenanceCode = typeof event.code === "string" ? event.code : undefined;
          stopped = f.stop();
        }
      },
      transformDrivers: (d: InstallationRuntimeDrivers) => ({
        ...loaded,
        configurationDriver: d.configurationDriver,
        secretDriver: d.secretDriver,
        credentialGatewayDriver: gateway,
        installation: {
          ...loaded.installation,
          drivers: {
            ...loaded.installation.drivers,
            credential_gateway: { id: gateway.id },
          },
        },
      }),
    });
    await waitUntil("historical maintenance to finish its first pass", () => stopped !== undefined);
    await stopped;
    assert.ok(
      verifications > 0,
      `the worker must reach the real cold execution verifier: ${maintenanceCode}`,
    );
    assert.deepEqual(
      await f.state.read((v) => v.repositorySessions.listRevisionAttempts(key)),
      attemptsBefore,
      "historical evidence must not dispose its predecessor or create a successor session",
    );
    assert.equal(preparations, 0);
    assert.equal(
      packageFixture.peer,
      undefined,
      "core Worker verification must not open a sender or create delivery effects",
    );
    assert.equal(maintenanceCode, "REPOSITORY_EXECUTION_UNVERIFIED");
    const deferred = await f.state.transactWithQueue((_unit, queue) =>
      queue.findWork(maintenanceKey),
    );
    assert.equal(deferred?.state, "queued");
    assert.equal(deferred?.attemptCount, 0);
    assert.deepEqual(await durable(), baseline);
    assert.deepEqual(mutations(), before);
    assert.equal(authorityCalls, 0);

    await waitUntil("the original admission deadline on the PostgreSQL clock", admissionExpired, {
      timeoutMs: 23_000,
      intervalMs: 200,
    });
    // Stock expiration withholds the model as well as Git. The original durable witness
    // still permits later subtraction, but cannot authorize cold execution verification.
    for (const provider of [profile.id, model]) {
      const expired = await client.getSandboxProviderStatus(workspace, sandbox, provider, t.signal);
      assert.equal(expired.state, "PROVIDER_READINESS_STATE_WITHHELD");
      assert.equal(expired.reason, "PROVIDER_READINESS_REASON_CREDENTIAL_EXPIRED");
      assert.equal(expired.observed?.credentialsInstalled, false);
      assert.equal(expired.observed?.launchEnvironmentInstalled, false);
    }
    assert.equal(await access.verifyExecution(context), undefined);
    assert.equal(cold["entries"].size, 0);
    assert.deepEqual(await routes.standing(persisted), accepted);
    assert.deepEqual(await durable(), baseline);
    assert.deepEqual(mutations(), before);
    assert.equal(authorityCalls, 0);

    await f.controller.removeAgentStandingApproval(f.actor.id, {
      ...key,
      approvalId: approval.id,
      expectedGeneration: approval.generation,
    });
    assert.equal(await access.verifyExecution(context), undefined);
    // Use the guarded queue handoff the Worker makes after observing this withdrawal.
    // The fixture does not dispatch another startup for the retired profile.
    await f.advanceMaintenance(revision);
    await f.state.transactWithQueue(async (_unit, queue) => {
      const claim = await queue.claim();
      assert.ok(claim);
      assert.equal(claim.idempotencyKey, maintenanceKey);
      assert.ok(await queue.enqueueRepositoryCleanup(claim, key, "standing-withdrawal"));
      await queue.complete(claim, { code: "REPOSITORY_STANDING_APPROVAL_REMOVED" });
    });
    const reduction = async () => {
      const { rows } = await f.observerPool.query(
        `SELECT binding_id, fence, recipient, material_version, retained_policy_hash,
                request_id, expected_version, observed_generation
         FROM occ.credential_delivery_reductions WHERE revision_id=$1`,
        [executionId],
      );
      assert.equal(rows.length, 1);
      return rows[0];
    };
    const firstRetirement = await access.retireExpired(context);
    assert.equal(firstRetirement, "pending", checks.join(",") || "no retirement observer reached");
    const pending = await reduction();
    assert.ok(pending.request_id);
    assert.equal(pending.binding_id, bindingId);
    assert.equal(pending.fence, String(fence));
    assert.deepEqual(pending.recipient, observed);
    assert.equal(pending.material_version, material.materialVersion);
    assert.equal(pending.retained_policy_hash, hash);
    assert.equal(pending.expected_version, "14");
    assert.equal(pending.observed_generation, null);
    assert.deepEqual(world.detaches, [pending.request_id]);
    await cold.close();
    const { access: replacement } = newOwner();
    world.id = randomUUID();
    try {
      assert.equal(await replacement.retireExpired(context), "retire-runtime");
      assert.deepEqual(
        await reduction(),
        pending,
        "a replacement recipient cannot settle the original operation",
      );
    } finally {
      world.id = sandboxId;
    }
    const retirement = await replacement.retireExpired(context);
    assert.equal(retirement, "withdrawn", checks.join(","));
    const settled = await reduction();
    assert.ok(settled.observed_generation);
    assert.deepEqual({ ...settled, observed_generation: null }, pending);
    assert.equal(await replacement.retireExpired(context), "withdrawn");
    assert.deepEqual(await reduction(), settled);
    assert.deepEqual(mutations(), { ...before, detaches: [pending.request_id] });
    assert.equal(await replacement.verifyExecution(context), undefined);
    assert.equal(authorityCalls, 0);
    assert.equal((await f.currentAgent(owner))?.activeRevisionId, revision.id);
    const reduced = await client.getSandbox({ workspace, name: sandbox }, t.signal);
    assert.ok(reduced);
    assert.equal(reduced.id, sandboxId);
    assert.equal(
      (await client.getSandboxProviderStatus(workspace, sandbox, model, t.signal)).state,
      "PROVIDER_READINESS_STATE_READY",
    );
    assert.equal(
      (await client.getSandboxProviderStatus(workspace, sandbox, profile.id, t.signal)).state,
      "PROVIDER_READINESS_STATE_REVOKED",
    );
  },
);
