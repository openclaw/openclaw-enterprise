import assert from "node:assert/strict";
import test from "node:test";
import { deleteOpenShellPreparedGitProviders } from "../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts";
import type {
  OpenShellProviderResponse,
  OpenShellStoredProviderProfile,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import {
  installedStatus,
  signal,
  token,
  wire,
  type WireInstalledStatus,
  type WireProviderStatus,
} from "./openshell-prepared-git-wire.ts";

function omitStatusField(field: "receipt" | "observed" | "observed_time") {
  return (status: WireProviderStatus): void => {
    delete status[field];
  };
}

export function registerPreparedGitInstallationCases(): void {
  test("prepared Git bootstraps without privilege and distinguishes accepted rotation from exact installed state", async (t) => {
    const { state, binding } = await wire(t);
    const bootstrap = await binding.bootstrap(signal());
    assert.equal(bootstrap.credentialState, "bootstrap");
    assert.equal(bootstrap.expiresAt, "");
    assert.ok(state.provider);
    assert.equal(state.provider.credentials.GITHUB_TOKEN, "oce-unprivileged-bootstrap-sentinel");
    assert.equal(await binding.observe(bootstrap, "sandbox-id", signal()), undefined);
    state.status = installedStatus(bootstrap);
    const bootstrapInstallation = await binding.observe(bootstrap, "sandbox-id", signal());
    assert.ok(bootstrapInstallation);
    assert.equal(bootstrapInstallation.credentialState, "bootstrap");
    const active = await binding.rotate(bootstrap, async () => token(), signal());
    assert.ok(active);
    assert.equal(active.credentialState, "active");
    assert.equal(
      await binding.observe(active, "sandbox-id", signal()),
      undefined,
      "old installed version is not updated provider evidence",
    );
    const status = installedStatus(active);
    state.status = status;
    const installed = await binding.observe(active, "sandbox-id", signal());
    assert.ok(installed);
    assert.equal(installed.providerResourceVersion, "2");
    assert.equal(installed.supervisorSessionId, "supervisor-session");
    assert.equal(installed.networkInstanceId, "network-instance");
    assert.equal(installed.credentialState, "active");
    assert.equal(await binding.observe(bootstrap, "sandbox-id", signal()), undefined);
    status.observed.sequence = "2";
    assert.deepEqual(
      await binding.observe(active, "sandbox-id", signal()),
      installed,
      "heartbeat sequence is not a new installed identity",
    );

    // A restored generation names the same provider but cannot establish supervisor readiness.
    const { providerId, profileVersion, resourceVersion, expiresAt, credentialState } = active;
    const generation = { providerId, profileVersion, resourceVersion, expiresAt, credentialState };
    const requestCounts = [state.workspaceReads, state.requests.length];
    const restored = binding.restore(generation);
    assert.deepEqual(restored, active);
    assert.ok(Object.isFrozen(restored) && Object.isFrozen(restored.readiness));
    const expired = { ...generation, expiresAt: new Date(Date.now() - 60_000).toISOString() };
    const finite = binding.restore(expired);
    assert.equal(finite.credentialState, "bootstrap");
    assert.equal(finite.expiresAt, "");
    const standing = binding.restore(expired, true);
    assert.equal(standing.credentialState, "active");
    assert.equal(standing.expiresAt, expired.expiresAt);
    assert.equal(await binding.observe(standing, "sandbox-id", signal()), undefined);
    assert.deepEqual(
      [state.workspaceReads, state.requests.length],
      requestCounts,
      "restore and expired observation make no gateway requests",
    );

    // Standing succession may identify expired material, but never use it as live access.
    // The stock Gateway reports expiry before checking the supervisor's observation lease.
    const predecessor = installedStatus(standing);
    predecessor.state = "PROVIDER_READINESS_STATE_WITHHELD";
    predecessor.reason = "PROVIDER_READINESS_REASON_CREDENTIAL_EXPIRED";
    predecessor.observed.reason = "PROVIDER_READINESS_REASON_CREDENTIAL_EXPIRED";
    predecessor.observed.credentials_installed = false;
    predecessor.observed.launch_environment_installed = false;
    state.status = predecessor;
    assert.equal(await binding.observePredecessor(standing, installed, signal()), installed);
    assert.equal(await binding.observe(standing, "sandbox-id", signal()), undefined);
    state.status = structuredClone(predecessor);
    state.status.observed_time = {
      ...predecessor.evaluated_time,
      seconds: String(Number(predecessor.evaluated_time.seconds) - 14),
    };
    assert.equal(await binding.observePredecessor(standing, installed, signal()), installed);
    // Fractional wire timestamps cross a second boundary, with time for two real RPCs.
    const fractional = structuredClone(predecessor);
    fractional.evaluated_time.nanos = 100_000;
    fractional.observed_time = {
      seconds: String(Number(predecessor.evaluated_time.seconds) - 2),
      nanos: 900_000,
    };
    state.status = fractional;
    assert.equal(await binding.observePredecessor(standing, installed, signal()), installed);
    for (const mutate of [
      (status: WireInstalledStatus) => {
        status.reason = "PROVIDER_READINESS_REASON_CREDENTIALS_WITHHELD";
      },
      (status: WireInstalledStatus) => {
        status.observed_time = {
          ...status.evaluated_time,
          seconds: String(Number(status.evaluated_time.seconds) - 15),
        };
      },
      (status: WireInstalledStatus) => {
        status.evaluated_time.nanos = 100_000;
        status.observed_time = { ...status.evaluated_time, nanos: 900_000 };
      },
      (status: WireInstalledStatus) => {
        status.observed.process_instance_id = "replacement-process";
      },
    ]) {
      const candidate = structuredClone(predecessor);
      mutate(candidate);
      state.status = candidate;
      await assert.rejects(
        binding.observePredecessor(standing, installed, signal()),
        /cannot retain this execution/,
      );
    }
    // A recent report may still name the old session after stock accepts a replacement.
    state.status = predecessor;
    state.mainProcessInstanceId = "replacement-network-instance";
    await assert.rejects(
      binding.observePredecessor(standing, installed, signal()),
      /cannot retain this execution/,
    );
    state.mainProcessInstanceId = "network-instance";
    state.sandboxPhase = "SANDBOX_PHASE_STOPPING";
    await assert.rejects(
      binding.observePredecessor(standing, installed, signal()),
      /cannot retain this execution/,
    );
  });

  test("prepared Git refuses stale, partial, mismatched and unavailable installation observations", async (t) => {
    const { state, binding } = await wire(t);
    const active = await binding.prepare(token(), signal());
    assert.ok(active);
    const complete = installedStatus(active);
    for (const mutate of [
      omitStatusField("receipt"),
      omitStatusField("observed"),
      (status: WireInstalledStatus) => {
        status.state = "PROVIDER_READINESS_STATE_PENDING";
      },
      (status: WireInstalledStatus) => {
        status.receipt.workspace = "foreign";
      },
      (status: WireInstalledStatus) => {
        status.receipt.provider = "foreign";
      },
      (status: WireInstalledStatus) => {
        status.receipt.desired.sandbox_id = "replacement";
      },
      (status: WireInstalledStatus) => {
        status.receipt.desired.provider_id = "replacement";
      },
      (status: WireInstalledStatus) => {
        status.receipt.desired.provider_resource_version = "99";
      },
      (status: WireInstalledStatus) => {
        status.observed.attachment_epoch = "old";
      },
      (status: WireInstalledStatus) => {
        status.observed.provider_env_revision = "100";
      },
      (status: WireInstalledStatus) => {
        status.observed.config_revision = "201";
      },
      (status: WireInstalledStatus) => {
        status.observed.policy_hash = "old";
      },
      (status: WireInstalledStatus) => {
        status.observed.session_id = "";
      },
      (status: WireInstalledStatus) => {
        status.observed.credentials_installed = false;
      },
      (status: WireInstalledStatus) => {
        status.observed.policy_active = false;
      },
      (status: WireInstalledStatus) => {
        status.observed.launch_environment_installed = false;
      },
      (status: WireInstalledStatus) => {
        status.observed.process_instance_id = "";
      },
      (status: WireInstalledStatus) => {
        status.network_instance_id = "";
      },
      omitStatusField("observed_time"),
      (status: WireInstalledStatus) => {
        status.evaluated_time.seconds = "1";
      },
    ]) {
      const candidate = structuredClone(complete);
      mutate(candidate);
      state.status = candidate;
      assert.equal(await binding.observe(active, "sandbox-id", signal()), undefined);
    }
    state.status = complete;
    assert.equal(await binding.observe(active, "different-sandbox", signal()), undefined);
    assert.equal(
      await binding.observe(
        { ...active, expiresAt: new Date(0).toISOString() },
        "sandbox-id",
        signal(),
      ),
      undefined,
    );
    state.workspaceId = "replacement-workspace";
    assert.equal(await binding.observe(active, "sandbox-id", signal()), undefined);
  });

  test("prepared Git keeps its verified installation while only another attached provider moves", async (t) => {
    // Finding 2146: a sibling Agent's deploy moves the Sandbox-wide provider environment revision
    // of a running Sandbox. Until its supervisor's next settings poll installs it, the Gateway
    // reports the provider as pending (snapshot mismatch); this provider's own installation is
    // unchanged, so the verified observation stands. Anything else that moved still answers nothing.
    const { state, binding } = await wire(t);
    const active = await binding.prepare(token(), signal());
    assert.ok(active);
    state.status = installedStatus(active);
    const installed = await binding.observe(active, "sandbox-id", signal());
    assert.ok(installed);
    assert.equal(installed.providerEnvRevision, "101");
    const sibling = () => {
      const status = installedStatus(active);
      status.state = "PROVIDER_READINESS_STATE_PENDING";
      status.reason = "PROVIDER_READINESS_REASON_SNAPSHOT_MISMATCH";
      status.receipt.desired.provider_env_revision = "102";
      return status;
    };
    state.status = sibling();
    assert.equal(await binding.observe(active, "sandbox-id", signal(), installed), installed);
    assert.equal(
      await binding.observe(active, "sandbox-id", signal()),
      undefined,
      "without a verified installation, a pending snapshot verifies nothing",
    );
    for (const mutate of [
      (status: WireInstalledStatus) => {
        status.reason = "PROVIDER_READINESS_REASON_WAITING_FOR_SUPERVISOR";
      },
      (status: WireInstalledStatus) => {
        status.state = "PROVIDER_READINESS_STATE_READY";
      },
      (status: WireInstalledStatus) => {
        status.state = "PROVIDER_READINESS_STATE_WITHHELD";
      },
      (status: WireInstalledStatus) => {
        status.receipt.desired.config_revision = "203";
      },
      (status: WireInstalledStatus) => {
        status.receipt.desired.policy_hash = "other-policy";
      },
      (status: WireInstalledStatus) => {
        status.receipt.desired.attachment_epoch = "attachment-two";
      },
      (status: WireInstalledStatus) => {
        status.receipt.desired.provider_resource_version = "99";
      },
      (status: WireInstalledStatus) => {
        status.observed.session_id = "other-session";
      },
      (status: WireInstalledStatus) => {
        status.observed.process_instance_id = "other-process";
      },
      (status: WireInstalledStatus) => {
        status.network_instance_id = "other-network";
      },
      (status: WireInstalledStatus) => {
        status.observed.provider_env_revision = "";
      },
      (status: WireInstalledStatus) => {
        status.observed.credentials_installed = false;
      },
      (status: WireInstalledStatus) => {
        status.evaluated_time.seconds = "1";
      },
    ]) {
      const candidate = sibling();
      mutate(candidate);
      state.status = candidate;
      assert.equal(await binding.observe(active, "sandbox-id", signal(), installed), undefined);
    }
    // A verified installation of another binding generation is not this one.
    state.status = sibling();
    assert.equal(
      await binding.observe(active, "sandbox-id", signal(), {
        ...installed,
        providerResourceVersion: "0",
      }),
      undefined,
    );
    assert.equal(await binding.observe(active, "other-sandbox", signal(), installed), undefined);
    // Once the supervisor installs the new environment, the read verifies as usual.
    const current = installedStatus(active);
    current.receipt.desired.provider_env_revision = "102";
    current.observed.provider_env_revision = "102";
    state.status = current;
    const moved = await binding.observe(active, "sandbox-id", signal(), installed);
    assert.ok(moved);
    assert.equal(moved.providerEnvRevision, "102");
    assert.deepEqual({ ...moved, providerEnvRevision: "101" }, installed);
  });

  // Namespace cleanup (finding 2206) deletes only the Workspace's own prepared Git profiles: the
  // listing also returns platform and static profiles, and an unprepared or foreign-named one.
  test("Namespace cleanup deletes only workspace-scoped prepared Git profiles", async () => {
    const owner = "b".repeat(48);
    const prepared = "oce-git-" + "b".repeat(32);
    const installation = "oce-github-installation-" + "b".repeat(32);
    const profile = (
      id: string,
      scope: "workspace" | "platform",
      annotations: Readonly<Record<string, string>> = {
        "openclaw.dev/prepared-git-binding": owner,
      },
    ): OpenShellStoredProviderProfile => ({
      id,
      resourceVersion: "1",
      annotations,
      definition: { id, scope },
    });
    const foreign = "oce-git-" + "c".repeat(32);
    const calls: [
      operation: "deleteProvider" | "listProviderProfiles" | "deleteProviderProfile",
      target: string,
    ][] = [];
    const provider = (
      name: string,
      type: string,
      labels: Readonly<Record<string, string>>,
    ): OpenShellProviderResponse => ({
      name,
      type,
      labels,
      resourceVersion: "1",
      config: {},
    });
    await deleteOpenShellPreparedGitProviders(
      {
        async deleteProvider(workspace, name) {
          assert.equal(workspace, "git-dogfood");
          calls.push(["deleteProvider", name]);
        },
        async listProviderProfiles(workspace) {
          calls.push(["listProviderProfiles", workspace]);
          return [
            profile(prepared, "workspace"),
            profile(installation, "workspace"),
            profile(prepared, "platform"),
            profile(foreign, "workspace"),
            profile("github", "workspace"),
            profile(prepared, "workspace", {}),
          ];
        },
        async deleteProviderProfile(workspace, id) {
          assert.equal(workspace, "git-dogfood");
          calls.push(["deleteProviderProfile", id]);
        },
      },
      "git-dogfood",
      [
        provider(prepared, prepared, { "openclaw.dev/prepared-git-binding": owner }),
        provider("github", "github", { "openclaw.dev/prepared-git-binding": owner }),
        provider(foreign, foreign, {}),
        // A preparation names the provider after its own profile; another type is not one.
        provider(installation, "github", { "openclaw.dev/prepared-git-binding": owner }),
      ],
      signal(),
    );
    assert.deepEqual(calls, [
      ["deleteProvider", prepared],
      ["listProviderProfiles", "git-dogfood"],
      ["deleteProviderProfile", prepared],
      ["deleteProviderProfile", installation],
    ]);
  });
}
