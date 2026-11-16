import assert from "node:assert/strict";
import test from "node:test";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  admitLoggingConfiguration,
  type AgentRevision,
  type ComputeRevisionContext,
  type OpenClawConfigurationDocument,
} from "../../packages/contracts/src/index.ts";
import { assertCleanupFailure } from "../helpers/compute-cleanup-failure.mjs";
import {
  sshGatewayPasswordRefusal,
  unreadableGatewayPasswordRefusal,
  unreadableSecretRefProblem,
} from "../helpers/refusal-text.mjs";
import {
  bind,
  expectedRuntimeConfiguration,
  fixture,
  json,
  missing,
  prepare,
  revision,
  seedHistoricalSnapshot,
  stage,
  tenant,
} from "./ssh-compute-fixture.ts";

// The shared JavaScript formatter can return arbitrary data at the type boundary.
const secretRefProblem: (kind: "defaultAlias", alias: string) => unknown =
  unreadableSecretRefProblem;

test("SSH trusted-proxy can opt into direct loopback password authentication", async (t) => {
  const f = await fixture(t);
  const password = revision(f.driver, 1, "agent-ssh-string-password", {
    gateway: { tls: { enabled: false }, auth: { password: "${OPENCLAW_GATEWAY_PASSWORD}" } },
  });
  await prepare(f, password);
  assert.match(
    await readFile(join(f.agentDir(password), "gateway-password.env"), "utf8"),
    /^OPENCLAW_GATEWAY_PASSWORD=[a-f0-9]{64}\n$/,
  );
  assert.deepEqual(
    await json(join(f.revisionDir(password), "openclaw.json")),
    expectedRuntimeConfiguration(password),
  );

  const rev = revision(f.driver, 1, "agent-ssh-proxy-password", {
    gateway: {
      auth: {
        mode: "trusted-proxy",
        password: "${OPENCLAW_GATEWAY_PASSWORD}",
        trustedProxy: { userHeader: "x-user" },
      },
    },
  });
  await prepare(f, rev);
  assert.match(
    await readFile(join(f.agentDir(rev), "gateway-password.env"), "utf8"),
    /^OPENCLAW_GATEWAY_PASSWORD=[a-f0-9]{64}\n$/,
  );
  assert.match(
    await readFile(join(f.units, f.unit(rev)), "utf8"),
    new RegExp(`^EnvironmentFile=${join(f.agentDir(rev), "gateway-password.env")}$`, "m"),
  );
  assert.doesNotMatch(await readFile(join(f.units, f.unit(rev)), "utf8"), /gateway\.env/);
  await missing(join(f.agentDir(rev), "gateway.env"));
  assert.deepEqual(await json(join(f.revisionDir(rev), "openclaw.json")), rev.configuration);
});

