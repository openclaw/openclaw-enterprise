import assert from "node:assert/strict";
import test from "node:test";
import { openShellProviderName } from "../../apps/controller/src/backends/openshell.ts";
import type { OpenShellSandboxDriverOptions } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type {
  OpenShellGatewayClient,
  OpenShellSandboxCreateRequest,
  OpenShellSandboxResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type {
  HarnessWorkloadRequirements,
  SandboxLogContext,
} from "../../packages/contracts/src/index.ts";
import { ManagedOpenShellSandbox } from "../../apps/controller/src/drivers/sandbox/openshell/managed.ts";
import { storedSandbox } from "./sandbox-driver-gateway-response-fixture.ts";
import { backendFor } from "./sandbox-driver-openshell-fixture.ts";
import { buildSandboxInstallation as sandboxInstallation } from "./sandbox-driver-startup-installation-fixture.ts";
import { harnessService, runtimeSandboxFixture } from "./sandbox-driver-startup-orchestration.ts";
import { completeWorkspaceRevision } from "./sandbox-driver-revision-fixture.ts";
import {
  assertManagedPolicy,
  assertManagedSandboxRequest,
  type ManagedPolicy,
  type ManagedSandboxPhase,
  type ManagedWorkloadSpec,
} from "./sandbox-driver-managed-startup-rendering-cases.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

type StoredManagedSandbox = Omit<
  OpenShellSandboxResponse,
  "spec" | "phase" | "resourceVersion" | "id"
> & {
  spec: ManagedWorkloadSpec;
  phase: ManagedSandboxPhase;
  resourceVersion: string;
  id: string;
};

function storeWorkload(
  request: OpenShellSandboxCreateRequest,
  id: string,
  resourceVersion: string,
  phase: ManagedSandboxPhase,
): StoredManagedSandbox {
  assertManagedSandboxRequest(request);
  return { ...storedSandbox(request), spec: request.spec, id, resourceVersion, phase };
}

type ReplacementStep = "clear" | "detach" | "attach" | "reject-final" | "final" | "workload";

export function registerManagedStartupNetworkReplacementCases(): void {
  test("managed network policy replacement survives lost responses and gates activation", async (t) => {
    const client = workspaceGatewayClient();
    const options = sandboxInstallation().drivers.sandbox.configuration;
    options.integrationMode = "service";
    options.gateway = {};
    options.kubernetes.sandboxDataMount.mountPath = "/sandbox/oce/workspace";
    const makeDriver = (configuration: OpenShellSandboxDriverOptions) =>
      new ManagedOpenShellSandbox(configuration, {
        id: "openshell-sandbox",
        backend: backendFor(client),
      });
    const original = makeDriver(options);
    const { context, revision: fixtureRevision, requirements } = runtimeSandboxFixture(original);
    const revision = completeWorkspaceRevision(fixtureRevision, requirements);
    requirements.workspaceMounts = [];
    let stored: StoredManagedSandbox | undefined;
    let policy: ManagedPolicy | undefined;
    const currentSandbox = (): StoredManagedSandbox => {
      assert.ok(stored, "The Gateway must have stored a Sandbox");
      return stored;
    };
    const currentPolicy = (): ManagedPolicy => {
      assert.ok(policy, "The Gateway must have stored a policy");
      return policy;
    };
    let version = 1;
    let policyVersion = 1;
    let activeVersion = 1;
    let policyState: "POLICY_STATUS_LOADED" | "POLICY_STATUS_PENDING" | "POLICY_STATUS_FAILED" =
      "POLICY_STATUS_LOADED";
    let writes = 0;
    let failure: "ignored" | "lost" | undefined;
    const liveEdit = "live-policy-edit";
    client.createSandbox = async (request) => {
      stored = storeWorkload(
        structuredClone(request),
        "stable-policy-sandbox",
        String(version),
        "SANDBOX_PHASE_READY",
      );
      policy = structuredClone(stored.spec.policy);
      return stored;
    };
    client.getSandbox = async () => (stored === undefined ? undefined : structuredClone(stored));
    client.getPolicyStatus = async () => ({
      policy: structuredClone(currentPolicy()),
      version: policyVersion,
      activeVersion,
      state: policyState,
    });
    client.getService = async () =>
      harnessService(currentSandbox().name, "", "http://codex.example.test:8080/");
    client.updatePolicy = async (request) => {
      assert.equal(
        currentSandbox().phase,
        request.requestId === liveEdit ? "SANDBOX_PHASE_READY" : "SANDBOX_PHASE_STOPPED",
      );
      assert.equal(request.expectedResourceVersion, String(version));
      writes += 1;
      if (failure === "ignored") {
        return;
      }
      // OpenShell stores policy history independently of the creation specification.
      assertManagedPolicy(request.policy);
      policy = structuredClone(request.policy);
      policyVersion += 1;
      policyState = "POLICY_STATUS_PENDING";
      currentSandbox().resourceVersion = String(++version);
      if (failure === "lost") {
        throw new Error("lost policy response");
      }
    };
    client.updateSandbox = async (request) => {
      assert.equal(request.expectedResourceVersion, String(version));
      stored = storeWorkload(
        { ...request, spec: { ...request.spec, policy: currentSandbox().spec.policy } },
        currentSandbox().id,
        String(++version),
        "SANDBOX_PHASE_STOPPED",
      );
      return stored;
    };
    client.startSandbox = async () => {
      currentSandbox().phase = "SANDBOX_PHASE_READY";
      return currentSandbox();
    };
    const provision = (
      driver: ManagedOpenShellSandbox,
      id: string,
      overrides: Partial<HarnessWorkloadRequirements> = {},
    ) => {
      const effectiveRequirements = { ...requirements, ...overrides };
      return driver.provisionHarness({
        ...context,
        revision: { ...completeWorkspaceRevision(fixtureRevision, effectiveRequirements), id },
        requirements: effectiveRequirements,
      });
    };
    await original.ensureNamespace(context);
    await provision(original, revision.id);
    const baseline = structuredClone(currentSandbox().spec.policy);
    const changed = structuredClone(options);
    changed.policy.networkPolicies.push({
      name: "documentation",
      endpoints: [{ host: "example.org", ports: [443] }],
      binaries: [{ path: "/usr/bin/curl" }],
    });
    const replacement = makeDriver(changed);
    const next = "rev_00000000-0000-4000-8000-000000000008";
    await assert.rejects(provision(replacement, revision.id), /Stop the previous managed workload/);
    currentSandbox().phase = "SANDBOX_PHASE_STOPPED";
    // Neither static restrictions nor middleware changes belong to this increment.
    for (const field of ["process", "network_middlewares"]) {
      const saved = structuredClone(currentPolicy());
      currentPolicy()[field] = { changed: true };
      await assert.rejects(
        provision(replacement, next),
        /static policy or non-Git middleware bindings/,
      );
      policy = saved;
    }
    assert.equal(writes, 0);
    failure = "ignored";
    await assert.rejects(provision(replacement, next), /policy readback differs/);
    assert.equal(currentSandbox().phase, "SANDBOX_PHASE_STOPPED");
    failure = "lost";
    await assert.rejects(provision(replacement, next), /lost policy response/);
    assert.equal(currentSandbox().phase, "SANDBOX_PHASE_STOPPED");
    assert.equal(writes, 2);
    failure = undefined;
    await provision(replacement, next);
    assert.equal(writes, 2, "Retry adopts the stored policy without another write");
    assert.deepEqual(
      currentSandbox().spec.policy,
      baseline,
      "Workload updates retain the creation policy",
    );
    assert.ok(currentPolicy().network_policies.documentation);
    assert.equal(currentSandbox().id, "stable-policy-sandbox");
    await provision(replacement, next);
    assert.equal(writes, 2, "An unchanged retry must not restore the creation policy");
    const observationContext: SandboxLogContext = {
      ...context,
      revision: { ...revision, id: next, executionAdmission: { version: 2, mode: "unprotected" } },
    };
    assert.deepEqual(await replacement.observeHarness(observationContext), { state: "starting" });
    policyState = "POLICY_STATUS_LOADED";
    assert.deepEqual(await replacement.observeHarness(observationContext), { state: "starting" });
    activeVersion = policyVersion;
    assert.deepEqual(await replacement.observeHarness(observationContext), { state: "running" });
    // A subsequent live edit must use the new defaults, not the creation-time rules.
    const snapshot = replacement.admitNetworkPolicy([], 1);
    assert.equal(
      (await replacement.observeNetworkPolicy(observationContext, snapshot)).matches,
      true,
    );
    const liveSnapshot = replacement.admitNetworkPolicy(
      [
        {
          id: "status",
          binary: "/usr/bin/curl",
          host: "status.example.org",
          ports: [{ from: 443, to: 443 }],
        },
      ],
      2,
    );
    const applyLivePolicy = () =>
      replacement.applyNetworkPolicy(observationContext, {
        snapshot: liveSnapshot,
        expectedProviderVersion: currentSandbox().resourceVersion,
        operationId: liveEdit,
      });

    // An externally added base rule must neither report a match nor survive a live write.
    const approvedPolicy = structuredClone(currentPolicy());
    currentPolicy().network_policies._unapproved = {
      name: "_unapproved",
      endpoints: [{ host: "unapproved.example.org", ports: [443] }],
      binaries: [{ path: "/usr/bin/curl" }],
    };
    await assert.rejects(
      replacement.observeNetworkPolicy(observationContext, snapshot),
      /policy differs from its admitted baseline/,
    );
    await assert.rejects(applyLivePolicy(), /policy differs from its admitted baseline/);
    assert.equal(writes, 2);

    // Agent grants are admitted separately from the revision's base policy.
    policy = approvedPolicy;
    await applyLivePolicy();
    assert.equal(
      (await replacement.observeNetworkPolicy(observationContext, liveSnapshot)).matches,
      true,
    );
    policyState = "POLICY_STATUS_FAILED";
    await assert.rejects(replacement.observeHarness(observationContext), /did not activate/);
    policyState = "POLICY_STATUS_LOADED";
    currentSandbox().phase = "SANDBOX_PHASE_STOPPED";
    await provision(original, "rev_00000000-0000-4000-8000-000000000009");
    assert.equal(
      currentPolicy().network_policies.documentation,
      undefined,
      "A later revision removes the rule",
    );
    assert.equal(writes, 4);
    await t.test(
      "combined replacement resumes each committed step without starting early",
      async () => {
        // These controlled RPC responses exercise OCE recovery and ordering. Actual
        // OpenShell policy validation is covered by the real replacement scenario.
        const attachment = requirements.credentialAttachments[0];
        assert.ok(attachment);
        const sourceA = attachment.ref;
        const sourceB = openShellProviderName("combined-source");
        const target = "rev_00000000-0000-4000-8000-000000000010";
        const mutations: ReplacementStep[] = [];
        let interrupt: ReplacementStep | undefined;
        const committed = (step: ReplacementStep) => {
          mutations.push(step);
          if (interrupt === step) {
            throw new Error(`lost ${step} response`);
          }
        };
        const updatePolicy = client.updatePolicy;
        assert.ok(updatePolicy);
        client.updatePolicy = async (request) => {
          assertManagedPolicy(request.policy);
          if (interrupt === "reject-final" && request.policy.network_policies.documentation) {
            throw new Error("policy rejected by gateway");
          }
          await updatePolicy(request, context.signal);
          committed(Object.keys(request.policy.network_policies).length === 0 ? "clear" : "final");
        };
        const mutateProvider = async (
          operation: "detach" | "attach",
          ...[_workspace, name, provider, _signal, conditional]: Parameters<
            OpenShellGatewayClient["attachSandboxProvider"]
          >
        ): Promise<void> => {
          assert.equal(name, currentSandbox().name);
          assert.equal(currentSandbox().phase, "SANDBOX_PHASE_STOPPED");
          assert.equal(conditional.expectedResourceVersion, String(version));
          assert.deepEqual(
            currentPolicy().network_policies,
            {},
            "Withdraw rules before changing Providers",
          );
          assert.equal(provider, operation === "detach" ? sourceA : sourceB);
          currentSandbox().spec.providers =
            operation === "detach"
              ? currentSandbox().spec.providers.filter((value) => value !== provider)
              : [...currentSandbox().spec.providers, provider];
          currentSandbox().resourceVersion = String(++version);
          committed(operation);
        };
        client.detachSandboxProvider = async (workspace, name, provider, signal, conditional) => {
          assert.ok(conditional);
          await mutateProvider("detach", workspace, name, provider, signal, conditional);
          return {};
        };
        client.attachSandboxProvider = async (...args) => mutateProvider("attach", ...args);
        const updateSandbox = client.updateSandbox;
        assert.ok(updateSandbox);
        client.updateSandbox = async (request) => {
          assert.ok(
            currentPolicy().network_policies.documentation,
            "Install final rules before the workload",
          );
          assert.ok(currentSandbox().spec.providers.includes(sourceB));
          assert.equal(currentSandbox().spec.providers.includes(sourceA), false);
          const response = await updateSandbox(request, context.signal);
          committed("workload");
          return response;
        };
        const replace = () =>
          provision(replacement, target, {
            credentialAttachments: [{ sourceId: "combined-source", ref: sourceB }],
          });
        currentSandbox().phase = "SANDBOX_PHASE_STOPPED";
        // Each response is lost after the gateway commits. The next attempt must
        // adopt that state, even after all attachments or the workload already match.
        for (const step of [
          "clear",
          "detach",
          "attach",
          "reject-final",
          "final",
          "workload",
        ] satisfies ReplacementStep[]) {
          interrupt = step;
          await assert.rejects(replace(), /lost .* response|policy rejected by gateway/);
          assert.equal(currentSandbox().phase, "SANDBOX_PHASE_STOPPED");
          assert.deepEqual(currentSandbox().spec.policy, baseline);
        }
        interrupt = undefined;
        await replace();
        assert.equal(currentSandbox().phase, "SANDBOX_PHASE_READY");
        assert.equal(currentSandbox().id, "stable-policy-sandbox");
        assert.deepEqual(mutations, ["clear", "detach", "attach", "final", "workload"]);
        await replace();
        assert.equal(mutations.length, 5, "An unchanged retry must not clear the final policy");
      },
    );
  });
}
