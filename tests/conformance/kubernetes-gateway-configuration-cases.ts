import { asRecord } from "../../packages/utils/src/index.ts";
import { ConfigurationHarnessError } from "../../packages/occ/src/index.ts";
import type {
  HarnessAuthSnapshot,
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
  RevisionHarnessDescriptor,
  SandboxDriver,
  SecretBindings,
} from "../../packages/contracts/src/index.ts";
import { workspaceSetupFixture } from "../helpers/kubernetes-workspace-setup.ts";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import assert from "node:assert/strict";
import {
  createKubernetesComputeDriver,
  KubernetesComputeDriver,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { managedGatewayConfiguration } from "../../apps/controller/src/drivers/compute/gateway-tool-policy.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  KUBERNETES_GATEWAY_PASSWORD_REFUSAL,
  dedicatedCodexVariableRefusal,
  pluginEntryKeyVariantRefusal,
  unboundPluginSecretRefusal,
  unreadablePluginSecretRefusal,
  unboundUnreadablePluginSecretRefusal,
  appServerUnreadablePluginSecretRefusal,
  unreadableGatewayPasswordRefusal,
} from "../helpers/refusal-text.mjs";
import {
  tenant,
  apiKeyAuth as routedApiKeyAuth,
  options,
} from "../helpers/kubernetes-routed-scenarios.mjs";
import { OPENCLAW_CONFIG_ENVIRONMENT_COMMIT } from "../../apps/controller/src/drivers/compute/kubernetes/openclaw-config-environment.ts";
import { readOpenclawSource } from "../../scripts/lib/openclaw-source.mjs";

// Keep the shared fixture's identity while recovering its JavaScript literal types.
const apiKeyAuth = {
  ...routedApiKeyAuth,
  method: "api_key",
  source: { ...routedApiKeyAuth.source, kind: "secret" },
} satisfies HarnessAuthSnapshot;

export function enforceDedicatedGatewayToolAllowlist() {
  const tool = "oce_mcp_docs_ListItems";
  const standard = { tools: { alsoAllow: ["diffs"] } };
  const tools = asRecord(
    managedGatewayConfiguration(standard, standard, false, undefined, [tool]).tools,
  );
  assert.ok(tools);
  assert.deepEqual(tools.alsoAllow, ["diffs", "oce_mcp_docs_listitems"]);
  const gatewayAllow = asRecord(tools.gatewayPolicy)?.allow;
  assert.ok(Array.isArray(gatewayAllow) && gatewayAllow.includes("oce_mcp_docs_listitems"));

  const explicit = { tools: { allow: ["exec"], deny: ["oce_mcp_docs_listitems"] } };
  const configured = asRecord(
    managedGatewayConfiguration(explicit, explicit, false, undefined, [tool]).tools,
  );
  assert.ok(configured);
  assert.deepEqual(configured.allow, ["exec", "oce_mcp_docs_listitems"]);
  assert.equal(configured.alsoAllow, undefined);
  assert.deepEqual(configured.deny, explicit.tools.deny);

  const restricted = { tools: { gatewayPolicy: { allow: ["exec"] } } };
  const denied = asRecord(
    managedGatewayConfiguration(restricted, restricted, false, undefined, [tool]).tools,
  );
  assert.ok(denied);
  assert.deepEqual(asRecord(denied.gatewayPolicy)?.allow, ["exec"]);
  assert.equal(denied.alsoAllow, undefined);
  assert.throws(
    () => managedGatewayConfiguration(standard, standard, false, undefined, ["gateway_exec"]),
    /must not grant Gateway administrative tools/,
  );
}

// A Sandbox Driver for admission cases that never provision Dedicated OpenClaw.
export function admissionSandboxDriver(): SandboxDriver {
  return {
    id: "sandbox-openshell",
    capability: "sandbox",
    implementation: "admission-fixture",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["networking", "filesystem", "process"],
    async provisionHarness() {
      assert.fail("Admission must not provision a Harness.");
    },
    async cleanup() {
      assert.fail("Admission must not clean up a Sandbox.");
    },
  };
}

export function rejectPluginEntryKeyVariants() {
  // Finding 3077. OpenClaw merges plugins.entries keys that match trimmed and lowercased. The
  // Gateway entrypoint enables and configures file-transfer for a workspace node, and renders the
  // managed catalog plugin diffs for the Agent's plugin selection, both only at the exact key, so a
  // later `File-Transfer` entry could turn the workspace node's plugin off and a `Diffs` entry
  // could replace the managed one. Configuration save, Preset save and deploy admission refuse it;
  // configuration-controller.test.mjs proves a Preset key that waits on a variable.
  const driver = new KubernetesComputeDriver(options());
  const codex = {
    id: "codex",
    version: "1.0.0",
    mode: "dedicated",
  } satisfies RevisionHarnessDescriptor;
  const base = { agents: { defaults: { model: "codex/gpt-5" } } };
  const withEntries = (entries: OpenClawConfigurationDocument) => ({
    ...base,
    plugins: { entries },
  });
  for (const [entries, path, id] of [
    [
      { "file-transfer": {}, "File-Transfer": { enabled: false } },
      "plugins.entries.File-Transfer",
      "file-transfer",
    ],
    [
      { " file-transfer": { enabled: false } },
      'plugins.entries[" file-transfer"]',
      "file-transfer",
    ],
    [{ diffs: { enabled: true }, Diffs: { config: {} } }, "plugins.entries.Diffs", "diffs"],
  ] as const) {
    const expected = {
      name: "ConfigurationHarnessError",
      message: pluginEntryKeyVariantRefusal(path, id),
    };
    assert.throws(() => driver.validateConfiguration(withEntries(entries)), expected);
    assert.throws(
      () => driver.validateHarnessAuth(codex, apiKeyAuth, withEntries(entries), {}),
      expected,
    );
  }
  // The exact keys, and other plugins' keys in another spelling, are accepted.
  for (const entries of [
    { "file-transfer": { enabled: true }, diffs: { enabled: true } },
    { "File-Transfers": {}, Slack: { enabled: false } },
  ]) {
    driver.validateConfiguration(withEntries(entries));
    driver.validateHarnessAuth(codex, apiKeyAuth, withEntries(entries), {});
  }
}