// The unit's EnvironmentFile sets OPENCLAW_GATEWAY_PASSWORD, which every env provider reads, so SSH
// renders a readable SecretRef to it on a custom default alias as written (finding 3065), and
// refuses an unset password whose default-provider rendering that alias leaves unreadable. A
// revision SSH admitted before, with the old rendering, still stops and retires: teardown renders
// it as before, so its snapshot hash matches.
test("SSH renders a readable custom-alias gateway password and still tears down older snapshots", async (t) => {
  const f = await fixture(t);
  const custom = { source: "env", provider: "custom", id: "OPENCLAW_GATEWAY_PASSWORD" };
  const rev = revision(f.driver, 1, "agent-ssh-custom-reference", {
    gateway: { tls: { enabled: false }, auth: { mode: "password", password: custom } },
    secrets: { defaults: { env: "custom" } },
  });
  await prepare(f, rev);
  assert.match(
    await readFile(join(f.agentDir(rev), "gateway-password.env"), "utf8"),
    /^OPENCLAW_GATEWAY_PASSWORD=[a-f0-9]{64}\n$/,
  );
  assert.deepEqual(await json(join(f.revisionDir(rev), "openclaw.json")), rev.configuration);

  const unset = revision(f.driver, 1, "agent-ssh-unset-reference", {
    gateway: { tls: { enabled: false } },
    secrets: { defaults: { env: "custom" } },
  });
  await f.driver.ensureNamespace(tenant);
  bind(f.driver, unset);
  const before = f.calls.length;
  const problem = secretRefProblem("defaultAlias", "custom");
  assert.ok(typeof problem === "string");
  await assert.rejects(f.driver.prepareRevision(unset), {
    message: sshGatewayPasswordRefusal.rendered("custom", problem),
  });
  assert.equal(f.calls.length, before);
  // Trusted proxy renders the expression as written, which the runtime substitutes from the
  // unit's environment whatever the alias, so it needs no SecretRef.
  const proxy = revision(f.driver, 1, "agent-ssh-proxy-custom-alias", {
    gateway: {
      auth: {
        mode: "trusted-proxy",
        password: "${OPENCLAW_GATEWAY_PASSWORD}",
        trustedProxy: { userHeader: "x-user" },
      },
    },
    secrets: { defaults: { env: "custom" } },
  });
  await prepare(f, proxy);
  assert.deepEqual(await json(join(f.revisionDir(proxy), "openclaw.json")), proxy.configuration);

  // The old producer admitted the default-provider reference under a custom alias and rendered it
  // as written; seed that snapshot through the real host helper.
  const legacy = revision(f.driver, 1, "agent-ssh-legacy-reference", {
    gateway: {
      tls: { enabled: false },
      auth: { password: { ...custom, provider: "default" } },
    },
    secrets: { defaults: { env: "custom" } },
  });
  bind(f.driver, legacy);
  await assert.rejects(f.driver.prepareRevision(legacy), {
    message: unreadableGatewayPasswordRefusal("defaultAlias", "custom"),
  });
  const configuration = expectedRuntimeConfiguration(legacy);
  await seedHistoricalSnapshot(f, legacy, configuration);
  await f.driver.deactivateRevision(legacy);
  await f.driver.stopRevision(legacy);
  await access(f.revisionDir(legacy));
  await f.driver.retireRevision(legacy);
  await missing(f.revisionDir(legacy));

  // A revision admitted with a custom-provider reference also tears down: teardown renders it as
  // written again, so its snapshot hash matches.
  await f.driver.deactivateRevision(rev);
  await f.driver.stopRevision(rev);
  await f.driver.retireRevision(rev);
  await missing(f.revisionDir(rev));

  // Teardown checks only the password's shape, never whether OpenClaw reads it: a revision admitted
  // under a reader that a later OpenClaw pin tightens must still stop and retire. The current reader
  // refuses this one (the allowlist omits the variable), standing in for that later reader; seed its
  // as-written snapshot through the real host helper, as the legacy Agent's next version (the
  // fixture's port range holds three Agents).
  const tightened = revision(f.driver, 2, "agent-ssh-legacy-reference", {
    gateway: {
      tls: { enabled: false },
      auth: { mode: "password", password: { ...custom, provider: "vault" } },
    },
    secrets: { providers: { vault: { source: "env", allowlist: ["OTHER_SECRET"] } } },
  });
  bind(f.driver, tightened);
  await assert.rejects(f.driver.prepareRevision(tightened), {
    message: unreadableGatewayPasswordRefusal("allowlist", "OPENCLAW_GATEWAY_PASSWORD", "vault"),
  });
  await seedHistoricalSnapshot(f, tightened);
  await f.driver.deactivateRevision(tightened);
  await f.driver.stopRevision(tightened);
  await access(f.revisionDir(tightened));
  await f.driver.retireRevision(tightened);
  await missing(f.revisionDir(tightened));
  // Teardown still checks the shape: a reference to another variable never named the password
  // SSH Compute generates, so stop refuses it before any host call.
  const misshapen = revision(f.driver, 1, "agent-ssh-misshapen-reference", {
    gateway: {
      tls: { enabled: false },
      auth: { mode: "password", password: { ...custom, provider: "default", id: "OTHER_SECRET" } },
    },
  });
  bind(f.driver, misshapen);
  const beforeStop = f.calls.length;
  await assert.rejects(f.driver.stopRevision(misshapen), {
    message: sshGatewayPasswordRefusal.reference(),
  });
  assert.equal(f.calls.length, beforeStop);
});

