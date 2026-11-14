import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import type {
  CredentialProxyDriver,
  Driver,
  DriverImplementation,
  ProtectedDownloadDestination,
  ProtectedDownloadEdit,
  ProtectedDownloadPolicyContext,
  ProtectedDownloadPolicyFence,
  ProtectedDownloadPolicyWrite,
  SandboxPolicyViewWire,
  SandboxDriver,
} from "../../packages/contracts/src/index.ts";
import {
  SandboxPolicyViewResponse,
  SandboxPolicyResponse,
} from "../../packages/contracts/src/api/sandbox-policy.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { KubernetesConfigurationDriver } from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import { KubernetesSecretDriver } from "../../apps/controller/src/drivers/secret/kubernetes/index.ts";
import { createFixtureResponse } from "../helpers/console-fixture-response.ts";
import type {
  DriverConfigurationRegistration,
  NamespaceLifecycleBinding,
} from "../../packages/occ/src/index.ts";
import type { ProtectedDownloadRecovery } from "../../packages/occ/src/state/platform-state.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { PostgresWorkQueue, protectedDownloadLimitsHash } from "../../packages/occ/src/index.ts";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import { postgresApp } from "../helpers/postgres-egress-app.mjs";
import { staticEgressFixture } from "../helpers/static-egress.mjs";
import { waitFor } from "../helpers/wait-for.mjs";

type AppFactory = NonNullable<NonNullable<Parameters<typeof staticEgressFixture>[1]>["appFactory"]>;
type AppOptions = NonNullable<Parameters<AppFactory>[1]> & {
  driverConfigurations?: readonly DriverConfigurationRegistration[];
  namespaceLifecycleBindings?: readonly NamespaceLifecycleBinding[];
};

function requireRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
}

function selected(driver: Driver, definition: DriverImplementation) {
  return { id: driver.id, implementation: driver.implementation, configuration: {}, definition };
}

