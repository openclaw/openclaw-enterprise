import { RequestCredentialWorkBusyError } from "../../packages/occ/src/errors.ts";
import assert from "node:assert/strict";
import { sandboxNamespaceLifecycleBinding } from "../../apps/controller/src/composition/namespace-lifecycle.ts";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { TestContext } from "node:test";
import type {
  Agent,
  Namespace,
  SecretReference,
  SecretDriver,
  CredentialProxyDriver,
  CredentialSourceMetadata,
  EgressInstallation,
  RequestCredentialInput,
} from "../../packages/contracts/src/index.ts";
import {
  InstalledDriver,
  resolveCredentialProxyCapacity,
  OpenClawController,
  PostgresCommitOutcomeUnknownError,
  PostgresPlatformState,
  type PlatformStateStore,
  type PlatformUnitOfWork,
  type ControllerOptions,
  type CredentialProxyCapacity,
} from "../../packages/occ/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  createOpenAiRequestProvider,
  createOpenAiStaticProvider,
} from "../../apps/controller/src/drivers/egress-proxy/openai-provider.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { staticEgressFixture } from "./static-egress.mjs";
import { postgresApp } from "./postgres-egress-app.mjs";

/** Real API/IAM/PostgreSQL/Secret Driver with controlled external runtime observation.
 * No installed OpenShell or workload execution is represented by this fixture. */