export async function checkOpenClawConfigurationEnvironmentPin() {
  // A stale copy of OpenClaw's host environment policy could take a variable it drops as set,
  // and admit a Gateway that exits at every start (finding 3059).
  const { commit } = await readOpenclawSource();
  assert.equal(
    OPENCLAW_CONFIG_ENVIRONMENT_COMMIT,
    commit,
    "deploy/runtime/openclaw-source.json changed: review openclaw-config-environment.ts against it",
  );
}

type PluginConfiguration = OpenClawConfigurationDocument & {
  plugins?: OpenClawConfigurationDocument & { entries?: OpenClawConfigurationDocument };
};

export function validatePluginSecretInputs() {
  // OpenClaw resolves an active plugin's Gateway-required secret inputs (no ownerKind in the
  // manifest: codex appServer.authToken and appServer.headers.*, google webSearch.headers.*) at
  // startup and exits when a referenced variable is unset ("required secrets are unavailable"),
  // so the deployment waits for its 15-minute convergence deadline (findings 3040, 3041, 3042).
  // Every topology's Gateway keeps the caller's plugin entries and receives its bindings.
  // Kubernetes Compute sets the APP_SERVER_ variables only in a Dedicated Codex Gateway; any other
  // name a Secret binding could set is set only by a binding.
  const driver = new KubernetesComputeDriver(options());
  const nativeDriver = new KubernetesComputeDriver(options(), {
    sandboxDriver: admissionSandboxDriver(),
  });
  const embedded = {
    id: "openclaw",
    version: "1.0.0",
    mode: "embedded",
  } satisfies RevisionHarnessDescriptor;
  const native = {
    id: "openclaw",
    version: "1.0.0",
    mode: "dedicated",
  } satisfies RevisionHarnessDescriptor;
  const codex = {
    id: "codex",
    version: "1.0.0",
    mode: "dedicated",
  } satisfies RevisionHarnessDescriptor;
  const appServer = {
    transport: "websocket",
    url: "${APP_SERVER_URL}",
    authToken: "${APP_SERVER_TOKEN}",
  };
  const embeddedBase = { agents: { defaults: { model: "openai/gpt-5" } } };
  const withEntries = (base: PluginConfiguration, entries: OpenClawConfigurationDocument) => ({
    ...base,
    plugins: { ...base.plugins, entries: { ...base.plugins?.entries, ...entries } },
  });
  const withPlugin = (
    id: string,
    entry: OpenClawConfigurationValue,
    plugins: OpenClawConfigurationDocument = {},
  ) => ({
    ...embeddedBase,
    plugins: { ...plugins, entries: { [id]: entry } },
  });
  const withCodex = (entry: OpenClawConfigurationValue, plugins?: OpenClawConfigurationDocument) =>
    withPlugin("codex", entry, plugins);
  const searchHeaderEntry = (
    value: OpenClawConfigurationValue,
    entry: OpenClawConfigurationDocument = {},
  ) => ({
    google: { ...entry, config: { webSearch: { headers: { "X-Key": value } } } },
  });
  const withSearchHeader = (
    value: OpenClawConfigurationValue,
    entry?: OpenClawConfigurationDocument,
    plugins?: OpenClawConfigurationDocument,
  ) => withPlugin("google", searchHeaderEntry(value, entry).google, plugins);
  const authToken = "plugins.entries.codex.config.appServer.authToken";
  const relayHeader = "plugins.entries.codex.config.appServer.headers.X-Relay";
  const searchHeader = "plugins.entries.google.config.webSearch.headers.X-Key";
  const refusal = (message: string) => ({ name: "ConfigurationHarnessError", message });
  const envRef = (id: string) => ({ source: "env", provider: "default", id });
  const longName = `APP_SERVER_${"X".repeat(30)}`;
  const source = { kind: "secret", namespaceId: tenant.id, id: "sec_relay" } as const;
  // Deployment admission of `harness`; null bindings are Agent save.
  type Admit = (
    configuration: OpenClawConfigurationDocument,
    bindings?: SecretBindings | null,
  ) => void;
  const admission =
    (topologyDriver: KubernetesComputeDriver, harness: RevisionHarnessDescriptor): Admit =>
    (configuration, bindings) =>
      topologyDriver.validateHarnessAuth(harness, apiKeyAuth, configuration, bindings);
  // An APP_SERVER_ variable outside Dedicated Codex: the Agent's execution mode alone decides it,
  // so deployment, with or without bindings, and Agent save refuse it.
  const refusedByMode = (
    admit: Admit,
    configuration: OpenClawConfigurationDocument,
    expected: ReturnType<typeof refusal>,
    label?: string,
  ) => {
    for (const bindings of [undefined, {}, null]) {
      assert.throws(() => admit(configuration, bindings), expected, label);
    }
  };
  // Any other unbound name: deployment refuses it, naming the binding to add or the entry to
  // disable; bound, the variable is set in the Gateway, which starts. Agent save does not know
  // the Configuration's bindings, so it leaves it to deployment.
  const refusedUntilBound = (
    admit: Admit,
    configuration: OpenClawConfigurationDocument,
    [setting, name, plugin, enabledBy]: readonly [
      string,
      string,
      string,
      (string | null | undefined)?,
    ],
    label?: string,
  ) => {
    const expected = refusal(unboundPluginSecretRefusal(setting, name, plugin, enabledBy));
    for (const bindings of [undefined, {}]) {
      assert.throws(() => admit(configuration, bindings), expected, label);
    }
    admit(configuration, { [name]: { source } });
    admit(configuration, null);
    // Configuration save knows neither the Agent nor its bindings, so it leaves it to deployment.
    driver.validateConfiguration(configuration);
  };
  const embeddedAdmission = admission(driver, embedded);

  // Every form of an APP_SERVER_ reference, on an embedded Agent.
  for (const [configuration, setting, name] of [
    [withCodex({ enabled: true, config: { appServer } }), authToken, "APP_SERVER_TOKEN"],
    // An entry without enabled is active, even beside an allowlist that does not list it: at
    // startup OpenClaw adds every known plugin entry with config to a non-empty plugins.allow.
    [withCodex({ config: { appServer } }, { allow: ["browser"] }), authToken, "APP_SERVER_TOKEN"],
    [
      withCodex({ config: { appServer: { authToken: "$APP_SERVER_TOKEN" } } }),
      authToken,
      "APP_SERVER_TOKEN",
    ],
    [
      withCodex({ config: { appServer: { headers: { "X-Relay": "${APP_SERVER_RELAY}" } } } }),
      relayHeader,
      "APP_SERVER_RELAY",
    ],
    // A long name is cut, so the message keeps its cap.
    [
      withCodex({ config: { appServer: { authToken: envRef(longName) } } }),
      authToken,
      `"${longName.slice(0, 31)}…"`,
    ],
  ] as const) {
    refusedByMode(
      embeddedAdmission,
      configuration,
      refusal(dedicatedCodexVariableRefusal(setting, name)),
    );
    // Configuration save knows no Agent, so the execution mode that refuses it is not known yet.
    driver.validateConfiguration(configuration);
  }
  // The other forms of an unbound reference, on an embedded Agent.
  for (const [configuration, ...refused] of [
    [
      withCodex({ config: { appServer: { headers: { "X-Relay": "$RELAY_TOKEN" } } } }),
      relayHeader,
      "RELAY_TOKEN",
      "codex",
    ],
    // OpenClaw trims a secret-input value before it reads `${NAME}`, so padding still stops the
    // Gateway (finding 3046).
    [withSearchHeader(" ${RELAY_TOKEN}\n"), searchHeader, "RELAY_TOKEN", "google"],
    // OpenClaw adds the google entry to a plugins.allow that omits it, so its input is read.
    [
      withSearchHeader("${RELAY_TOKEN}", {}, { allow: ["codex"] }),
      searchHeader,
      "RELAY_TOKEN",
      "google",
    ],
  ] as const) {
    refusedUntilBound(embeddedAdmission, configuration, refused);
  }
  // References OpenClaw cannot read at all stop the Gateway whatever sets the variable, and its
  // configuration still validates, so the runtime hold does not catch them (finding 3056). That
  // holds for an input with a runtime owner too (beam, active only when enabled), so deployment,
  // bound or not, Agent save and Configuration save (finding 3069) refuse them on every topology.
  const beamToken = "plugins.entries.beam.config.mirror.token";
  const withBeam = (
    token: OpenClawConfigurationValue,
    entry: OpenClawConfigurationDocument = { enabled: true },
  ) => withPlugin("beam", { ...entry, config: { mirror: { token } } });
  // An allowlist on the default env alias that keeps the Gateway password OpenClaw reads there.
  const allowlist = (ids: readonly string[]) => ({
    secrets: {
      providers: {
        default: { source: "env", allowlist: ["OPENCLAW_GATEWAY_PASSWORD", ...ids] },
      },
    },
  });
  const codexDriverAdmission = admission(driver, codex);
  const codexBase = createHarnessConfiguration("codex", "gpt-5");
  for (const [configuration, setting, plugin, held, ...shown] of [
    [
      withCodex({ config: { appServer: { authToken: { source: "env", id: "RELAY_TOKEN" } } } }),
      authToken,
      "codex",
      "providerless",
    ],
    [
      withSearchHeader({ source: "env", id: "RELAY_TOKEN" }),
      searchHeader,
      "google",
      "providerless",
    ],
    [withBeam({ source: "env", id: "RELAY_TOKEN" }), beamToken, "beam", "providerless"],
    // A file ref has no built-in provider to add.
    [withBeam({ source: "file", id: "/token" }), beamToken, "beam", "providerless", "file"],
    [
      withCodex({
        config: { appServer: { authToken: { ...envRef("RELAY_TOKEN"), provider: "vault" } } },
      }),
      authToken,
      "codex",
      "provider",
      "vault",
    ],
    [
      withSearchHeader({ source: "file", provider: "default", id: "/token" }),
      searchHeader,
      "google",
      "provider",
      "default",
      "file",
    ],
    [
      withBeam({ ...envRef("RELAY_TOKEN"), provider: "vault" }),
      beamToken,
      "beam",
      "provider",
      "vault",
    ],
    [
      withSearchHeader({ ...envRef("RELAY_TOKEN"), provider: "vault" }, {}, { allow: ["codex"] }),
      searchHeader,
      "google",
      "provider",
      "vault",
    ],
    // An alias outside OpenClaw's provider grammar, even a configured one.
    [
      {
        ...withSearchHeader({ ...envRef("RELAY_TOKEN"), provider: "Vault" }),
        secrets: { providers: { Vault: { source: "env" } } },
      },
      searchHeader,
      "google",
      "providerAlias",
      "Vault",
    ],
    // The default alias moves with secrets.defaults.env.
    [
      { ...withSearchHeader(envRef("RELAY_TOKEN")), secrets: { defaults: { env: "custom" } } },
      searchHeader,
      "google",
      "defaultAlias",
      "custom",
    ],
    // The step offers the id upper-cased, with other characters as _, when that is one OpenClaw
    // reads.
    [
      withSearchHeader(envRef("relay_token")),
      searchHeader,
      "google",
      "id",
      "relay_token",
      "RELAY_TOKEN",
    ],
    [withSearchHeader(envRef("_RELAY")), searchHeader, "google", "id", "_RELAY"],
    [
      withSearchHeader(envRef(" RELAY_TOKEN ")),
      searchHeader,
      "google",
      "id",
      '" RELAY_TOKEN "',
      "RELAY_TOKEN",
    ],
    [withBeam(envRef("relay-token")), beamToken, "beam", "id", '"relay-token"', "RELAY_TOKEN"],
    [
      withCodex({ config: { appServer: { authToken: envRef("app_server_token") } } }),
      authToken,
      "codex",
      "id",
      "app_server_token",
      "APP_SERVER_TOKEN",
    ],
    [
      { ...withSearchHeader("$RELAY_TOKEN"), ...allowlist(["OTHER"]) },
      searchHeader,
      "google",
      "allowlist",
      "RELAY_TOKEN",
    ],
    [
      { ...withBeam("$RELAY_TOKEN"), ...allowlist([]) },
      beamToken,
      "beam",
      "allowlist",
      "RELAY_TOKEN",
    ],
  ] as const) {
    const expected = refusal(unreadablePluginSecretRefusal(setting, plugin, held, ...shown));
    const label = JSON.stringify(configuration);
    refusedByMode(embeddedAdmission, configuration, expected, label);
    assert.throws(() => driver.validateConfiguration(configuration), expected, label);
    assert.throws(
      () => embeddedAdmission(configuration, { RELAY_TOKEN: { source } }),
      expected,
      label,
    );
    // A Dedicated Codex Gateway keeps the same entries beside its own codex entry, whose
    // `${APP_SERVER_TOKEN}` Compute sets, so an allowlist that omits it does not apply there.
    if (plugin !== "codex") {
      const dedicated = {
        ...configuration,
        ...codexBase,
        plugins: withEntries(codexBase, configuration.plugins.entries).plugins,
      };
      refusedByMode(codexDriverAdmission, dedicated, expected, label);
    }
  }
  // With the longest names (a 64-character provider and default alias, a 128-character id), each
  // refusal keeps its whole next step within the 256-character cap; the setting path is cut
  // instead (finding 3067).
  const longAlias = `a${"-b".repeat(31)}c`;
  const longProvider = `p${"q".repeat(63)}`;
  const cut = (name: string) => `"${name.slice(0, 31)}…"`;
  const withLongNames = (
    reference: OpenClawConfigurationDocument,
    secrets?: OpenClawConfigurationDocument,
  ) => ({
    ...withSearchHeader({ ...envRef("RELAY_TOKEN"), ...reference }),
    secrets: { defaults: { env: longAlias }, ...secrets },
  });
  for (const [configuration, held, ...shown] of [
    [withLongNames({ provider: longProvider }), "provider", cut(longProvider), "env", null],
    [withLongNames({}), "defaultAlias", cut(longAlias), "env", null],
    [withLongNames({ provider: "P".repeat(64) }), "providerAlias", cut("P".repeat(64)), null],
    [
      withLongNames({ provider: longAlias, id: `i${"d".repeat(127)}` }),
      "id",
      cut(`i${"d".repeat(127)}`),
    ],
    [
      withLongNames(
        { provider: longProvider, id: `I${"D".repeat(127)}` },
        { providers: { [longProvider]: { source: "env", allowlist: [] } } },
      ),
      "allowlist",
      cut(`I${"D".repeat(127)}`),
      cut(longProvider),
    ],
  ] as const) {
    const [, expected] = unreadablePluginSecretRefusal("<path>", "google", held, ...shown).split(
      "<path>",
    );
    assert.ok(expected);
    assert.throws(
      () => embeddedAdmission(configuration, null),
      (error) =>
        error instanceof ConfigurationHarnessError &&
        Array.from(error.message).length <= 256 &&
        error.message.startsWith("Configuration setting plugins.") &&
        error.message.endsWith(expected),
      held,
    );
  }
  // OpenClaw reads each of these, so the binding alone decides: an env SecretRef on the default
  // alias secrets.defaults.env names, one on a configured env provider whose allowlist lists it,
  // the $NAME shorthand there, and a `${_NAME}`, which OpenClaw only substitutes.
  for (const [configuration, name = "RELAY_TOKEN"] of [
    [{ ...withSearchHeader(envRef("RELAY_TOKEN")), ...allowlist(["RELAY_TOKEN"]) }],
    [{ ...withSearchHeader("$RELAY_TOKEN"), ...allowlist(["RELAY_TOKEN"]) }],
    // OpenClaw substitutes a set `${NAME}` (padded too) before it reads SecretRefs, so an
    // allowlist that omits NAME never applies to it; unset, it stops the Gateway as before.
    [{ ...withSearchHeader(" ${RELAY_TOKEN} "), ...allowlist(["OTHER"]) }],
    [
      {
        ...withSearchHeader({ ...envRef("RELAY_TOKEN"), provider: "custom" }),
        secrets: { defaults: { env: "custom" } },
      },
    ],
    [
      {
        ...withSearchHeader({ ...envRef("RELAY_TOKEN"), provider: "vault" }),
        secrets: { providers: { vault: { source: "env" } } },
      },
    ],
    [{ ...withSearchHeader("$RELAY_TOKEN"), secrets: { defaults: { env: "custom" } } }],
    // OpenClaw substitutes an alias written as an environment reference before it reads the ref,
    // so the alias, and whether the ref's provider is the built-in one, is left to it.
    [{ ...withSearchHeader("$RELAY_TOKEN"), secrets: { defaults: { env: "${ALIAS:-custom}" } } }],
    [
      {
        ...withSearchHeader(envRef("RELAY_TOKEN")),
        secrets: { defaults: { env: "${ALIAS:-custom}" } },
      },
    ],
    [withSearchHeader("${_RELAY}"), "_RELAY"],
  ] as const) {
    refusedUntilBound(embeddedAdmission, configuration, [searchHeader, name, "google"]);
  }
  // At an input with a runtime owner an unset variable only makes the owner unavailable, but
  // OpenClaw keeps an unset `${NAME}` as a SecretRef, and an allowlist's denial of it is not
  // isolated to the owner: it stops the Gateway. So deployment refuses it while unbound; bound,
  // OpenClaw substitutes it. Agent save does not know the bindings and leaves it to deployment.
  const imapPassword = "plugins.entries.imap.config.accounts.main.password";
  for (const [configuration, setting, plugin] of [
    [{ ...withBeam("${RELAY_TOKEN}"), ...allowlist(["OTHER"]) }, beamToken, "beam"],
    [
      {
        ...withPlugin("imap", {
          enabled: true,
          config: { accounts: { main: { password: "${RELAY_TOKEN}" } } },
        }),
        ...allowlist([]),
      },
      imapPassword,
      "imap",
    ],
  ] as const) {
    const expected = refusal(
      unboundUnreadablePluginSecretRefusal(
        setting,
        plugin,
        "RELAY_TOKEN",
        "allowlist",
        "RELAY_TOKEN",
      ),
    );
    for (const bindings of [undefined, {}]) {
      assert.throws(() => embeddedAdmission(configuration, bindings), expected);
    }
    embeddedAdmission(configuration, { RELAY_TOKEN: { source } });
    embeddedAdmission(configuration, null);
  }
  // An allowlist that lists the unset name leaves only the owner unavailable, and OpenClaw keeps
  // an unset `${_NAME}` as written, never as a SecretRef.
  embeddedAdmission({ ...withBeam("${RELAY_TOKEN}"), ...allowlist(["RELAY_TOKEN"]) }, {});
  embeddedAdmission({ ...withBeam("${_RELAY}"), ...allowlist([]) }, {});
  // OpenClaw applies the Configuration's own environment before it substitutes `${NAME}`
  // (`applyConfigEnvVars`, finding 3059): a non-blank `env.vars` or other `env` string sets NAME
  // (trimmed; Z_AI_API_KEY also sets ZAI_API_KEY), so these Gateways start unbound.
  const withEnv = (
    configuration: OpenClawConfigurationDocument,
    env: OpenClawConfigurationDocument,
  ) => ({ ...configuration, env });
  for (const configuration of [
    withEnv(withSearchHeader("${RELAY_TOKEN}"), { vars: { RELAY_TOKEN: "literal" } }),
    withEnv(withSearchHeader(" ${RELAY_TOKEN} "), { " RELAY_TOKEN ": "literal" }),
    withEnv(withCodex({ config: { appServer: { headers: { "X-Relay": "${RELAY_TOKEN}" } } } }), {
      vars: { RELAY_TOKEN: "$${ESCAPED}" },
    }),
    withEnv({ ...withBeam("${RELAY_TOKEN}"), ...allowlist(["OTHER"]) }, { RELAY_TOKEN: "x" }),
    withEnv(withSearchHeader("${ZAI_API_KEY}"), { vars: { Z_AI_API_KEY: "literal" } }),
  ]) {
    embeddedAdmission(configuration, undefined);
    embeddedAdmission(configuration, {});
  }
  // OpenClaw drops a blank value, one that holds a reference, a name outside the portable
  // grammar and a name its host environment policy blocks (listed, or by prefix, or the Cargo
  // runner pattern); the `$NAME` shorthand is an env SecretRef, left to the binding as before.
  for (const [value, env, name = "RELAY_TOKEN"] of [
    ["${RELAY_TOKEN}", { vars: { RELAY_TOKEN: " " } }],
    ["${RELAY_TOKEN}", { vars: { RELAY_TOKEN: "${OTHER}" } }],
    ["${RELAY_TOKEN}", { vars: { OTHER: "literal" } }],
    ["${RELAY_TOKEN}", { vars: { RELAY_TOKEN: 1 } }],
    ["$RELAY_TOKEN", { vars: { RELAY_TOKEN: "literal" } }],
    ["${GITHUB_TOKEN}", { vars: { GITHUB_TOKEN: "literal" } }, "GITHUB_TOKEN"],
    ["${AWS_SECRET_ACCESS_KEY}", { AWS_SECRET_ACCESS_KEY: "x" }, "AWS_SECRET_ACCESS_KEY"],
    ["${GIT_CONFIG_RELAY}", { vars: { GIT_CONFIG_RELAY: "x" } }, "GIT_CONFIG_RELAY"],
    ["${BASH_FUNC_RELAY}", { vars: { BASH_FUNC_RELAY: "x" } }, "BASH_FUNC_RELAY"],
    ["${CARGO_TARGET_X_RUNNER}", { vars: { CARGO_TARGET_X_RUNNER: "x" } }, "CARGO_TARGET_X_RUNNER"],
  ] as const) {
    refusedUntilBound(embeddedAdmission, withEnv(withSearchHeader(value), env), [
      searchHeader,
      name,
      "google",
    ]);
  }
  // An APP_SERVER_ name there is never set on an embedded or Dedicated OpenClaw Agent, and no
  // binding can set it, so the Agent's mode alone decides: deployment and Agent save refuse it
  // under an allowlist that omits it (finding 3060). A Dedicated Codex Gateway sets
  // APP_SERVER_TOKEN, so OpenClaw substitutes it there; an allowlist that lists the name, or none,
  // leaves only the owner unavailable.
  const imapEntry = (password: OpenClawConfigurationValue) => ({
    imap: { enabled: true, config: { accounts: { main: { password } } } },
  });
  const nativeBase = createHarnessConfiguration("openclaw", "gpt-4o-mini");
  for (const [admit, configuration, setting, plugin, agent] of [
    [
      embeddedAdmission,
      { ...withBeam("${APP_SERVER_TOKEN}"), ...allowlist(["OTHER"]) },
      beamToken,
      "beam",
      "an embedded",
    ],
    [
      admission(nativeDriver, native),
      { ...withEntries(nativeBase, imapEntry(" ${APP_SERVER_URL} ")), ...allowlist([]) },
      imapPassword,
      "imap",
      "a Dedicated OpenClaw",
    ],
  ] as const) {
    const name = plugin === "beam" ? "APP_SERVER_TOKEN" : "APP_SERVER_URL";
    refusedByMode(
      admit,
      configuration,
      refusal(appServerUnreadablePluginSecretRefusal(setting, plugin, agent, "allowlist", name)),
      JSON.stringify(configuration),
    );
    driver.validateConfiguration(configuration);
  }
  for (const [admit, configuration] of [
    [embeddedAdmission, { ...withBeam("${APP_SERVER_TOKEN}"), ...allowlist(["APP_SERVER_TOKEN"]) }],
    [embeddedAdmission, withBeam("${APP_SERVER_TOKEN}")],
    [
      codexDriverAdmission,
      {
        ...withEntries(codexBase, {
          beam: { enabled: true, config: { mirror: { token: "${APP_SERVER_TOKEN}" } } },
        }),
        ...allowlist([]),
      },
    ],
  ] as const) {
    admit(configuration, {});
    admit(configuration, null);
  }
  // A Dedicated Codex Agent whose allowlist omits APP_SERVER_TOKEN: its own codex entry reads
  // `${APP_SERVER_TOKEN}`, which Compute sets, so OpenClaw substitutes it and the Gateway starts.
  // `$APP_SERVER_TOKEN` stays a SecretRef, which that allowlist denies.
  const codexAllowlisted = { ...codexBase, ...allowlist([]) };
  codexDriverAdmission(codexAllowlisted, {});
  codexDriverAdmission(codexAllowlisted, null);
  assert.ok(codexBase.plugins);
  const codexEntry = codexBase.plugins.entries.codex;
  refusedByMode(
    codexDriverAdmission,
    withEntries(codexAllowlisted, {
      codex: {
        ...codexEntry,
        config: {
          ...codexEntry.config,
          appServer: { ...codexEntry.config.appServer, authToken: "$APP_SERVER_TOKEN" },
        },
      },
    }),
    refusal(unreadablePluginSecretRefusal(authToken, "codex", "allowlist", "APP_SERVER_TOKEN")),
  );
  // Each of these embedded Gateways starts: OpenClaw skips an inactive plugin's secret inputs, a
  // fallback replaces the unset name, a reference inside other text and the URL are not read as
  // secrets, a name no binding may set is left to Compute and the image, and a plugin input with
  // a runtime owner (beam) or of a plugin the image does not ship only disables that plugin.
  for (const configuration of [
    withCodex({ enabled: false, config: { appServer } }),
    withCodex({ enabled: true, config: { appServer } }, { enabled: false }),
    withCodex({ enabled: true, config: { appServer } }, { deny: ["codex"] }),
    withSearchHeader("${RELAY_TOKEN}", { enabled: false }),
    withSearchHeader("${RELAY_TOKEN}", {}, { deny: [" Google"] }),
    withCodex({ config: { appServer: { authToken: "${APP_SERVER_TOKEN:-unset}" } } }),
    withCodex({ config: { appServer: { headers: { "X-Relay": "Bearer ${APP_SERVER_TOKEN}" } } } }),
    withCodex({ config: { appServer: { url: "${APP_SERVER_URL}" } } }),
    withSearchHeader("${RELAY_TOKEN:-}"),
    withSearchHeader("${OPENAI_API_KEY}"),
    withSearchHeader("${HOSTNAME}"),
    withPlugin("beam", { enabled: true, config: { mirror: { token: "${RELAY_TOKEN}" } } }),
    // beam is inactive unless enabled, and OpenClaw reads a providerless SecretRef outside a
    // manifest secret input (google webSearch.apiKey) as an env one.
    withBeam({ source: "env", id: "RELAY_TOKEN" }, {}),
    // An object with keys beyond source, provider and id is no SecretRef: OpenClaw keeps it.
    withSearchHeader({ ...envRef("RELAY_TOKEN"), provider: "vault", note: "kept" }),
    withPlugin("google", {
      config: { webSearch: { apiKey: { source: "env", id: "RELAY_TOKEN" } } },
    }),
    withPlugin("voice-call", {
      enabled: true,
      config: { twilio: { authToken: "${RELAY_TOKEN}" } },
    }),
  ]) {
    embeddedAdmission(configuration, {});
  }
  // OpenClaw reads plugin secret inputs only in the entry keyed by the plugin's exact ID, so a
  // case or padding variant of `google` has none and its Gateway starts (finding 3072). Its deny
  // list and each entry's `enabled` match a trimmed, lowercased ID with aliases resolved
  // (google-gemini-cli is google). Configuration save accepts these too.
  const unreadableHeader = { ...envRef("RELAY_TOKEN"), provider: "vault" };
  const variant = (
    id: string,
    value: OpenClawConfigurationValue,
    plugins?: OpenClawConfigurationDocument,
  ) => withPlugin(id, searchHeaderEntry(value).google, plugins);
  for (const configuration of [
    variant("Google", "${RELAY_TOKEN}"),
    variant(" google", "${RELAY_TOKEN}"),
    variant("GOOGLE", "${RELAY_TOKEN}", { allow: ["codex"] }),
    variant("Google", unreadableHeader),
    withSearchHeader("${RELAY_TOKEN}", {}, { deny: ["GOOGLE"] }),
    withSearchHeader(unreadableHeader, {}, { deny: [" google "] }),
    withSearchHeader("${RELAY_TOKEN}", {}, { deny: ["google-gemini-cli"] }),
    // A later entry for the same plugin with enabled: false disables it. It must come later in
    // the order written and in the stored order the Gateway receives (keys by length, then byte;
    // finding 3092), so it is a longer key here.
    withEntries(withSearchHeader("${RELAY_TOKEN}"), { "google ": { enabled: false } }),
    // A later value that is not an object replaces the merged entry with {}, which leaves google
    // inactive: auto-enable set `enabled: true` only on the exact entry (finding 3074).
    withEntries(withSearchHeader("${RELAY_TOKEN}"), { "google ": null }),
    withEntries(withSearchHeader("${RELAY_TOKEN}"), { " google": "off" }),
  ]) {
    embeddedAdmission(configuration, {});
    driver.validateConfiguration(configuration);
  }
  // A later `enabled: true` for the same plugin enables a disabled google entry, so the step names
  // that later entry (finding 3074). Startup auto-enable sets `enabled: true` on a google entry
  // that leaves it unset, so an earlier `enabled: false`, or a value that is not an object, for
  // the same plugin does not disable it. Each revision reaches the Gateway in PostgreSQL's jsonb
  // key order, where `GOOGLE` comes before `google` whatever order the Configuration wrote, so
  // `GOOGLE` written after the google entry does not disable it either (finding 3092).
  for (const [configuration, enabledBy] of [
    [withEntries(withSearchHeader("${RELAY_TOKEN}"), { GOOGLE: { enabled: false } }), undefined],
    [withEntries(withSearchHeader("${RELAY_TOKEN}"), { GOOGLE: null }), undefined],
    [
      withEntries(withSearchHeader("${RELAY_TOKEN}", { enabled: false }), {
        GOOGLE: { enabled: true },
      }),
      "GOOGLE",
    ],
    [
      withEntries(withSearchHeader("${RELAY_TOKEN}", { enabled: false }), {
        Google: { enabled: true },
        GOOGLE: { config: {} },
      }),
      "Google",
    ],
    [
      {
        ...embeddedBase,
        plugins: {
          entries: { GOOGLE: { enabled: false }, ...searchHeaderEntry("${RELAY_TOKEN}") },
        },
      },
      undefined,
    ],
    [
      {
        ...embeddedBase,
        plugins: { entries: { GOOGLE: null, ...searchHeaderEntry("${RELAY_TOKEN}") } },
      },
      undefined,
    ],
  ] as const) {
    refusedUntilBound(embeddedAdmission, configuration, [
      searchHeader,
      "RELAY_TOKEN",
      "google",
      enabledBy,
    ]);
  }
  // A memory or context engine slot set to the plugin's exact ID, trimmed, activates a plugin whose
  // merged `enabled` is unset, so a cleared google entry still reads its header and a beam or imap
  // entry that leaves `enabled` unset reads its secret (findings 3074 and 3081). The step names the
  // entry that cleared it. Only `enabled: false` stops a slot, and a case variant selects nothing.
  const withSlots = (configuration: PluginConfiguration, slots: OpenClawConfigurationDocument) => ({
    ...configuration,
    plugins: { ...configuration.plugins, slots },
  });
  // The cleared entry comes after google in the order written and in the stored order (finding
  // 3092): a longer key. A `GOOGLE: null` written after google comes first in the stored order,
  // where startup auto-enable enables the google entry last, so setting only `GOOGLE`'s enabled to
  // false would leave google active there: the step offers only removal (finding 3095).
  const clearedSearchHeader = withEntries(withSearchHeader("${RELAY_TOKEN}"), { "google ": null });
  const clearedByVariant = withEntries(withSearchHeader("${RELAY_TOKEN}"), { GOOGLE: null });
  for (const slots of [{ memory: "google" }, { contextEngine: " google " }]) {
    refusedUntilBound(embeddedAdmission, withSlots(clearedByVariant, slots), [
      searchHeader,
      "RELAY_TOKEN",
      "google",
      null,
    ]);
  }
  const unsetBeam = { ...withBeam("${RELAY_TOKEN}", {}), ...allowlist(["OTHER"]) };
  const unsetImap = {
    ...withPlugin("imap", { config: { accounts: { main: { password: "${RELAY_TOKEN}" } } } }),
    ...allowlist([]),
  };
  for (const [configuration, setting, plugin] of [
    [withSlots(unsetBeam, { memory: "beam" }), beamToken, "beam"],
    [withSlots(unsetImap, { contextEngine: " imap" }), imapPassword, "imap"],
  ] as const) {
    const expected = refusal(
      unboundUnreadablePluginSecretRefusal(
        setting,
        plugin,
        "RELAY_TOKEN",
        "allowlist",
        "RELAY_TOKEN",
      ),
    );
    for (const bindings of [undefined, {}]) {
      assert.throws(() => embeddedAdmission(configuration, bindings), expected, plugin);
    }
  }
  // Configuration save does not know the bindings, so the unset `${NAME}` above waits for
  // deployment. A reference OpenClaw cannot read at all is refused at save too (finding 3069),
  // and the slot activates the entry there as well: without the slot, save accepts it.
  for (const [configuration, slots, setting, plugin] of [
    [{ ...withBeam("$RELAY_TOKEN", {}), ...allowlist([]) }, { memory: "beam" }, beamToken, "beam"],
    [
      {
        ...withPlugin("imap", { config: { accounts: { main: { password: "$RELAY_TOKEN" } } } }),
        ...allowlist([]),
      },
      { contextEngine: " imap" },
      imapPassword,
      "imap",
    ],
  ] as const) {
    driver.validateConfiguration(configuration);
    assert.throws(
      () => driver.validateConfiguration(withSlots(configuration, slots)),
      refusal(unreadablePluginSecretRefusal(setting, plugin, "allowlist", "RELAY_TOKEN")),
      plugin,
    );
  }
  for (const configuration of [
    clearedSearchHeader,
    unsetBeam,
    unsetImap,
    withSlots(clearedSearchHeader, { memory: "Google" }),
    withSlots(withSearchHeader("${RELAY_TOKEN}", { enabled: false }), { memory: "google" }),
    withSlots(
      { ...withBeam("${RELAY_TOKEN}", { enabled: false }), ...allowlist(["OTHER"]) },
      { contextEngine: "beam" },
    ),
  ]) {
    embeddedAdmission(configuration, {});
  }
  // A Driver the Installation selects may add launch variables whose names deployment cannot
  // know, so an unbound name is left to the Gateway; the APP_SERVER_ rule still holds.
  const launch = new KubernetesComputeDriver(options(), {
    lifecycleDrivers: [
      {
        id: "launch-environment",
        capability: "configuration",
        implementation: "local-launch",
        computeLifecycleHooks: { async beforeWorkloadStart() {} },
      },
    ],
  });
  const launchAdmission = admission(launch, embedded);
  launchAdmission(withSearchHeader("${RELAY_TOKEN}"), {});
  refusedByMode(
    launchAdmission,
    withCodex({ config: { appServer } }),
    refusal(dedicatedCodexVariableRefusal(authToken, "APP_SERVER_TOKEN")),
  );
  // The same rules on every topology.
  for (const [admit, label, base, appServerAgent] of [
    [embeddedAdmission, "embedded", embeddedBase, "an embedded"],
    [
      admission(nativeDriver, native),
      "Dedicated OpenClaw",
      createHarnessConfiguration("openclaw", "gpt-4o-mini"),
      "a Dedicated OpenClaw",
    ],
    // Dedicated Codex's own entry reads APP_SERVER_URL and APP_SERVER_TOKEN; it starts.
    [admission(driver, codex), "Dedicated Codex", createHarnessConfiguration("codex", "gpt-5")],
  ] as const) {
    const relayEntry = (authToken: string) => {
      const entry = ("plugins" in base ? base.plugins?.entries.codex : undefined) ?? {
        enabled: true,
      };
      const config = "config" in entry ? entry.config : undefined;
      return {
        codex: {
          ...entry,
          config: { ...config, appServer: { ...config?.appServer, authToken } },
        },
      };
    };
    for (const [entries, ...refused] of [
      [relayEntry("${RELAY_TOKEN}"), authToken, "RELAY_TOKEN", "codex"],
      [searchHeaderEntry("${SEARCH_HEADER}"), searchHeader, "SEARCH_HEADER", "google"],
    ] as const) {
      refusedUntilBound(admit, withEntries(base, entries), refused, label);
    }
    const appServerToken = withEntries(base, relayEntry("${APP_SERVER_TOKEN}"));
    if (appServerAgent === undefined) {
      admit(appServerToken, {});
      admit(appServerToken, null);
    } else {
      const expected = dedicatedCodexVariableRefusal(
        authToken,
        "APP_SERVER_TOKEN",
        "codex",
        appServerAgent,
      );
      refusedByMode(admit, appServerToken, refusal(expected), label);
    }
  }
}