test("SSH activation invokes lifecycle start hooks and cleans them up after activation failure", async (t) => {
  const hooks: string[] = [];
  const f = await fixture(t, {
    lifecycleDrivers: [
      {
        id: "hooks",
        implementation: "test",
        capability: "configuration",
        computeLifecycleHooks: {
          async beforeWorkloadStart(rev, launch) {
            hooks.push(`start:${rev.id}`);
            launch.environment.PLUGIN_TOKEN = "opaque-plugin-token";
          },
          async beforeWorkloadStop(rev) {
            hooks.push(`stop:${rev.id}`);
          },
        },
      },
    ],
  });
  const rev = await stage(f);
  assert.deepEqual(hooks, []);
  await f.driver.activateRevision(rev);
  assert.deepEqual(hooks, [`start:${rev.id}`]);
  assert.match(
    await readFile(join(f.units, f.unit(rev)), "utf8"),
    /^Environment=PLUGIN_TOKEN=opaque-plugin-token$/m,
  );
  await f.driver.retireRevision(rev);
  assert.deepEqual(hooks, [`start:${rev.id}`, `stop:${rev.id}`]);

  const failed = revision(f.driver, 2);
  await stage(f, failed);
  await writeFile(join(f.revisionDir(failed), "revision.json"), JSON.stringify({ broken: true }));
  await assert.rejects(f.driver.activateRevision(failed), /snapshot|ownership/i);
  assert.deepEqual(hooks, [
    `start:${rev.id}`,
    `stop:${rev.id}`,
    `start:${failed.id}`,
    `stop:${failed.id}`,
  ]);

  const beforeInvalidAuth = [...hooks];
  const invalidAuth = revision(f.driver, 3, "agent-ssh-invalid-auth", {
    gateway: { auth: { unsupportedField: true } },
  });
  bind(f.driver, invalidAuth);
  await assert.rejects(
    f.driver.activateRevision(invalidAuth),
    /gateway\.auth\.unsupportedField is not a supported native gateway authentication field/,
  );
  assert.deepEqual(hooks, beforeInvalidAuth);
});

// Finding 2268: when the lifecycle cleanup after a failed activation fails too, the activation's
// own failure stays first, so the worker classifies the deployment by it, and the cleanup
// failure follows it instead of replacing it.
test("SSH activation keeps its own failure first when the lifecycle cleanup also fails", async (t) => {
  const f = await fixture(t, {
    lifecycleDrivers: [
      {
        id: "hooks",
        implementation: "test",
        capability: "configuration",
        computeLifecycleHooks: {
          async beforeWorkloadStart() {},
          async beforeWorkloadStop() {
            throw new Error("lifecycle cleanup refused");
          },
        },
      },
    ],
  });
  const failed = await stage(f);
  await writeFile(join(f.revisionDir(failed), "revision.json"), JSON.stringify({ broken: true }));
  const error = await f.driver.activateRevision(failed).then(
    () => assert.fail("the activation must fail"),
    (failure: unknown) => failure,
  );
  assertCleanupFailure(error, /snapshot|ownership/i, [/lifecycle hook beforeWorkloadStop failed/]);
});