test(
  "protected download edits reconcile late writes on the running revision and across a verified replacement",
  requiresPostgres,
  async (t) => {
    const protectedDownloads = { executablePaths: ["/usr/bin/curl"] };
    let registrations: readonly DriverConfigurationRegistration[] | undefined;
    let namespaceLifecycleBindings: readonly NamespaceLifecycleBinding[] | undefined;
    const f = await staticEgressFixture(t, {
      appFactory: (context, options?: AppOptions) => {
        assert.ok(options);
        registrations = options.driverConfigurations;
        namespaceLifecycleBindings = options.namespaceLifecycleBindings;
        return postgresApp(context, { ...options, recordOperations: true, protectedDownloads });
      },
    });
    assert.ok("pool" in f && f.fixtureKind === "deployed");
    assert.equal((await f.pool.query("SELECT current_user")).rows[0].current_user, "occ_app");
    const sandboxConfiguration = registrations?.find((entry) => entry.capability === "sandbox");
    assert.ok(sandboxConfiguration);
    assert.ok(namespaceLifecycleBindings?.length);
    const bindings = namespaceLifecycleBindings;
    const responseData = createFixtureResponse(f.app.getSchemas());
    const base = `/namespaces/${f.namespace.id}/agents/${f.agent.id}/sandbox-policy/networking`;
    const destination = {
      scheme: "https",
      host: "toolchains.example.org",
      port: 443,
    } satisfies ProtectedDownloadDestination;
    const earlierDestination = { ...destination, host: "artifacts.example.org" };
    const uncertainDestination = { ...destination, host: "unconfirmed.example.org" };
    const original: unknown = structuredClone(f.attachment.configuration);
    requireRecord(original);
    requireRecord(original.network_policies);
    let source = { ...original, network_policies: original.network_policies };
    assert.ok(Object.keys(source.network_policies).length > 0);
    assert.ok(!JSON.stringify(source).includes(destination.host));
    const metadata = await f.deployAgent(f.namespace.id, f.agent.id);
    const replacement = await f.state.read((unit) =>
      unit.revisions.findRevision(f.namespace.id, f.agent.id, metadata.id),
    );
    assert.ok(replacement?.egressPlan);
    assert.notEqual(replacement.id, f.revision.id);
    const replacementContext = {
      ...f.context,
      revision: replacement,
      plan: replacement.egressPlan,
    };
    const routes = await f.egress.configureRevision(replacementContext);
    const attachment = { ...routes, configuration: { ...source, ...routes.configuration } };
    const sandboxId = randomUUID();
    const observed: unknown = f.observed;
    requireRecord(observed);
    const sandbox = observed.sandbox;
    requireRecord(sandbox);
    requireRecord(sandbox.annotations);
    requireRecord(observed.evidence);
    requireRecord(observed.observation);
    const replacementPolicy = structuredClone(attachment.configuration);
    const publicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x;
    assert.ok(publicKey);
    Object.assign(f.observed, {
      sandbox: {
        ...sandbox,
        id: sandboxId,
        name: f.sandboxDriver.harnessResource(replacementContext).resourceName,
        annotations: {
          ...sandbox.annotations,
          "openclaw.dev/revision-id": replacement.id,
        },
      },
      evidence: {
        ...observed.evidence,
        sandbox_id: sandboxId,
        instance_id: randomUUID(),
      },
      policy: replacementPolicy,
      observation: {
        ...observed.observation,
        effective_policy: replacementPolicy,
        registered_exchange_public_key: Buffer.from(publicKey, "base64url"),
      },
    });
    const replacementInstallation = await f.egress.wiringStatus(replacementContext, attachment);
    assert.ok(replacementInstallation);
    await f.state.transact((unit) =>
      unit.credentialSources.recordEgressInstallation(replacementInstallation),
    );
    assert.equal(
      (await f.state.read((unit) => unit.agents.findAgent(f.namespace.id, f.agent.id)))
        ?.activeRevisionId,
      f.revision.id,
    );
    let activeRevision: ProtectedDownloadPolicyContext["revision"] = f.revision;
    let hideConfirmation = false;
    let oldEvidence:
      { fence: ProtectedDownloadPolicyFence; receipt: ProtectedDownloadPolicyWrite } | undefined;
    const writes: { revisionId: string; operationId: string; sandboxId: string }[] = [];
    let enabled: readonly ProtectedDownloadDestination[] = [];
    let operationId: string | undefined;
    let revokeBeforeApply: (() => Promise<unknown>) | undefined;
    let receipt: ProtectedDownloadPolicyWrite | undefined;
    let lateReceipt: "missing" | "mismatched" | "available" | undefined;
    let mismatchLateProxyFence = false;
    const lateReceiptChecks = new Set<string>();
    assert.ok(f.installation.enforcement.peerKeyId);
    assert.ok(typeof observed.policyHash === "string");
    let fence: ProtectedDownloadPolicyFence = {
      sandboxId: f.installation.sandboxId,
      peer: { keyId: f.installation.enforcement.peerKeyId },
      installationLimitsHash: protectedDownloadLimitsHash(protectedDownloads),
      instanceId: f.installation.enforcement.instanceId,
      configurationId: f.installation.enforcement.configurationId,
      effectivePolicyHash: f.installation.enforcement.policyHash,
      sourcePolicyHash: observed.policyHash,
      providerResourceVersion: "1",
      policyVersion: f.revision.egressPlan.generation,
    };
    // The controlled provider retains the installed source and models only its mutable
    // download rules. PostgreSQL, IAM, queue settlement and the Console-facing API are real.
    const sourceFor = (destinations: readonly ProtectedDownloadDestination[]) => ({
      ...source,
      network_policies: {
        ...source.network_policies,
        ...(destinations.length && {
          downloads: {
            binaries: [{ path: "/usr/bin/curl" }],
            endpoints: destinations.map(({ host, port }) => ({ host, ports: [port] })),
          },
        }),
      },
    });
    function checkContext(context: ProtectedDownloadPolicyContext, revision = activeRevision) {
      assert.deepEqual(context.plan, revision.egressPlan);
      assert.equal(context.namespace.id, f.namespace.id);
      assert.equal(context.revision.id, revision.id);
      assert.equal(context.revision.servicePrincipalId, f.agent.servicePrincipalId);
    }
    const prepare = async (
      context: ProtectedDownloadPolicyContext,
      previous: readonly ProtectedDownloadDestination[],
    ) => {
      checkContext(context);
      assert.deepEqual(context.protectedDownloadLimits, protectedDownloads);
      assert.deepEqual(previous, enabled);
      return { state: "ready" as const, fence: { ...fence } };
    };
    const observe: NonNullable<CredentialProxyDriver["protectedDownloadPolicy"]>["verify"] = async (
      context,
      change,
      expectedReceipt,
    ) => {
      if (oldEvidence && context.revision.id === f.revision.id) {
        checkContext(context, f.revision);
        assert.deepEqual(expectedReceipt, oldEvidence.receipt);
        assert.equal(change.operationId, oldEvidence.receipt.operationId);
        return hideConfirmation
          ? { state: "unconfirmed" }
          : { state: "confirmed", operationId: change.operationId, ...oldEvidence.fence };
      }
      checkContext(context);
      if (hideConfirmation && activeRevision.id === f.revision.id) {
        return { state: "unconfirmed" };
      }
      assert.equal(change.operationId, operationId);
      assert.deepEqual(expectedReceipt, receipt);
      return { state: "confirmed", operationId: change.operationId, ...fence };
    };
    const policy = async () => {
      const current = await f.state.read((view) =>
        view.sandboxPolicies.find(f.namespace.id, f.agent.id),
      );
      assert.ok(current);
      return current;
    };
    const sandboxPolicy: NonNullable<SandboxDriver["protectedDownloadPolicy"]> = {
      version: 1,
      async prepare(context, previous, desired) {
        if (revokeBeforeApply) {
          const current = await policy();
          if (
            current.application?.kind === "protected_downloads" &&
            current.application.state === "pending" &&
            current.application.writeState === "dispatched"
          ) {
            await revokeBeforeApply();
            revokeBeforeApply = undefined;
          }
        }
        const baseline = await prepare(context, previous);
        const source = sourceFor(desired);
        return {
          ...baseline,
          source,
          sourcePolicyHash: createHash("sha256").update(JSON.stringify(source)).digest("hex"),
        };
      },
      async readReceipt(context, change) {
        checkContext(context);
        if (
          lateReceipt === "missing" ||
          receipt?.operationId !== change.operationId ||
          receipt.sandboxId !== change.expected.sandboxId
        ) {
          return { state: "unconfirmed" };
        }
        if (lateReceipt === "mismatched") {
          lateReceiptChecks.add("mismatched receipt");
          return { ...receipt, sourcePolicyHash: "0".repeat(64) };
        }
        if (lateReceipt === "available") {
          lateReceiptChecks.add("sandbox receipt");
        }
        return { ...receipt };
      },
      async observe(...args) {
        const observation = await observe(...args);
        if (lateReceipt === "available") {
          lateReceiptChecks.add("sandbox observation");
        }
        return observation;
      },
      async apply(context, change, prepared) {
        writes.push({
          revisionId: context.revision.id,
          operationId: change.operationId,
          sandboxId: change.expected.sandboxId,
        });
        checkContext(context);
        const current = await policy();
        assert.ok(current.application?.kind === "protected_downloads");
        assert.equal(current.application.id, change.operationId);
        assert.equal(current.application.writeState, "dispatched");
        assert.deepEqual(change.expected, fence);
        assert.deepEqual(prepared.source, sourceFor(change.desired));
        assert.equal(prepared.sourcePolicyHash, change.desiredSourcePolicyHash);
        assert.deepEqual(change.previous, enabled);
        enabled = structuredClone(change.desired);
        operationId = change.operationId;
        const hash = createHash("sha256")
          .update(JSON.stringify(sourceFor(enabled)))
          .digest("hex");
        fence = {
          ...fence,
          policyVersion: fence.policyVersion + 1,
          providerResourceVersion: String(Number(fence.providerResourceVersion) + 1),
          sourcePolicyHash: hash,
          effectivePolicyHash: hash,
        };
        receipt = {
          state: "committed",
          sandboxId: fence.sandboxId,
          operationId,
          sourcePolicyHash: hash,
          policyVersion: fence.policyVersion,
        };
        return lateReceipt === "missing" ? { state: "unconfirmed" } : { ...receipt };
      },
    };
    Object.assign(f.sandboxDriver, { protectedDownloadPolicy: sandboxPolicy });
    const proxyPolicy: NonNullable<CredentialProxyDriver["protectedDownloadPolicy"]> = {
      version: 1,
      prepare,
      async verify(...args) {
        const observation = await observe(...args);
        if (lateReceipt === "available") {
          lateReceiptChecks.add("proxy verification");
          if (mismatchLateProxyFence && observation.state === "confirmed") {
            return { ...observation, effectivePolicyHash: "0".repeat(64) };
          }
        }
        return observation;
      },
    };
    Object.assign(f.egress, { protectedDownloadPolicy: proxyPolicy });
    assert.equal(
      (await f.request("PATCH", base + "/editing", { body: { enabled: true } })).status,
      200,
    );
    const getView = async (): Promise<SandboxPolicyViewWire> => {
      const response = await f.request("GET", base);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return responseData(response, 200, SandboxPolicyViewResponse, "read sandbox policy").data;
    };
    let view = await getView();
    assert.deepEqual(view.policy.approvedDownloadDestinations, []);
    assert.deepEqual(view.policy.downloadDestinations, []);
    const compute = f.controller.selectedDriver("compute");
    const iam = f.controller.selectedDriver("iam");
    const configurationDriver = f.controller.selectedDriver("configuration");
    const secretDriver = f.controller.selectedDriver("secret");
    const makeWorker = (convergenceTimeoutMs?: number) =>
      createControllerWorker({
        pool: new pg.Pool({ connectionString: databaseUrl }),
        pollIntervalMs: 20,
        ...(convergenceTimeoutMs !== undefined && { convergenceTimeoutMs }),
        drivers: {
          installation: {
            occ: { cluster: "protected-download-test" },
            logging: { level: "info" },
            backend: [],
            drivers: {
              iam: selected(iam, NativeIAMDriver),
              compute: selected(compute, KubernetesComputeDriver),
              configuration: selected(configurationDriver, KubernetesConfigurationDriver),
              secret: selected(secretDriver, KubernetesSecretDriver),
              sandbox: {
                id: f.sandboxDriver.id,
                implementation: f.sandboxDriver.implementation,
                definition: sandboxConfiguration.definition,
                configuration: {},
              },
            },
            protectedDownloads,
          },
          configurationDriver,
          secretDriver,
          namespaceLifecycleBindings: bindings,
          createIAMDriver: (state) => new NativeIAMDriver(state, { id: iam.id }),
          computeDriver: compute,
          sandboxDriver: f.sandboxDriver,
          protectedDriver: f.installedDriver,
        },
        emit() {},
      });
    let worker = makeWorker();
    const workers = new Set([worker]);
    const restartWorker = async (convergenceTimeoutMs?: number) => {
      await worker.stopLoop();
      worker = makeWorker(convergenceTimeoutMs);
      workers.add(worker);
      await worker.start();
    };
    const queue = new PostgresWorkQueue(f.pool);
    // Setup already installed and activated this revision. SKIP LOCKED leaves its
    // outstanding lifecycle jobs untouched while the real worker claims just the edits.
    const blocker = await f.pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT idempotency_key FROM occ.controller_work WHERE namespace_id=$1 FOR UPDATE",
        [f.namespace.id],
      );
      // Keep the signed-in policy editor's Namespace permissions after revoking its
      // Installation administrator binding during the worker's final prepare.
      const editor = await f.request("POST", `/namespaces/${f.namespace.id}/iam/roles`, {
        body: {
          name: "download-policy-editor",
          permissions: [
            { action: "read", resourceKind: "agent" },
            { action: "manage_policy", resourceKind: "agent" },
            { action: "read", resourceKind: "sandbox_policy" },
            { action: "update", resourceKind: "sandbox_policy" },
          ],
        },
      });
      assert.equal(editor.status, 201, JSON.stringify(editor.body));
      const binding = await f.request("POST", `/namespaces/${f.namespace.id}/iam/access-bindings`, {
        body: {
          subjectKind: "identity",
          subjectId: f.principal.id,
          roleId: editor.data.id,
          resourceKind: "agent",
          resourceId: f.agent.id,
        },
      });
      assert.equal(binding.status, 201, JSON.stringify(binding.body));
      const {
        rows: [adminBinding],
      } = await f.pool.query<{ id: string }>(
        `SELECT b.* FROM occ.iam_roles r JOIN occ.iam_access_bindings b ON b.role_id=r.id
         WHERE b.identity_subject_id=$1 AND r.permissions @> '[{"resourceKind":"installation","action":"administer"}]'`,
        [f.principal.id],
      );
      assert.ok(adminBinding?.id);
      const restoreAdministrator = () =>
        f.pool.query(
          "INSERT INTO occ.iam_access_bindings SELECT * FROM jsonb_populate_record(null::occ.iam_access_bindings,$1::jsonb)",
          [JSON.stringify(adminBinding)],
        );
      const apply = (
        action: ProtectedDownloadEdit["action"],
        target: ProtectedDownloadDestination,
        revisionId: string = activeRevision.id,
      ): Promise<{ status: number; body: unknown }> =>
        f.request("POST", base + "/apply", {
          body: {
            expectedVersion: view.policy.version,
            revisionId,
            downloadChange: { action, destination: target },
          },
        });
      let previousId: string | undefined;
      const cases: [
        ProtectedDownloadEdit["action"],
        ProtectedDownloadDestination,
        readonly ProtectedDownloadDestination[],
        boolean?,
      ][] = [
        ["approve-and-enable", destination, [], true],
        ["approve-and-enable", destination, [destination]],
        ["approve-and-enable", earlierDestination, [earlierDestination, destination]],
        ["withdraw-approval", destination, [earlierDestination, destination], true],
        ["withdraw-approval", destination, [earlierDestination]],
        ["withdraw-approval", earlierDestination, []],
        ["approve-and-enable", destination, [destination]],
        ["approve-and-enable", earlierDestination, [earlierDestination, destination]],
      ];
      for (const [action, target, expected, revoked] of cases) {
        const previousReceipt = view.policy.applied;
        const previousProviderOperation: string | undefined = operationId;
        if (revoked) {
          revokeBeforeApply = () =>
            f.pool.query("DELETE FROM occ.iam_access_bindings WHERE id=$1", [adminBinding.id]);
        }
        const admitted = await apply(action, target, f.revision.id);
        assert.equal(
          admitted.status,
          202,
          `${action} ${target.host} ${JSON.stringify(admitted.body)}`,
        );
        const application = responseData(
          admitted,
          202,
          SandboxPolicyResponse,
          "apply download edit",
        ).data.application;
        assert.ok(application);
        assert.equal(application.state, "pending");
        assert.notEqual(application.id, previousId);
        const key: string = `agent:${f.agent.id}:reconcile:sandbox_policy:${application.id}`;
        if (!previousId) {
          assert.equal((await queue.findWork(key))?.state, "queued");
          await worker.start();
        }
        const terminal = await waitFor("protected download queue settlement", async () => {
          const item = await queue.findWork(key);
          assert.ok(item);
          return ["failed_permanent", "succeeded"].includes(item.state) ? item : undefined;
        });
        if (revoked) {
          assert.equal(
            terminal.state,
            "failed_permanent",
            terminal.reasonCode ?? "queue settlement",
          );
          view = await getView();
          assert.ok(view.protectedDownloads?.state === "verified");
          assert.ok(view.policy.application);
          assert.equal(revokeBeforeApply, undefined, "worker must reach the revocation callback");
          assert.equal(view.protectedDownloads.canApprove, false);
          assert.equal(view.policy.application.id, application.id);
          assert.equal(view.policy.application.state, "failed");
          assert.equal(view.policy.application.reason, "AUTHORIZATION_DENIED");
          assert.deepEqual(view.policy.downloadDestinations, expected);
          assert.deepEqual(view.policy.approvedDownloadDestinations, expected);
          assert.deepEqual(view.policy.applied, previousReceipt);
          assert.equal(operationId, previousProviderOperation);
          if (action === "approve-and-enable") {
            const enrollment = await apply("enable", target, f.revision.id);
            assert.equal(enrollment.status, 409, JSON.stringify(enrollment.body));
          }
          await restoreAdministrator();
          view = await getView();
          previousId = application.id;
          continue;
        }
        assert.equal(terminal.state, "succeeded", terminal.reasonCode ?? "queue settlement");
        view = await getView();
        assert.deepEqual(view.protectedDownloads, {
          state: "verified",
          revisionId: f.revision.id,
          canApprove: true,
        });
        assert.ok(view.policy.application);
        assert.ok(view.policy.applied && "operationId" in view.policy.applied);
        assert.equal(view.policy.application.id, application.id);
        assert.equal(view.policy.application.state, "applied");
        assert.equal(view.policy.applied.operationId, application.id);
        assert.equal(view.policy.applied.revisionId, f.revision.id);
        assert.deepEqual(view.policy.applied.confirmedDownloadDestinations, expected);
        assert.deepEqual(view.policy.downloadDestinations, expected);
        assert.deepEqual(view.policy.approvedDownloadDestinations, expected);
        assert.deepEqual(enabled, expected);
        previousId = application.id;
      }
      // The provider withdrew a confirmed download on the serving Sandbox, but
      // the direct reply was lost. Recovery must use its exact prior confirmation.
      const priorPolicy = await policy();
      assert.ok(priorPolicy.applied?.kind === "protected_downloads");
      const servingWorkload = () =>
        f.state.read(async (unit) => ({
          agent: await unit.agents.findAgent(f.namespace.id, f.agent.id),
          revision: await unit.revisions.findRevision(f.namespace.id, f.agent.id, f.revision.id),
          installation: await unit.credentialSources.findRevisionEgressInstallation(
            f.namespace.id,
            f.revision.id,
          ),
        }));
      const serving = await servingWorkload();
      assert.ok(serving.agent);
      assert.equal(serving.agent.activeRevisionId, f.revision.id);
      assert.equal(serving.agent.desiredRuntimeState, "running");
      assert.equal(serving.installation?.sandboxId, f.installation.sandboxId);
      lateReceipt = "missing";
      const late = await apply("withdraw-approval", destination);
      assert.equal(late.status, 202, JSON.stringify(late.body));
      const latePolicy = responseData(
        late,
        202,
        SandboxPolicyResponse,
        "edit with a lost reply",
      ).data;
      assert.ok(latePolicy.application);
      const lateId = latePolicy.application.id;
      const lateKey = `agent:${f.agent.id}:reconcile:sandbox_policy:${lateId}`;
      await waitFor("original provider write and queue deferral", async () =>
        writes.some((write) => write.operationId === lateId) &&
        (await queue.findWork(lateKey))?.state === "queued"
          ? true
          : undefined,
      );
      const pending = (await policy()).application;
      assert.ok(pending?.kind === "protected_downloads");
      assert.equal(pending.id, lateId);
      assert.equal(pending.writeState, "dispatched");
      assert.equal(pending.acknowledgedWrite, undefined);
      assert.deepEqual(
        pending.previousDownloadDestinations,
        priorPolicy.applied.confirmedDownloadDestinations,
      );
      assert.deepEqual(pending.expected, priorPolicy.applied.fence);

      // A restarted worker with a deadline already exceeded by this queued operation
      // takes the real timeout path. The wrong source hash cannot confirm the write.
      lateReceipt = "mismatched";
      await restartWorker(1);
      const terminal = await waitFor("original edit times out unconfirmed", async () => {
        const item = await queue.findWork(lateKey);
        return item?.state === "failed_permanent" ? item : undefined;
      });
      assert.equal(terminal.reasonCode, "SANDBOX_POLICY_UNCONFIRMED");
      assert.ok(lateReceiptChecks.has("mismatched receipt"));
      const failed = await policy();
      assert.equal(failed.application?.id, lateId);
      assert.equal(failed.application?.state, "failed");
      assert.deepEqual(failed.applied, priorPolicy.applied);

      // The Sandbox's original receipt cannot settle a failed edit if the
      // Credential Proxy disagrees about the effective policy.
      assert.ok(receipt?.state === "committed");
      const lateWrite = structuredClone(receipt);
      lateReceipt = "available";
      mismatchLateProxyFence = true;
      await restartWorker();
      await waitFor("periodic recovery checks both drivers", () =>
        lateReceiptChecks.has("proxy verification") ? true : undefined,
      );
      const afterMismatch = await f.state.transact(async (unit) => {
        await unit.agents.lockAgent(f.namespace.id, f.agent.id);
        return unit.sandboxPolicies.find(f.namespace.id, f.agent.id);
      });
      assert.deepEqual(afterMismatch, failed);
      view = await getView();
      assert.equal(view.protectedDownloads?.state, "unavailable");
      assert.equal((await apply("approve-and-enable", destination)).status, 409);

      // Ordinary maintenance can now settle that UUID on the serving revision.
      lateReceiptChecks.clear();
      mismatchLateProxyFence = false;
      await restartWorker();
      const settled = await waitFor("periodic recovery applies the original receipt", async () => {
        const current = await policy();
        return current.application?.state === "applied" ? current : undefined;
      });
      assert.equal(settled.version, latePolicy.version);
      assert.ok(settled.application?.kind === "protected_downloads");
      assert.equal(settled.application.id, lateId);
      assert.equal(settled.application.revisionId, f.revision.id);
      assert.equal(settled.application.reason, undefined);
      assert.deepEqual(settled.application.expected, pending.expected);
      assert.deepEqual(settled.application.acknowledgedWrite, lateWrite);
      assert.ok(settled.applied?.kind === "protected_downloads");
      assert.equal(settled.applied.operationId, lateId);
      assert.equal(settled.applied.revisionId, f.revision.id);
      assert.equal(settled.applied.policyVersion, latePolicy.version);
      assert.equal(settled.applied.providerVersion, String(lateWrite.policyVersion));
      const afterLate = [earlierDestination];
      assert.deepEqual(settled.applied.confirmedDownloadDestinations, afterLate);
      assert.deepEqual(settled.downloadDestinations, afterLate);
      assert.deepEqual(settled.approvedDownloadDestinations, afterLate);
      assert.deepEqual(
        lateReceiptChecks,
        new Set(["sandbox receipt", "sandbox observation", "proxy verification"]),
      );
      assert.deepEqual(
        writes.filter((write) => write.operationId === lateId),
        [{ revisionId: f.revision.id, operationId: lateId, sandboxId: f.installation.sandboxId }],
      );
      assert.deepEqual(await queue.findWork(lateKey), terminal);
      assert.deepEqual(await servingWorkload(), serving);
      const lateAudit = (await f.state.transact((unit) => unit.audit.list())).filter(
        (event) =>
          event.action === "openclaw.agents.sandbox_policy.application" &&
          event.details?.operationId === lateId,
      );
      assert.equal(lateAudit.length, 2);
      const success = lateAudit.find((event) => event.outcome === "success");
      assert.equal(success?.actorId, f.principal.id);
      assert.equal(success?.details?.policyVersion, latePolicy.version);
      assert.equal(success?.details?.revisionId, f.revision.id);

      lateReceipt = undefined;
      view = await getView();
      assert.equal(view.protectedDownloads?.state, "verified");
      assert.equal(view.policy.version, latePolicy.version);
      assert.equal(view.policy.application?.state, "applied");
      assert.ok(view.policy.applied && "operationId" in view.policy.applied);
      assert.equal(view.policy.applied.operationId, lateId);
      const followup = await apply("approve-and-enable", destination);
      assert.equal(followup.status, 202, JSON.stringify(followup.body));
      const followupId = responseData(followup, 202, SandboxPolicyResponse, "edit after recovery")
        .data.application?.id;
      assert.ok(followupId);
      assert.notEqual(followupId, lateId);
      await waitFor("next edit uses the confirmed receipt", async () => {
        const applied = (await policy()).applied;
        return applied?.kind === "protected_downloads" && applied.operationId === followupId
          ? true
          : undefined;
      });
      view = await getView();

      hideConfirmation = true;
      const priorWitness = (await policy()).applied;
      const uncertain = await apply("approve-and-enable", uncertainDestination);
      assert.equal(uncertain.status, 202, JSON.stringify(uncertain.body));
      const uncertainPolicy = responseData(
        uncertain,
        202,
        SandboxPolicyResponse,
        "original edit",
      ).data;
      assert.ok(uncertainPolicy.application);
      const oldId = uncertainPolicy.application.id;
      const oldKey = `agent:${f.agent.id}:reconcile:sandbox_policy:${oldId}`;
      await waitFor("committed ACK on the unconfirmed original", async () => {
        const application = (await policy()).application;
        assert.ok(application?.kind === "protected_downloads");
        return application.acknowledgedWrite;
      });
      // Losing administrator authority fences the original worker after dispatch.
      await f.pool.query("DELETE FROM occ.iam_access_bindings WHERE id=$1", [adminBinding.id]);
      await waitFor("original queue fenced", async () =>
        (await queue.findWork(oldKey))?.state === "failed_permanent" ? true : undefined,
      );
      await restoreAdministrator();
      assert.ok(receipt);
      oldEvidence = { fence: structuredClone(fence), receipt: structuredClone(receipt) };
      view = await getView();
      assert.ok(view.protectedDownloads?.state === "unavailable");
      assert.equal(view.protectedDownloads.reason, "installation-unconfirmed");
      assert.equal((await apply("approve-and-enable", earlierDestination)).status, 409);
      assert.deepEqual((await policy()).applied, priorWitness);
      activeRevision = replacement;
      source = attachment.configuration;
      enabled = [];
      assert.ok(replacementInstallation.enforcement.peerKeyId);
      fence = {
        ...fence,
        sandboxId,
        peer: { keyId: replacementInstallation.enforcement.peerKeyId },
        instanceId: replacementInstallation.enforcement.instanceId,
        configurationId: replacementInstallation.enforcement.configurationId,
        effectivePolicyHash: replacementInstallation.enforcement.policyHash,
        sourcePolicyHash: observed.policyHash,
        policyVersion: replacement.egressPlan.generation,
        providerResourceVersion: "1",
      };
      assert.ok(
        await f.state.transact((unit) =>
          unit.agents.compareAndSetActiveRevision(
            f.namespace.id,
            f.agent.id,
            f.revision.id,
            replacement.id,
          ),
        ),
      );
      const oldRow = async () => {
        const row = (
          await f.pool.query<{ recovery: ProtectedDownloadRecovery | null }>(
            "SELECT protected_download_recovery AS recovery FROM occ.controller_work WHERE idempotency_key=$1",
            [oldKey],
          )
        ).rows[0];
        assert.ok(row);
        return row;
      };
      const savedProxyPrepare = proxyPolicy.prepare;
      proxyPolicy.prepare = async () => ({ state: "unconfirmed" });
      view = await getView();
      assert.ok(view.protectedDownloads?.state === "unavailable");
      assert.equal(view.protectedDownloads.reason, "installation-unconfirmed");
      assert.equal((await apply("approve-and-enable", earlierDestination)).status, 409);
      proxyPolicy.prepare = savedProxyPrepare;
      view = await getView();
      assert.equal(view.protectedDownloads?.state, "verified");
      assert.deepEqual(view.policy.approvedDownloadDestinations, [earlierDestination, destination]);
      assert.deepEqual(view.policy.downloadDestinations, [earlierDestination, destination]);
      assert.deepEqual(enabled, []);
      assert.equal((await apply("enable", uncertainDestination)).status, 409);
      assert.deepEqual(
        await oldRow(),
        { recovery: null },
        "reads and rejected edits never retain or mutate",
      );
      await f.pool.query("DELETE FROM occ.iam_access_bindings WHERE id=$1", [adminBinding.id]);
      const admitted = await apply("enable", earlierDestination);
      assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
      const successor = responseData(admitted, 202, SandboxPolicyResponse, "successor edit").data
        .application;
      assert.ok(successor);
      const newId = successor.id;
      await waitFor("independent successor applied", async () => {
        const applied = (await getView()).policy.applied;
        return applied && "operationId" in applied && applied.operationId === newId
          ? true
          : undefined;
      });
      assert.equal((await policy()).applied?.revisionId, replacement.id);
      assert.deepEqual(enabled, [earlierDestination]);
      assert.deepEqual(
        writes.filter((write) => [oldId, newId].includes(write.operationId)),
        [
          { revisionId: f.revision.id, operationId: oldId, sandboxId: f.installation.sandboxId },
          { revisionId: replacement.id, operationId: newId, sandboxId },
        ],
      );
      view = await getView();
      assert.deepEqual(view.policy.downloadDestinations, [earlierDestination, destination]);
      assert.deepEqual(view.policy.approvedDownloadDestinations, [earlierDestination, destination]);
      assert.equal((await apply("withdraw-approval", destination)).status, 403);
      await restoreAdministrator();
      const withdrawal = await apply("withdraw-approval", destination);
      const withdrawn = responseData(
        withdrawal,
        202,
        SandboxPolicyResponse,
        "withdraw inactive destination",
      ).data.application;
      assert.ok(withdrawn);
      await waitFor("inactive approval withdrawn", async () => {
        const applied = (await getView()).policy.applied;
        return applied && "operationId" in applied && applied.operationId === withdrawn.id
          ? true
          : undefined;
      });
      view = await getView();
      assert.deepEqual(view.policy.approvedDownloadDestinations, [earlierDestination]);
      assert.deepEqual(view.policy.downloadDestinations, [earlierDestination]);
      assert.deepEqual(enabled, [earlierDestination]);
      const retained = (await oldRow()).recovery;
      assert.ok(retained);
      assert.deepEqual(retained.priorConfirmation, priorWitness);
      assert.deepEqual(retained.acknowledgedWrite, oldEvidence.receipt);
      assert.equal(JSON.stringify(await getView()).includes(oldEvidence.fence.instanceId), false);
      assert.equal(
        JSON.stringify(await queue.findWork(oldKey)).includes(oldEvidence.fence.instanceId),
        false,
      );
      hideConfirmation = false;
      await restartWorker();
      await waitFor("authenticated original read clears private receipt", async () =>
        (await oldRow()).recovery === null ? true : undefined,
      );
      const settlement = await f.state.transact((unit) => unit.audit.list());
      const disposition = settlement.filter(
        (event) =>
          event.action === "openclaw.agents.sandbox_policy.reconciliation" &&
          event.details?.operationId === oldId,
      );
      assert.equal(disposition.length, 1);
      assert.deepEqual(disposition[0]?.details, {
        agentId: f.agent.id,
        operationId: oldId,
        revisionId: f.revision.id,
        policyVersion: uncertainPolicy.version,
        providerVersion: String(oldEvidence.fence.policyVersion),
        disposition: "confirmed-applied",
      });
      const applied = (await policy()).applied;
      assert.ok(applied?.kind === "protected_downloads");
      assert.equal(applied.operationId, withdrawn.id);
      assert.equal(writes.filter((write) => write.operationId === oldId).length, 1);
    } finally {
      try {
        await worker.stopLoop();
        await Promise.all([...workers].map((started) => started.stop()));
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
    }
  },
);