export async function rejectUnmanagedGatewayPasswordDuringPreparation() {
  // Admission refuses it first; preparation runs the same rule on the revision it renders,
  // with the revision's own secrets settings (finding 3057).
  for (const [password, message] of [
    ["literal-gateway-password", KUBERNETES_GATEWAY_PASSWORD_REFUSAL],
    [{ source: "env", id: "OTHER" }, KUBERNETES_GATEWAY_PASSWORD_REFUSAL],
    [
      { source: "env", provider: "vault", id: "OPENCLAW_GATEWAY_PASSWORD" },
      unreadableGatewayPasswordRefusal("provider", "vault"),
    ],
  ] as const) {
    const { driver, revision, context } = workspaceSetupFixture(false);
    const configuration = structuredClone(revision.configuration);
    const auth = asRecord(asRecord(configuration.gateway)?.auth);
    assert.ok(auth);
    auth.password = password;
    await assert.rejects(
      driver.prepareRevision({ ...revision, configuration }, { ...context, secretEnvironment: [] }),
      { message },
    );
  }
}

const CODEX_CONFIG_BEFORE_PLUGIN_DEFAULTS = `[features]
apps = false
plugins = false
remote_plugin = false

[apps._default]
enabled = false
`;

const CODEX_CONFIG_BEFORE_APPROVAL_POLICY = `${CODEX_CONFIG_BEFORE_PLUGIN_DEFAULTS}
[plugins._default]
enabled = false
`;

