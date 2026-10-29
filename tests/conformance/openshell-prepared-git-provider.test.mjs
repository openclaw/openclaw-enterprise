import { preparedGitWire } from "../helpers/openshell-prepared-git-wire.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenShellPreparedGitProvider,
  OpenShellPreparedGitProviderError,
  deleteOpenShellPreparedGitProviders,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts";

const scope = {
  workspace: "git-dogfood",
  workspaceId: "workspace-id",
  sandbox: "git-execution",
  executionId: "execution-one",
  repository: "example/project",
  gitOrigin: "https://github.com",
  apiOrigin: "https://api.github.com",
  binaries: ["/usr/bin/git", "/usr/bin/gh"],
};
const token = (suffix = "first") => ({
  value: `synthetic-installation-token_${suffix}`,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
});
const signal = () => AbortSignal.timeout(5_000);

const wire = (t) => preparedGitWire(t, scope);

// These are protocol conformance checks over a real gRPC socket with synthetic
// material, not an installed supervisor, Git sender, or live-provider proof.
test("prepared Git static token and rotation use released fields without returning credentials or readiness", async (t) => {
  const { state, binding } = await wire(t);
  const first = token();
  const receipt = await binding.prepare(first, signal());
  assert.equal(receipt.update, "accepted");
  assert.equal(receipt.supervisor, "unknown");
  assert.equal(receipt.providerId, "provider-id");
  assert.equal(receipt.resourceVersion, "1");
  assert.equal(receipt.readiness.rpc, "GetSandboxProviderStatus");
  assert.equal(JSON.stringify(receipt).includes(first.value), false);
  assert.deepEqual(state.profile.credentials, [
    {
      name: "installation_token",
      env_vars: ["GITHUB_TOKEN"],
      required: true,
      auth_style: "bearer",
      header_name: "authorization",
      stable_placeholder: true,
    },
  ]);
  assert.deepEqual(
    state.profile.endpoints.map(({ host, port, path, tls }) => ({ host, port, path, tls })),
    [
      {
        host: "github.com",
        port: 443,
        path: "/example/project.git/**",
        tls: undefined,
      },
      {
        host: "api.github.com",
        port: 443,
        path: "/repos/example/project/pulls",
        tls: undefined,
      },
    ],
  );
  assert.equal(state.provider.credentials.GITHUB_TOKEN, first.value);
  assert.equal(state.provider.profile_workspace, scope.workspace);
  assert.equal(
    state.provider.credential_expiration_times.GITHUB_TOKEN.seconds,
    String(Math.floor(Date.parse(first.expiresAt) / 1000)),
  );
  const next = token("successor");
  const rotated = await binding.rotate(receipt, async () => next, signal());
  assert.equal(rotated.resourceVersion, "2");
  assert.equal(rotated.supervisor, "unknown");
  assert.equal(JSON.stringify(rotated).includes(next.value), false);
  const update = state.requests.at(-1);
  assert.equal(update.provider.metadata.resource_version, "1");
  assert.equal(update.provider.credentials.GITHUB_TOKEN, next.value);
  assert.equal(
    update.credential_expiration_times.GITHUB_TOKEN.seconds,
    String(Math.floor(Date.parse(next.expiresAt) / 1000)),
  );
});

test("prepared Git refuses foreign, stale, changed-profile and replaced-workspace bindings before token update", async (t) => {
  const { state, binding, client } = await wire(t);
  const receipt = await binding.prepare(token(), signal());
  const original = structuredClone(state.provider);
  for (const mutation of [
    () => {
      state.provider.metadata.id = "foreign-provider";
    },
    () => {
      state.provider.metadata.resource_version = "2";
    },
    () => {
      state.provider.metadata.labels = {};
    },
    () => {
      state.profile.resource_version = "2";
    },
    () => {
      state.workspaceId = "replacement-workspace";
    },
  ]) {
    state.provider = structuredClone(original);
    state.profile.resource_version = "1";
    state.workspaceId = scope.workspaceId;
    mutation();
    await assert.rejects(
      binding.rotate(receipt, async () => token("rejected"), signal()),
      (error) => error instanceof OpenShellPreparedGitProviderError && error.outcome === "refused",
    );
    assert.equal(
      state.requests.some((request) => request.provider?.metadata?.resource_version),
      false,
    );
  }
  const replacement = new OpenShellPreparedGitProvider(client, {
    ...scope,
    executionId: "successor",
  });
  await assert.rejects(
    replacement.rotate(receipt, async () => token(), signal()),
    /refused/,
  );
});