test("SSH revisions fail closed on invalid identities and unsupported workload features", async (t) => {
  const f = await fixture(t);
  const rev = revision(f.driver);
  await assert.rejects(f.driver.prepareRevision(rev), /bound Namespace and Agent/);
  await f.driver.ensureNamespace(tenant);
  bind(f.driver, rev);
  const managed = { ...rev, gatewayManagedMode: true };
  const unsupportedManaged = {
    name: "ConfigurationHarnessError",
    message: "Agent setting gatewayManagedMode is not supported on SSH Compute.",
  };
  const beforeManagedMode = f.calls.length;
  await assert.rejects(f.driver.prepareRevision(managed), unsupportedManaged);
  await assert.rejects(f.driver.activateRevision(managed), unsupportedManaged);
  assert.equal(f.calls.length, beforeManagedMode);
  // These JavaScript inputs deliberately bypass the admitted revision contract.
  const malformedAuth: readonly unknown[] = [undefined, { method: "runtime", source: {} }];
  for (const harnessAuth of malformedAuth) {
    await assert.rejects(
      f.driver.prepareRevision({
        ...rev,
        harnessAuth: harnessAuth as AgentRevision["harnessAuth"],
      }),
      /operator-managed/,
    );
  }
  // Another method is an Agent setting the caller can change: OCC answers 400 with this message.
  for (const harnessAuth of [{ method: "api_key" }, { method: "chatgpt_service_account" }]) {
    await assert.rejects(
      f.driver.prepareRevision({
        ...rev,
        harnessAuth: harnessAuth as AgentRevision["harnessAuth"],
      }),
      {
        name: "ConfigurationHarnessError",
        message:
          "Agent setting harnessAuth.method must be runtime for embedded OpenClaw on SSH Compute: change harnessAuth.",
      },
    );
  }
  const unsupportedHarnesses = [
    { id: "codex", mode: "dedicated" },
    { id: "openclaw", mode: "dedicated" },
    { id: "other", mode: "embedded" },
  ] as const;
  for (const harness of unsupportedHarnesses) {
    await assert.rejects(
      f.driver.prepareRevision({ ...rev, harness: { ...rev.harness, version: "1", ...harness } }),
      /only embedded OpenClaw/,
    );
  }
  const injectedContext: ComputeRevisionContext = {
    harnessAuth: { method: "runtime" },
    secretEnvironment: [
      {
        name: "MODEL_KEY",
        secretId: "secret-1",
        namespaceId: rev.namespaceId,
        agentId: rev.agentId,
        backendRef: {
          namespaceName: tenant.name,
          name: "model-key",
          key: "value",
          uid: "secret-1",
        },
      },
    ],
  };
  await assert.rejects(f.driver.prepareRevision(rev, injectedContext), /operator-owned.*env/);
  await assert.rejects(
    f.driver.prepareRevision({
      ...rev,
      secretBindings: {
        MODEL_KEY: { source: { kind: "secret", id: "secret-1", namespaceId: tenant.id } },
      },
    }),
    /operator-owned.*env/,
  );
  await assert.rejects(
    f.driver.prepareRevision({ ...rev, sandboxDriverId: "sandbox" }),
    /SandboxDriver/,
  );
  await assert.rejects(
    f.driver.prepareRevision({
      ...rev,
      plugins: {
        driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
        plugins: { "occ-plugin:diffs": { enabled: true, toolDefaults: { approval: "none" } } },
      },
    }),
    /PluginDriver installation/,
  );
  const beforeApproverPolicy = f.calls.length;
  for (const pluginApprovers of [[], [{ channel: "slack", id: "team:T123:user:U123" }]] as const) {
    await assert.rejects(
      f.driver.prepareRevision({ ...rev, pluginApprovers }),
      /plugin approver policy/,
    );
    assert.equal(f.calls.length, beforeApproverPolicy);
  }
  const invalidConfigurations: OpenClawConfigurationDocument[] = [
    { gateway: { auth: { mode: "oauth" } } },
    { gateway: { auth: { unsupportedField: true } } },
    { gateway: { auth: { password: "plaintext" } } },
    { gateway: { tls: { enabled: true } } },
  ];
  for (const configuration of invalidConfigurations) {
    await assert.rejects(
      f.driver.prepareRevision({
        ...rev,
        configuration: admitLoggingConfiguration(configuration, "info"),
      }),
      /gateway authentication|OPENCLAW_GATEWAY_PASSWORD|gateway\.tls\.enabled/,
    );
  }
  await assert.rejects(
    f.driver.prepareRevision({
      ...rev,
      configuration: admitLoggingConfiguration(
        {
          plugins: {
            entries: { codex: { config: { appServer: { approvalPolicy: "untrusted" } } } },
          },
        },
        "info",
      ),
    }),
    /appServer\.approvalPolicy must not be "untrusted", which the OpenClaw runtime retired/,
  );
  // Bind an Agent in a second Namespace; a revision naming it reaches the ownership check.
  const otherNamespace = { ...tenant, id: "ns-ssh-other" };
  bind(f.driver, revision(f.driver, 1, "agent-ssh-other"), otherNamespace);
  const ownership = /AgentRevision ownership or selected Compute Driver differs/;
  for (const [change, refusal] of [
    [{ servicePrincipalId: "foreign" }, ownership],
    [{ namespaceId: "foreign" }, /SSH revision requires a bound Namespace and Agent/],
    [{ agentId: "agent-ssh-unbound" }, /SSH revision requires a bound Namespace and Agent/],
    [{ namespaceId: otherNamespace.id }, ownership],
    [{ compute: { ...rev.compute, id: "foreign" } }, ownership],
    [{ compute: { ...rev.compute, implementation: "occ/foreign" } }, ownership],
  ] as const) {
    await assert.rejects(f.driver.prepareRevision({ ...rev, ...change }), refusal);
  }
  await missing(f.agentDir(rev));
});
