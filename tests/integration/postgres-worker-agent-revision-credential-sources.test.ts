import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after } from "node:test";
import type { ComputeDriver } from "../../packages/contracts/src/index.ts";
import { OpenClawController, PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { installationControllerOptions } from "../../apps/controller/src/composition/installation-config.ts";
import { installSelectedSandboxDrivers } from "../../apps/controller/src/composition/sandbox-drivers.ts";
import { installTokenServiceDriver } from "../../apps/controller/src/composition/token-service.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { useInstallationSecretDriver } from "../helpers/kubernetes-secret-core.mjs";
import { auditEvent } from "./postgres-namespace-iam-fixture.ts";
import { buildSandboxInstallation } from "./sandbox-driver-installation-fixture.ts";
import {
  createCredentialSourceRevisionCases,
  removeSourceGrant,
} from "./postgres-worker-credential-scenarios.ts";
import { registerWithdrawalCases } from "./postgres-worker-withdrawal-cases.ts";
import { registerDeploymentWithdrawalCases } from "./postgres-worker-deployment-withdrawal-cases.ts";
import { registerWithdrawalMaintenanceCases } from "./postgres-worker-withdrawal-maintenance-cases.ts";
import { registerFiniteGitCases } from "./postgres-worker-finite-git-cases.ts";

// The lane prepares one migrated template for this entry. Every case clones it
// through the shared fixture and the process owns its teardown backstop.
const cases = createCredentialSourceRevisionCases(import.meta.url);
after(cases.cleanup);

registerWithdrawalCases(cases);
registerDeploymentWithdrawalCases(cases);
registerWithdrawalMaintenanceCases(cases);
registerFiniteGitCases(import.meta.url);

cases.revisionTest(
  "standalone activation rechecks the Agent's exact source grant after committing the active revision",
  async (fixture, context) => {
    const grant = {
      id: "model-egress",
      binary: "/app/bin/model-client",
      host: "api.openai.com",
      ports: [{ from: 443, to: 443 }],
    };
    const installation = buildSandboxInstallation();
    Reflect.deleteProperty(installation.drivers, "credential_gateway");
    Reflect.deleteProperty(installation.backend[0]!.drivers, "credential_gateway");
    Object.assign(installation.drivers, { token_service: { id: "occ", configuration: {} } });
    installation.drivers.compute.id = fixture.compute.id;
    const baseline = installation.drivers.sandbox.configuration.policy.networkPolicies[0]!;
    baseline.name = "baseline";
    baseline.endpoints[0]!.host = "baseline.example.test";
    const runtime = await loadInstallationFile(context, installation);
    assert.ok(runtime?.credentialDeliveryRegistration && runtime.sandboxDriver);
    const registration = runtime.credentialDeliveryRegistration;
    const sandbox = registration.require("sandbox");
    // The recipient and Compute are controlled dependencies. This tests Worker authorization;
    // it does not qualify a native process, proxy transfer, or runtime enforcement.
    Object.assign(sandbox, {
      credentialDeployment() {
        throw new Error("the authorization test must not configure a recipient");
      },
    });
    let activations = 0;
    const compute: ComputeDriver = {
      ...fixture.compute,
      resolveHarnessConfiguration: () => ({
        modelProvider: { protocol: "openai-responses", baseUrl: "https://api.openai.com/v1" },
      }),
      validateExecutionAdmission() {},
      async activateRevision() {
        activations += 1;
      },
    };
    const controller = new OpenClawController(fixture.installation, {
      state: fixture.state,
      ...installationControllerOptions(runtime.installation),
      nativeWorkerSupport: "custom-image",
      sandboxNetworkPolicyCeiling: [grant],
      namespaceLifecycleBindings: runtime.namespaceLifecycleBindings,
      backends: runtime.installation.backend,
      recordOperations: true,
      credentialDeploymentCapabilities: () => ({
        binary: grant.binary,
        sandbox: { wildcards: false, portRanges: false, supportsNetworkPolicy: () => true },
        proxy: {
          distinguishesExecutable: true,
          distinguishesPort: true,
          rejectsStaleAndMisplacedPlaceholders: true,
          supportsBindingRequest: () => true,
        },
      }),
    });
    for (const capability of ["iam", "configuration"] as const) {
      const selected = fixture.controller.selectedDriver(capability);
      controller.registerDriver(selected);
      controller.selectDriver(capability, selected.id);
    }
    controller.registerDriver(compute);
    controller.selectDriver("compute", compute.id);
    installSelectedSandboxDrivers(controller, runtime);
    const { driver: secretDriver } = useInstallationSecretDriver(controller);
    await installTokenServiceDriver(controller, {
      installation: runtime.installation,
      secretDriver,
    });
    const namespaceId = fixture.namespace.id;
    const actorId = fixture.actor.id;
    const source = await controller.createManagedCredentialSource(
      actorId,
      namespaceId,
      {
        name: `Activation source ${randomUUID()}`,
        lifecycleConfig: { type: "static", settings: {} },
        secret: { opaque: randomUUID() },
        providerPreset: "openai",
      },
      (ref, phase) => ({
        ...auditEvent(
          fixture.installation.id,
          namespaceId,
          actorId,
          phase
            ? "openclaw.credential_sources.create.started"
            : "openclaw.credential_sources.create",
          ref,
        ),
        ...(phase ? { details: { phase } } : {}),
      }),
    );
    const configuration = await controller.createConfiguration(actorId, {
      namespaceId,
      kind: "agent",
      values: createHarnessConfiguration("openclaw", "gpt-4.1"),
    });
    const owner = await controller.createAgent(
      actorId,
      {
        namespaceId,
        name: `Activation race ${randomUUID()}`,
        configurationId: configuration.id,
        executionMode: "dedicated",
        harnessAuth: { method: "credential_source", sourceId: source.id },
        credentialSources: [{ sourceId: source.id }],
      },
      resolveApprovedHarness,
    );
    await controller.TEMPORARY_API_WILL_BREAK_IN_FUTURE_setAgentSandboxPolicyEditing(
      actorId,
      namespaceId,
      owner.id,
      "networking",
      true,
    );
    await controller.updateAgentSandboxPolicy(actorId, namespaceId, owner.id, "networking", 1, [
      grant,
    ]);

    await fixture.start(compute, {
      transformDrivers: (drivers) => ({
        ...drivers,
        installation: {
          ...runtime.installation,
          drivers: {
            ...runtime.installation.drivers,
            secret: { ...runtime.installation.drivers.secret, id: secretDriver.id },
          },
        },
        secretDriver,
        namespaceLifecycleBindings: runtime.namespaceLifecycleBindings,
        credentialDeliveryRegistration: registration,
        sandboxDriver: sandbox,
        resolveCredentialDeploymentContext: async () => {
          throw new Error("the authorization test must not resolve a recipient");
        },
      }),
    });
    const worker: unknown = [...fixture.database.workers].at(-1);
    assert.ok(
      typeof worker === "object" &&
        worker !== null &&
        "state" in worker &&
        worker.state instanceof PostgresPlatformState,
    );
    const transactWithQueue = worker.state.transactWithQueue.bind(worker.state);
    let revoked = false;
    worker.state.transactWithQueue = async (work, options) => {
      const result = await transactWithQueue(work, options);
      // Revoke only after PostgreSQL committed the candidate's active pointer, before the
      // same Worker pass resumes activation. This is the actual race window.
      if (!revoked && (await fixture.currentAgent(owner))?.activeRevisionId !== undefined) {
        revoked = true;
        await removeSourceGrant(fixture, owner, source.id);
      }
      return result;
    };
    const revision = await controller.deployAgent(
      actorId,
      { namespaceId, agentId: owner.id },
      resolveApprovedHarness,
    );
    assert.equal(revision.executionAdmission.version, 8);
    const work = { id: revision.id, idempotencyKey: `agent_revision:${revision.id}:reconcile` };
    await fixture.work(work, "failed_permanent");
    assert.equal(revoked, true, "the exact binding was deleted after the active pointer commit");
    assert.equal(activations, 0);
    assert.equal((await fixture.workResult(work)).rows[0]?.reason_code, "AUTHORIZATION_DENIED");
    const audit = await fixture.observerPool.query(
      `SELECT kind, actor_id, outcome,
        details->'__occAuditMetadata'->'authorization' AS authorization,
        details->'__occAuditMetadata'->>'reasonCode' AS reason_code
       FROM occ.audit_events WHERE namespace_id=$1 AND resource_id=$2 AND kind='authorization_denial'`,
      [namespaceId, owner.id],
    );
    assert.deepEqual(audit.rows, [
      {
        kind: "authorization_denial",
        actor_id: actorId,
        outcome: "denied",
        authorization: {
          principalId: owner.servicePrincipalId,
          action: "operate",
          resource: { kind: "credential_source", namespaceId, id: source.id },
        },
        reason_code: "AUTHORIZATION_DENIED",
      },
    ]);
  },
);