test("prepared Git preserves uncertain write outcomes and redacts private gateway failures", async (t) => {
  const { state, binding } = await wire(t);
  const receipt = await binding.prepare(token(), signal());
  state.lost = true;
  const next = token("private_successor");
  await assert.rejects(
    binding.rotate(receipt, async () => next, signal()),
    (error) =>
      error.outcome === "unknown" &&
      !String(error.stack).includes(next.value) &&
      error.cause === undefined,
  );
  assert.equal(
    state.requests.filter((request) => request.provider?.metadata?.resource_version).length,
    1,
  );
  assert.equal(
    state.provider.metadata.resource_version,
    "2",
    "lost reply cannot justify resubmission",
  );
});

test("prepared Git writes outlive the caller's read budget, and a caller out of time sends nothing", async (t) => {
  // Finding 2211: the caller's signal is a reconcile pass's read budget. A write, once sent,
  // runs to its own deadline: abandoning it would leave its outcome unknown and close the route.
  const { state, binding } = await wire(t);
  const abortOn = (sent) => {
    const caller = new AbortController();
    state.onRequest = (request) => {
      if (sent(request)) {
        caller.abort(new Error("the pass ran out of time"));
      }
    };
    return caller.signal;
  };
  state.writeDelayMs = 200;
  const bootstrap = await binding.bootstrap(abortOn((request) => "profiles" in request));
  assert.equal(bootstrap.credentialState, "bootstrap");
  assert.equal(state.provider.credentials.GITHUB_TOKEN, "oce-unprivileged-bootstrap-sentinel");
  const isUpdate = (request) => !!request.provider?.metadata?.resource_version;
  const active = await binding.rotate(bootstrap, async () => token(), abortOn(isUpdate));
  assert.equal(active.credentialState, "active");
  assert.equal(active.resourceVersion, "2");
  state.writeDelayMs = 0;

  // Out of time before the write, for any reason (here the worker's claim ended): nothing is
  // sent, and the refusal is a timeout the caller retries, not a verdict on the provider.
  const late = new AbortController();
  const skipped = await binding.rotate(
    active,
    async () => {
      late.abort(new Error("claim lost"));
      return token("late");
    },
    late.signal,
  );
  assert.equal(skipped, undefined);
  assert.equal(state.requests.filter(isUpdate).length, 1);
  const fresh = await wire(t);
  const caller = new AbortController();
  fresh.state.onRequest = (request) => {
    if (request.name !== undefined) {
      caller.abort(new Error("claim lost"));
    }
  };
  await assert.rejects(
    fresh.binding.bootstrap(caller.signal),
    (error) =>
      error instanceof OpenShellPreparedGitProviderError &&
      error.outcome === "refused" &&
      error.readFailure === "timeout",
  );
  assert.deepEqual([fresh.state.profile, fresh.state.provider], [undefined, undefined]);
  // Out of time just after the last read answered: the write does not start.
  const between = await wire(t);
  const ended = new AbortController();
  const getProvider = between.client.getProvider.bind(between.client);
  between.client.getProvider = async (...args) => {
    const answer = await getProvider(...args);
    ended.abort(new Error("claim lost"));
    return answer;
  };
  await assert.rejects(
    between.binding.bootstrap(ended.signal),
    (error) => error.outcome === "refused" && error.readFailure === "timeout",
  );
  assert.deepEqual([between.state.profile, between.state.provider], [undefined, undefined]);

  // A gateway that refuses the worker's identity is a refusal, never a retryable read failure,
  // even when the caller's signal ends at the same moment.
  const denied = await wire(t);
  denied.state.denyReads = true;
  const refusedAs = (readFailure) => (error) =>
    error instanceof OpenShellPreparedGitProviderError &&
    error.outcome === "refused" &&
    error.readFailure === readFailure;
  await assert.rejects(denied.binding.bootstrap(signal()), refusedAs(undefined));
  const deniedCaller = new AbortController();
  const getProfile = denied.client.getProviderProfile.bind(denied.client);
  denied.client.getProviderProfile = async (...args) => {
    try {
      return await getProfile(...args);
    } finally {
      deniedCaller.abort(new Error("claim lost"));
    }
  };
  await assert.rejects(denied.binding.bootstrap(deniedCaller.signal), refusedAs(undefined));
  assert.equal(denied.state.provider, undefined);
});