export async function requestCredentialFixture(
  t: TestContext,
  configuration: {
    activateRevision?: boolean;
    credentialProxyCapacity?: Partial<CredentialProxyCapacity>;
    poolOptions?: { options: string };
    bindExchange?: CredentialProxyDriver["bindExchange"];
    verifyAdmissionPolicy?: boolean;
    retainStrictBeforePolicy?: boolean;
    includeLegacy?: boolean;
  } = {},
) {
  let owner!: InstalledDriver;
  let principalId!: string;
  let state!: PlatformStateStore;
  let pool!: Awaited<ReturnType<typeof postgresApp>>["pool"];
  let retainedStrict: CredentialSourceMetadata | undefined;
  let live: EgressInstallation | undefined;
  let nextVerification: { reached: () => void; release: Promise<void> } | undefined;
  const sandboxId = randomUUID();
  const {
    activateRevision,
    credentialProxyCapacity,
    verifyAdmissionPolicy,
    retainStrictBeforePolicy,
    ...fixtureOptions
  } = configuration;
  const { capacity } = resolveCredentialProxyCapacity(
    credentialProxyCapacity ?? {},
    "requestCapacity",
  );
  assert.ok(capacity);
  const options = {
    ...fixtureOptions,
    ...(credentialProxyCapacity && { credentialProxyCapacity: capacity }),
    admitRevision: false,
    driverConfigurations: [
      ...["request-policy-fixture", "request-policy-previous"].map((driverId) => ({
        capability: "sandbox" as const,
        driverId,
        implementation: "request-policy-fixture",
        definition: OpenShellSandboxDriver,
      })),
    ],
    appFactory: async (context: TestContext, options: object = {}) => {
      const app = await postgresApp(context, {
        ...options,
        recordOperations: true,
        poolOptions: configuration.poolOptions,
      });
      state = app.state;
      pool = app.pool;
      principalId = app.principal.id;
      return app;
    },
    async admitSource({
      app,
      agent,
      namespace,
      secret,
      path,
      origin,
    }: {
      app: Awaited<ReturnType<typeof postgresApp>>;
      agent: Agent;
      namespace: Namespace;
      secret: { ref: SecretReference };
      path: string;
      origin: string;
    }) {
      const original = app.controller.selectedDriver("credential_proxy");
      const sandbox = new Proxy(app.controller.selectedDriver("sandbox"), {
        get(target, key) {
          if (key === "id" || key === "implementation") {
            return "request-policy-fixture";
          }
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      // This fixture supplies only the external installation/recipient observation.
      // Production provider classification, IAM, approval persistence and Secret reads run below.
      const providers = [createOpenAiRequestProvider(), ...original.sourceControl.providers];
      const proxy: CredentialProxyDriver = {
        id: "request-policy-fixture",
        implementation: "request-policy-fixture",
        capability: "credential_proxy",
        ...(configuration.bindExchange && { bindExchange: configuration.bindExchange }),
        sourceControl: {
          ...original.sourceControl,
          providers,
        },
        requestTimeCredentials: {
          async assertAvailable(signal) {
            assert.equal(signal.aborted, false);
          },
          async verifyRequestInstallation(
            { namespace: ns, revision, plan },
            installation,
            recipient,
          ) {
            const paused = nextVerification;
            nextVerification = undefined;
            paused?.reached();
            await paused?.release;
            return (
              live !== undefined &&
              recipient.id === live.sandboxId &&
              ns.id === live.plan.execution.namespaceId &&
              revision.id === live.plan.execution.revisionId &&
              isDeepStrictEqual(plan, live.plan) &&
              isDeepStrictEqual(installation, live)
            );
          },
        },
        async configureRevision(context) {
          return { plan: context.plan, configuration: {} };
        },
        async wiringStatus() {
          return live;
        },
        async verifyInstallation(context, installation) {
          return (
            isDeepStrictEqual(context.plan, live?.plan) && isDeepStrictEqual(installation, live)
          );
        },
        async removeRevision() {
          return false;
        },
      };
      const registration = {
        capabilities: { sandbox, credential_proxy: proxy },
        namespaceLifecycleHooks: sandboxNamespaceLifecycleBinding(
          app.controller.selectedDriver("compute"),
          sandbox,
        ).hooks,
      };
      if (verifyAdmissionPolicy && retainStrictBeforePolicy) {
        // Admit a strict source before changing only the Installation's policy for new sources.
        const previousProxy = {
          ...proxy,
          id: "request-policy-previous",
          sourceControl: {
            ...proxy.sourceControl,
            providers: [
              createOpenAiStaticProvider(),
              { ...createOpenAiStaticProvider(), ref: { id: "external-second", generation: 1 } },
            ],
          },
        };
        const previousSandbox = new Proxy(sandbox, {
          get(target, key) {
            return key === "id" ? "request-policy-previous" : Reflect.get(target, key);
          },
        });
        const previous = new InstalledDriver(
          { id: previousProxy.id, implementation: proxy.implementation, configuration: {} },
          {
            capabilities: { sandbox: previousSandbox, credential_proxy: previousProxy },
            namespaceLifecycleHooks: sandboxNamespaceLifecycleBinding(
              app.controller.selectedDriver("compute"),
              previousSandbox,
            ).hooks,
          },
        );
        app.controller.installDriver(previous, ["sandbox", "credential_proxy"]);
        const created = await app.request("POST", path, {
          body: {
            name: "retained-strict-model",
            type: "openai",
            config: { authorized_base_url: `${origin}/v1` },
            secrets: { api_key: secret.ref },
          },
        });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        retainedStrict = created.data;
        const stored = await state.read((unit) =>
          unit.credentialSources.findCredentialSource(namespace.id, created.data.id),
        );
        assert.deepEqual(
          stored?.egress?.key.provider,
          createOpenAiStaticProvider().ref,
          "external Drivers retain the first distinct strict provider in catalog order",
        );
      }
      owner = new InstalledDriver(
        {
          id: proxy.id,
          implementation: proxy.implementation,
          configuration: {},
          retiredStaticProviderRefs: [createOpenAiStaticProvider().ref],
        },
        registration,
      );
      if (verifyAdmissionPolicy) {
        const beforeDefault = new InstalledDriver(
          { id: proxy.id, implementation: proxy.implementation, configuration: {} },
          registration,
        );
        assert.deepEqual(
          owner.ref,
          beforeDefault.ref,
          "new-source policy preserves retained Driver references",
        );
      }
      app.controller.installDriver(owner, ["sandbox", "credential_proxy"]);
      if (verifyAdmissionPolicy) {
        const catalog = () => app.request("GET", `/namespaces/${namespace.id}/agent-capabilities`);
        const offered = (response: Awaited<ReturnType<typeof catalog>>) =>
          response.data?.capabilities?.credentialSources?.types?.some(
            (entry: { type: string }) => entry.type === "openai",
          );
        const initial = await catalog();
        assert.equal(initial.status, 200, JSON.stringify(initial.body));
        assert.equal(
          offered(initial),
          true,
          "the regular capability catalog offers the selected model type",
        );

        // A stale or ambiguous provider choice must fail before reading material or creating a row.
        const secretDriver = app.controller.selectedDriver("secret");
        const read = secretDriver.readCredentialInput!;
        let reads = 0;
        secretDriver.readCredentialInput = async (input) => {
          reads++;
          return Reflect.apply(read, secretDriver, [input]);
        };
        const refused = async (name: string, unavailableInCatalog = true) => {
          assert.equal(offered(await catalog()), !unavailableInCatalog);
          const response = await app.request("POST", path, {
            body: {
              name,
              type: "openai",
              config: { authorized_base_url: `${origin}/v1` },
              secrets: { api_key: secret.ref },
            },
          });
          assert.ok(
            response.status === 409 || response.status === 503,
            JSON.stringify(response.body),
          );
          assert.equal(reads, 0);
          const rows = await pool.query(
            "SELECT id FROM occ.credential_sources WHERE namespace_id=$1 AND name=$2",
            [namespace.id, name],
          );
          assert.equal(rows.rowCount, 0);
        };
        const rejected = await app.request("POST", path, {
          body: {
            name: "removed-authorization-field",
            type: "openai",
            authorization: "online-request",
            config: { authorized_base_url: `${origin}/v1` },
            secrets: { api_key: secret.ref },
          },
        });
        assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
        assert.equal(reads, 0);
        const rejectedRows = await pool.query(
          "SELECT id FROM occ.credential_sources WHERE namespace_id=$1 AND name=$2",
          [namespace.id, "removed-authorization-field"],
        );
        assert.equal(rejectedRows.rowCount, 0);
        const requestProvider = providers.shift()!;
        await refused("missing-provider");
        providers.unshift(requestProvider);
        const requestTime = proxy.requestTimeCredentials;
        Reflect.set(proxy, "requestTimeCredentials", undefined);
        await refused("unavailable-default");
        Reflect.set(proxy, "requestTimeCredentials", requestTime);
        providers.push(createOpenAiRequestProvider());
        await refused("ambiguous-default");
        providers.pop();
        // Removing the retired registration cannot disable the owner's stable policy.
        // A second eligible provider appearing during availability observation must stop admission.
        const strictIndex = providers.findIndex(
          (entry) => entry.ref.id === createOpenAiStaticProvider().ref.id,
        );
        const [strictProvider] = providers.splice(strictIndex, 1);
        const available = proxy.requestTimeCredentials!.assertAvailable;
        proxy.requestTimeCredentials!.assertAvailable = async () => {
          providers.push(createOpenAiRequestProvider());
        };
        await refused("provider-race", false);
        providers.pop();
        providers.splice(strictIndex, 0, strictProvider!);
        proxy.requestTimeCredentials!.assertAvailable = available;
        secretDriver.readCredentialInput = read;
      }
      const response = await app.request("POST", path, {
        body: {
          name: "request-protected-model",
          type: "openai",
          config: { authorized_base_url: `${origin}/v1` },
          secrets: { api_key: secret.ref },
        },
      });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      const source = response.data;
      // An update retains the exact admitted provider instead of selecting by catalog order.
      const updated = await app.request("PATCH", `${path}/${source.id}`, {
        body: { secrets: { api_key: secret.ref } },
      });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      const stored = await state.read((unit) =>
        unit.credentialSources.findCredentialSource(namespace.id, source.id),
      );
      assert.deepEqual(stored?.egress?.key.provider, createOpenAiRequestProvider().ref);
      const result = await app.request("PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`, {
        body: {
          configurationId: agent.configurationId,
          harnessAuth: { method: "credential_source", sourceId: source.id },
          credentialSources: [{ sourceId: source.id }],
        },
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return { agent: result.data, source };
    },
  };
  const f = Object.assign(await staticEgressFixture(t, options), { pool });
  assert.ok("pauseNextSecretRead" in f);
  let materialPause:
    | {
        skip: number;
        reached: () => void;
        release: Promise<void>;
        settled: () => void;
      }
    | undefined;
  const secretDriver: SecretDriver = f.controller.selectedDriver("secret");
  const readMaterial = secretDriver.readCredentialInput!.bind(secretDriver);
  // Preserve the real Secret Driver's result while modeling a dependency that ignores
  // cancellation after its I/O. The controller must still release its policy locks.
  secretDriver.readCredentialInput = async (input) => {
    const result = await readMaterial(input);
    const paused = materialPause;
    if (paused && paused.skip-- === 0) {
      materialPause = undefined;
      paused.reached();
      await paused.release;
      paused.settled();
    }
    return result;
  };
  const deployment = await f.deployAgent(f.namespace.id, f.agent.id);
  const revision = await state.read((unit) =>
    unit.revisions.findRevision(f.namespace.id, f.agent.id, deployment.id),
  );
  assert.ok(revision?.egressPlan);
  assert.deepEqual(revision.executionAdmission, { mode: "protected", version: 8 });
  assert.equal(revision.egressPlan.authorization, "online-request");
  assert.deepEqual(revision.egressPlan.driver, owner.ref);
  assert.equal(revision.egressPlan.routes.length, 1);
  const route = revision.egressPlan.routes[0]!;
  live = {
    plan: revision.egressPlan,
    sandboxId,
    sender: owner.require("credential_proxy").sourceControl.sender,
    installedAt: new Date().toISOString(),
    enforcement: {
      instanceId: randomUUID(),
      configurationId: "request-policy",
      policyHash: "a".repeat(64),
      authorityScope: "execution",
    },
  };
  await state.transact((unit) => unit.credentialSources.recordEgressInstallation(live!));
  if (activateRevision !== false) {
    await f.activateRevision(f.namespace.id, f.agent.id, revision.id);
  }
  const transport = {
    async verify() {
      return undefined;
    },
    capture() {
      return undefined;
    },
    owns() {
      return false;
    },
  };
  const controller: OpenClawController = f.controller;
  const exchange = controller.createCredentialProxy(transport);
  const request = (): RequestCredentialInput => ({
    requestId: randomUUID(),
    bindingId: route.binding.binding.id,
    recipient: { id: sandboxId },
    deadlineAt: new Date(Date.now() + 20_000).toISOString(),
    replayUntilAt: new Date(Date.now() + 3_600_000).toISOString(),
    execution: { namespaceId: f.namespace.id, agentId: f.agent.id, revisionId: revision.id },
    http: {
      target: {
        reportedScheme: "https",
        host: new URL(route.origin).hostname,
        port: Number(new URL(route.origin).port || 443),
        method: "POST",
        path: route.path,
        query: "",
      },
      headers: [["content-type", "application/json"]],
      body: Buffer.from(JSON.stringify({ model: "fixture-model", input: "hello", store: false })),
    },
  });
  const grant = (input: RequestCredentialInput) => ({
    recipientId: input.recipient.id,
    requestId: input.requestId,
    bindingId: input.bindingId,
    deadlineAt: input.deadlineAt,
  });
  const restartController = (
    credentialProxyCapacity = configuration.credentialProxyCapacity,
    authorize?: ControllerOptions["authorize"],
    pool = f.pool,
    now?: ControllerOptions["now"],
  ) => {
    const capacity = resolveCredentialProxyCapacity(
      { ...credentialProxyCapacity },
      "requestCapacity",
    );
    assert.ok(capacity.capacity);
    const restartedState = new PostgresPlatformState(pool);
    const restarted = new OpenClawController(f.controller.installation, {
      state: restartedState,
      ...(authorize && { authorize }),
      ...(now && { now }),
      driverConfigurations: options.driverConfigurations,
      credentialProxyCapacity: capacity.capacity,
    });
    const iam = new NativeIAMDriver(restartedState, { id: "request-restarted-iam" });
    restarted.registerDriver(iam);
    restarted.selectDriver("iam", iam.id);
    for (const capability of [
      "compute",
      "configuration",
      "secret",
      "credential_gateway",
    ] as const) {
      const driver = f.controller.selectedDriver(capability);
      restarted.registerDriver(driver);
      restarted.selectDriver(capability, driver.id);
    }
    restarted.installDriver(owner, ["sandbox", "credential_proxy"]);
    return restarted;
  };
  const pauseMaterialRead = (skip = 0) => {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    materialPause = {
      skip,
      reached: reached.resolve,
      release: release.promise,
      settled: settled.resolve,
    };
    return { reached: reached.promise, release: release.resolve, settled: settled.promise };
  };
  return {
    f,
    owner,
    retainedStrict,
    revision,
    exchange,
    request,
    grant,
    restartController,
    principalId,
    pauseCandidateWorkRetry() {
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const policyState = state;
      assert.ok(policyState instanceof PostgresPlatformState);
      const original = policyState.transactReadCommitted.bind(policyState);
      policyState.transactReadCommitted = async <T>(
        work: (unit: PlatformUnitOfWork) => Promise<T>,
      ) => {
        try {
          return await original(work);
        } catch (error) {
          if (error instanceof RequestCredentialWorkBusyError) {
            policyState.transactReadCommitted = original;
            reached.resolve();
            await release.promise;
          }
          throw error;
        }
      };
      return {
        reached: reached.promise,
        release() {
          policyState.transactReadCommitted = original;
          release.resolve();
        },
      };
    },
    pauseNextApprovalCommit(stage: "before" | "after" | "busy" | "activation-unknown" = "before") {
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const policyState = state;
      assert.ok(policyState instanceof PostgresPlatformState);
      const original = policyState.transactReadCommitted.bind(policyState);
      let pending = true;
      policyState.transactReadCommitted = async (work) => {
        let reserved = false;
        const result = await original((unit) =>
          work({
            ...unit,
            requestCredentialApprovals: {
              ...unit.requestCredentialApprovals,
              async insert(...args) {
                const inserted = await unit.requestCredentialApprovals.insert(...args);
                if (pending && inserted === "busy" && stage === "busy") {
                  pending = false;
                  reserved = true;
                }
                if (
                  pending &&
                  inserted === "reserved" &&
                  (stage === "before" || stage === "after")
                ) {
                  pending = false;
                  if (stage === "before") {
                    reached.resolve();
                    await release.promise;
                  } else {
                    reserved = true;
                  }
                }
                return inserted;
              },
              async approve(...args) {
                const approval = await unit.requestCredentialApprovals.approve(...args);
                if (pending && approval && stage === "activation-unknown") {
                  pending = false;
                  reserved = true;
                }
                return approval;
              },
            },
          }),
        );
        if (reserved) {
          reached.resolve();
          await release.promise;
          if (stage === "activation-unknown") {
            throw new PostgresCommitOutcomeUnknownError();
          }
        }
        return result;
      };
      return { reached: reached.promise, release: release.resolve };
    },
    pauseFinalPolicyLock() {
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let checks = 0;
      const policyState = state;
      assert.ok(policyState instanceof PostgresPlatformState);
      for (const method of ["transact", "transactReadCommitted"] as const) {
        const original = policyState[method].bind(policyState);
        policyState[method] = (work) =>
          original((unit) =>
            work({
              ...unit,
              namespaces: {
                ...unit.namespaces,
                async lockNamespace(...args) {
                  // Both real transactions have established their snapshot before this lock.
                  if (++checks === 2) {
                    reached.resolve();
                    await release.promise;
                  }
                  return unit.namespaces.lockNamespace(...args);
                },
              },
            }),
          );
      }
      return { reached: reached.promise, release: release.resolve };
    },
    pauseNextSourceReady() {
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const policyState = state;
      assert.ok(policyState instanceof PostgresPlatformState);
      const original = policyState.transact.bind(policyState);
      let pending = true;
      policyState.transact = (work) =>
        original((unit) =>
          work({
            ...unit,
            credentialSources: {
              ...unit.credentialSources,
              async markCredentialSourceReady(...args) {
                const ready = await unit.credentialSources.markCredentialSourceReady(...args);
                if (pending && ready) {
                  pending = false;
                  reached.resolve();
                  await release.promise;
                }
                return ready;
              },
            },
          }),
        );
      return {
        reached: reached.promise,
        release() {
          policyState.transact = original;
          release.resolve();
        },
      };
    },
    pauseMaterialRead,
    pauseFinalMaterialRead() {
      return pauseMaterialRead(2);
    },
    pauseNextVerification() {
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      nextVerification = { reached: reached.resolve, release: release.promise };
      return { reached: reached.promise, release: release.resolve };
    },
    get installation() {
      return live!;
    },
    setInstallation(value: EgressInstallation) {
      live = value;
    },
  };
}