export async function retainEarlierCodexPluginRuntimeConfigMap() {
  for (const policy of ["on-request", "on-failure", "never", undefined]) {
    const {
      driver,
      revision: fixtureRevision,
      namespace,
      objects,
      records,
      state,
      context,
    } = workspaceSetupFixture(false);
    const revision = {
      ...fixtureRevision,
      configuration: {
        ...structuredClone(fixtureRevision.configuration),
        plugins: {
          entries: {
            codex: {
              config: { appServer: { approvalPolicy: policy } },
            },
          },
        },
      },
    };
    // @ts-expect-error The existing policy matrix includes an explicit undefined property.
    const prepare = () => driver.prepareRevision(revision, { ...context, secretEnvironment: [] });
    state.ready = true;
    assert.equal((await prepare()).ready, true);
    const runtimeKey = [...objects.keys()].find((key) =>
      key.startsWith(`ConfigMap:${namespace}:plugin-runtime-`),
    );
    assert.ok(runtimeKey);
    const observed = objects.get(runtimeKey);
    assert.ok(observed?.data);
    const current = {
      ...structuredClone(observed),
      immutable: observed.immutable === true,
      data: { ...observed.data },
    };
    const currentConfig = current.data["config.toml"];
    assert.ok(currentConfig);
    assert.equal(current.immutable, true);
    assert.equal(/^approval_policy = /m.test(currentConfig), policy !== undefined);
    if (policy === "on-failure") {
      // The Gateway runs on-failure as on-request, so native startup gets on-request.
      assert.match(currentConfig, /^approval_policy = "on-request"$/m);
    }
    const earlier = [CODEX_CONFIG_BEFORE_PLUGIN_DEFAULTS, CODEX_CONFIG_BEFORE_APPROVAL_POLICY];
    if (policy === "on-failure") {
      // #1995 rendered the configured value as written.
      earlier.push(`approval_policy = "on-failure"\n\n${CODEX_CONFIG_BEFORE_APPROVAL_POLICY}`);
    }
    // Kubernetes refuses edits to an immutable ConfigMap, so a revision prepared before
    // the upgrade keeps the file its Pods mounted. Re-preparing the active revision must
    // finish instead of refusing it until the Agent is deployed again.
    // Earlier approval renderings still retain this revision's explicit provider and URL.
    const providerHeader = currentConfig.split("\n\n")[0];
    assert.ok(providerHeader);
    const providerSectionStart = currentConfig.indexOf("\n[model_providers.");
    assert.ok(providerSectionStart >= 0);
    const providerSection = currentConfig.slice(providerSectionStart);
    for (const previous of earlier) {
      const config: string = `${providerHeader}\n\n${previous}${providerSection}`;
      if (config === currentConfig) {
        continue;
      }
      objects.set(runtimeKey, {
        ...structuredClone(current),
        data: { ...current.data, "config.toml": config },
      });
      const writes = records.length;
      assert.equal((await prepare()).ready, true);
      assert.equal(
        records.slice(writes).some(({ kind }) => kind === "ConfigMap"),
        false,
        "an earlier rendering is kept, never rewritten",
      );
      assert.equal(objects.get(runtimeKey)?.data?.["config.toml"], config);
    }
    // Change one field in a valid current ConfigMap at a time. A wrong provider or missing
    // section would otherwise mask a regression in the immutability or extra-file checks.
    for (const tamper of [
      (configMap: typeof current) => {
        configMap.data["config.toml"] = /^approval_policy = /m.test(currentConfig)
          ? currentConfig.replace(/^approval_policy = .*$/m, 'approval_policy = "untrusted"')
          : `approval_policy = "untrusted"\n\n${currentConfig}`;
      },
      (configMap: typeof current) => {
        assert.match(currentConfig, /^apps = false$/m);
        configMap.data["config.toml"] = currentConfig.replace(/^apps = false$/m, "apps = true");
      },
      (configMap: typeof current) => {
        const manifest = configMap.data["runtime.json"];
        assert.ok(manifest);
        const runtime = asRecord(JSON.parse(manifest));
        assert.ok(runtime);
        configMap.data["runtime.json"] = JSON.stringify({ ...runtime, extra: 1 });
      },
      (configMap: typeof current) => {
        configMap.immutable = false;
      },
      (configMap: typeof current) => {
        configMap.data["extra.toml"] = "";
      },
    ]) {
      const configMap = structuredClone(current);
      tamper(configMap);
      objects.set(runtimeKey, configMap);
      const writes = records.length;
      await assert.rejects(
        prepare(),
        /Refusing invalid immutable Kubernetes ConfigMap plugin-runtime-/,
      );
      assert.equal(
        records.slice(writes).some(({ kind }) => kind === "ConfigMap"),
        false,
      );
    }
  }
}

export function preserveSlackReplyModesAndNativeOverrides() {
  const driver = createKubernetesComputeDriver(options());
  for (const policy of [
    {},
    { replyToModeByChatType: { channel: "all" }, dmPolicy: "disabled" },
    { replyToMode: "off" },
    {
      replyToMode: "all",
      replyToModeByChatType: { direct: "off", channel: "first" },
      channels: { CEXAMPLE: { replyToMode: "off" } },
    },
  ]) {
    const configuration = { channels: { slack: { enabled: true, mode: "socket", ...policy } } };
    const rendered = driver["kubernetesGatewayConfigurationDocument"](configuration);
    assert.deepEqual(rendered.channels, configuration.channels);
  }
}