test("prepared Git sends a CAS precondition and fails closed on a concurrent gateway update", async (t) => {
  const { state, binding } = await wire(t);
  const receipt = await binding.prepare(token(), signal());
  state.conflict = true;
  await assert.rejects(
    binding.rotate(receipt, async () => token("racing"), signal()),
    /unknown/,
  );
  assert.equal(state.provider.metadata.resource_version, "1");
  assert.equal(
    state.requests.filter((request) => request.provider?.metadata?.resource_version).length,
    1,
  );
});

test("prepared Git rejects credential and scope widening before provisioning", async (t) => {
  const { state, binding, client } = await wire(t);
  for (const invalid of [
    { ...token(), expiresAt: new Date(Date.now() + 7_200_000).toISOString() },
    { ...token(), value: "-----BEGIN PRIVATE KEY-----" },
    { ...token(), value: "openshell:resolve:env:NOT_A_TOKEN" },
  ]) {
    await assert.rejects(binding.prepare(invalid, signal()), /refused/);
  }
  for (const widened of [
    { binaries: [] },
    { repository: "example/../project" },
    { gitOrigin: "http://github.com" },
    { apiOrigin: "https://*.github.com" },
    { workspace: "" },
  ]) {
    assert.throws(
      () => new OpenShellPreparedGitProvider(client, { ...scope, ...widened }),
      OpenShellPreparedGitProviderError,
    );
  }
  assert.equal(state.requests.length, 0);
});

function installedStatus(binding) {
  const now = { seconds: String(Math.floor(Date.now() / 1000)), nanos: 0 };
  return {
    state: "PROVIDER_READINESS_STATE_READY",
    reason: "PROVIDER_READINESS_REASON_UNSPECIFIED",
    receipt: {
      workspace: scope.workspace,
      provider: binding.provider,
      desired: {
        sandbox_id: "sandbox-id",
        sandbox: scope.sandbox,
        attachment_epoch: "attachment-one",
        provider_id: binding.providerId,
        provider_resource_version: binding.resourceVersion,
        provider_env_revision: "101",
        config_revision: "202",
        policy_hash: "policy-hash",
      },
    },
    observed: {
      session_id: "supervisor-session",
      sequence: "1",
      attachment_epoch: "attachment-one",
      provider_env_revision: "101",
      config_revision: "202",
      policy_hash: "policy-hash",
      credentials_installed: true,
      policy_active: true,
      launch_environment_installed: true,
      process_instance_id: "process-instance",
      reason: "PROVIDER_READINESS_REASON_UNSPECIFIED",
    },
    network_instance_id: "network-instance",
    observed_time: now,
    evaluated_time: now,
  };
}

test("prepared Git bootstraps without privilege and distinguishes accepted rotation from exact installed state", async (t) => {
  const { state, binding } = await wire(t);
  const bootstrap = await binding.bootstrap(signal());
  assert.equal(bootstrap.credentialState, "bootstrap");
  assert.equal(bootstrap.expiresAt, "");
  assert.equal(state.provider.credentials.GITHUB_TOKEN, "oce-unprivileged-bootstrap-sentinel");
  assert.equal(await binding.observe(bootstrap, "sandbox-id", signal()), undefined);
  state.status = installedStatus(bootstrap);
  assert.equal(
    (await binding.observe(bootstrap, "sandbox-id", signal())).credentialState,
    "bootstrap",
  );
  const active = await binding.rotate(bootstrap, async () => token(), signal());
  assert.equal(active.credentialState, "active");
  assert.equal(
    await binding.observe(active, "sandbox-id", signal()),
    undefined,
    "old installed version is not updated provider evidence",
  );
  state.status = installedStatus(active);
  const installed = await binding.observe(active, "sandbox-id", signal());
  assert.equal(installed.providerResourceVersion, "2");
  assert.equal(installed.supervisorSessionId, "supervisor-session");
  assert.equal(installed.networkInstanceId, "network-instance");
  assert.equal(installed.credentialState, "active");
  assert.equal(await binding.observe(bootstrap, "sandbox-id", signal()), undefined);
  state.status.observed.sequence = "2";
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
});

test("prepared Git refuses stale, partial, mismatched and unavailable installation observations", async (t) => {
  const { state, binding } = await wire(t);
  const active = await binding.prepare(token(), signal());
  const complete = installedStatus(active);
  for (const mutate of [
    (status) => {
      delete status.receipt;
    },
    (status) => {
      delete status.observed;
    },
    (status) => {
      status.state = "PROVIDER_READINESS_STATE_PENDING";
    },
    (status) => {
      status.receipt.workspace = "foreign";
    },
    (status) => {
      status.receipt.provider = "foreign";
    },
    (status) => {
      status.receipt.desired.sandbox_id = "replacement";
    },
    (status) => {
      status.receipt.desired.provider_id = "replacement";
    },
    (status) => {
      status.receipt.desired.provider_resource_version = "99";
    },
    (status) => {
      status.observed.attachment_epoch = "old";
    },
    (status) => {
      status.observed.provider_env_revision = "100";
    },
    (status) => {
      status.observed.config_revision = "201";
    },
    (status) => {
      status.observed.policy_hash = "old";
    },
    (status) => {
      status.observed.session_id = "";
    },
    (status) => {
      status.observed.credentials_installed = false;
    },
    (status) => {
      status.observed.policy_active = false;
    },
    (status) => {
      status.observed.launch_environment_installed = false;
    },
    (status) => {
      status.observed.process_instance_id = "";
    },
    (status) => {
      status.network_instance_id = "";
    },
    (status) => {
      delete status.observed_time;
    },
    (status) => {
      status.evaluated_time.seconds = "1";
    },
  ]) {
    state.status = structuredClone(complete);
    mutate(state.status);
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
  state.status = installedStatus(active);
  const installed = await binding.observe(active, "sandbox-id", signal());
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
    (status) => {
      status.reason = "PROVIDER_READINESS_REASON_WAITING_FOR_SUPERVISOR";
    },
    (status) => {
      status.state = "PROVIDER_READINESS_STATE_READY";
    },
    (status) => {
      status.state = "PROVIDER_READINESS_STATE_WITHHELD";
    },
    (status) => {
      status.receipt.desired.config_revision = "203";
    },
    (status) => {
      status.receipt.desired.policy_hash = "other-policy";
    },
    (status) => {
      status.receipt.desired.attachment_epoch = "attachment-two";
    },
    (status) => {
      status.receipt.desired.provider_resource_version = "99";
    },
    (status) => {
      status.observed.session_id = "other-session";
    },
    (status) => {
      status.observed.process_instance_id = "other-process";
    },
    (status) => {
      status.network_instance_id = "other-network";
    },
    (status) => {
      status.observed.provider_env_revision = "";
    },
    (status) => {
      status.observed.credentials_installed = false;
    },
    (status) => {
      status.evaluated_time.seconds = "1";
    },
  ]) {
    state.status = sibling();
    mutate(state.status);
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
  state.status = installedStatus(active);
  state.status.receipt.desired.provider_env_revision = "102";
  state.status.observed.provider_env_revision = "102";
  const moved = await binding.observe(active, "sandbox-id", signal(), installed);
  assert.equal(moved.providerEnvRevision, "102");
  assert.deepEqual({ ...moved, providerEnvRevision: "101" }, installed);
});

// Namespace cleanup (finding 2206) deletes only the Workspace's own prepared Git profiles: the
// listing also returns platform and static profiles, and an unprepared or foreign-named one.
test("Namespace cleanup deletes only workspace-scoped prepared Git profiles", async () => {
  const owner = "b".repeat(48);
  const prepared = "oce-git-" + "b".repeat(32);
  const installation = "oce-github-installation-" + "b".repeat(32);
  const profile = (id, scope, annotations = { "openclaw.dev/prepared-git-binding": owner }) => ({
    id,
    resourceVersion: "1",
    annotations,
    definition: { id, scope },
  });
  const calls = [];
  await deleteOpenShellPreparedGitProviders(
    {
      async deleteProvider(_workspace, name) {
        calls.push(["deleteProvider", name]);
      },
      async listProviderProfiles(workspace) {
        calls.push(["listProviderProfiles", workspace]);
        return [
          profile(prepared, "workspace"),
          profile(installation, "workspace"),
          profile(prepared, "platform"),
          profile("oce-git-" + "c".repeat(32), "workspace"),
          profile("github", "workspace"),
          profile(prepared, "workspace", {}),
        ];
      },
      async deleteProviderProfile(_workspace, id) {
        calls.push(["deleteProviderProfile", id]);
      },
    },
    "git-dogfood",
    [
      { name: prepared, type: prepared, labels: { "openclaw.dev/prepared-git-binding": owner } },
      { name: "github", type: "github", labels: { "openclaw.dev/prepared-git-binding": owner } },
      { name: "oce-git-" + "c".repeat(32), type: "oce-git-" + "c".repeat(32), labels: {} },
      // A preparation names the provider after its own profile; another type is not one.
      {
        name: installation,
        type: "github",
        labels: { "openclaw.dev/prepared-git-binding": owner },
      },
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
