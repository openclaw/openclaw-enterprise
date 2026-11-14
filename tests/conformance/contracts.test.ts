import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Check } from "typebox/value";

import {
  CONFIGURATION_KINDS,
  DRIVER_CAPABILITIES,
  LOGGING_LEVELS,
  admitLoggingConfiguration,
  admittedLoggingLevel,
  HARNESS_EXECUTION_MODES,
  RESOURCE_KINDS,
  SANDBOX_FACETS,
  freezeAgentRevision,
  isDriverCapability,
  isSecretHarnessAuth,
  isServiceAccountHarnessAuth,
  isResourceKind,
  isSandboxFacet,
  normalizeHarnessAuthBinding,
  normalizeLoggingLevel,
  ConfigurationValidationError,
  ProtectedDownloadDestinationSchema,
  sandboxNetworkGrantsWithinCeiling,
  validateSandboxNetworkGrants,
  type AgentRevision,
  type PluginApprovalMode,
  type PluginReviewer,
  type SecretReference,
  type ServiceAccountReference,
  type SandboxNetworkGrant,
} from "../../packages/contracts/src/index.ts";
import { registerConfigurationCases } from "./contracts-configuration-cases.ts";
import { registerRuntimeDiagnosticCases } from "./contracts-runtime-diagnostic-cases.ts";

test("protected download destinations preserve exact scheme, host, port and object scope", () => {
  const dest = { scheme: "https", host: "artifacts.example.org", port: 443 };
  const accepts = (value: unknown) => Check(ProtectedDownloadDestinationSchema, value);
  assert.ok(accepts(dest));
  assert.ok(accepts({ ...dest, scheme: "http", port: 80 }));
  assert.ok(accepts({ ...dest, path: "/releases/v1.2/toolchain-x86_64+1.tar.gz" }));
  assert.ok(accepts({ ...dest, path: "/proxy-cache/go.example:toolchain-v1.linux-amd64.zip" }));
  assert.ok(accepts({ ...dest, path: "/modules/toolchain/@v/v1.0.0.zip" }));
  for (const host of [
    "*.example.org",
    "Example.org",
    "example.org.",
    "user@example.org",
    "localhost",
    "internal",
    "metadata.google.internal",
    "service.cluster.local",
    "a.home.arpa",
    "a.localdomain6",
    "127.0.0.1",
    "127.1",
    "0x7f.0x01",
    "0177.1",
    "2130706433",
    "[::1]",
    "example.org\n",
  ]) {
    assert.equal(accepts({ ...dest, host }), false, host);
  }
  for (const path of [
    "/",
    "relative",
    "/a//b",
    "/a/",
    "/a/../b",
    "/./a",
    "/a/.",
    "/a%2fb",
    "/%252e%252e/b",
    "/a\\b",
    "/a?token=value",
    "/a#part",
    "/files/*",
    "/[ab]",
    "/{one,two}",
    "/a\n",
  ]) {
    assert.equal(accepts({ ...dest, path }), false, path);
  }
  for (const fields of [
    { scheme: "http" },
    { port: 80 },
    { port: 8443 },
    { scheme: "ftp" },
    { method: "POST" },
  ]) {
    assert.equal(accepts({ ...dest, ...fields }), false);
  }
});

test("network delegation covers every requested host label and port without broadening executables", () => {
  const grant = {
    id: "python",
    binary: "/usr/bin/python3.11",
    host: "api.example.org",
    ports: [{ from: 443, to: 445 }],
  };
  const ceiling: [SandboxNetworkGrant, SandboxNetworkGrant] = [
    { ...grant, id: "first", host: "*.example.org", ports: [{ from: 443, to: 444 }] },
    { ...grant, id: "second", host: "*.example.org", ports: [{ from: 445, to: 445 }] },
  ];
  assert.equal(sandboxNetworkGrantsWithinCeiling([grant], ceiling), true);
  assert.equal(
    sandboxNetworkGrantsWithinCeiling([{ ...grant, host: "*.example.org" }], ceiling),
    true,
  );
  // A wildcard covers exactly one label; sampling a subdomain cannot authorize the apex or deeper names.
  for (const host of [
    "example.org",
    "deep.api.example.org",
    "*.api.example.org",
    "api.example.net",
  ]) {
    assert.equal(sandboxNetworkGrantsWithinCeiling([{ ...grant, host }], ceiling), false, host);
  }
  assert.equal(
    sandboxNetworkGrantsWithinCeiling([{ ...grant, binary: "/usr/bin/python3" }], ceiling),
    false,
  );
  assert.equal(
    sandboxNetworkGrantsWithinCeiling(
      [grant],
      [ceiling[0], { ...ceiling[1], ports: [{ from: 446, to: 446 }] }],
    ),
    false,
  );
  assert.equal(sandboxNetworkGrantsWithinCeiling([grant], []), false);
  // Coverage needs a port: an empty or reversed range never proves containment.
  for (const ports of [[], [{ from: 445, to: 443 }], [{ from: 65535, to: 1 }]]) {
    assert.equal(sandboxNetworkGrantsWithinCeiling([{ ...grant, ports }], ceiling), false);
  }
  for (const [invalid, path, code, message] of [
    [
      [{ ...grant, binary: "/usr/bin/../python3.11" }],
      "/additions/0/binary",
      "INVALID_VALUE",
      "Use a normalized absolute executable path.",
    ],
    [
      [{ ...grant, host: "api..example.org" }],
      "/additions/0/host",
      "INVALID_VALUE",
      "Use a valid DNS host or single-label wildcard.",
    ],
    [
      [{ ...grant, ports: [{ from: 445, to: 443 }] }],
      "/additions/0/ports/0/to",
      "INVALID_RANGE",
      "The end port must be at least the start port.",
    ],
    [[grant, grant], "/additions/1/id", "INVALID_VALUE", "Grant IDs must be unique."],
  ] as const) {
    assert.throws(
      () => validateSandboxNetworkGrants(invalid),
      (error) => {
        assert.ok(error instanceof ConfigurationValidationError);
        assert.deepEqual(error.error.details, [{ path, code, message }]);
        return true;
      },
    );
  }
});

test("the Driver contract exposes the supported platform capabilities", () => {
  assert.deepEqual(DRIVER_CAPABILITIES, [
    "iam",
    "compute",
    "configuration",
    "service_account",
    "secret",
    "sandbox",
    "plugin",
    "channel",
    "repo",
    "credential_gateway",
    "credential_refresh",
    "credential_proxy",
  ]);
  assert.equal(Object.isFrozen(DRIVER_CAPABILITIES), true);

  for (const capability of DRIVER_CAPABILITIES) {
    assert.equal(isDriverCapability(capability), true);
  }
  for (const unsupported of [
    "gateway",
    "secrets",
    "providers",
    "legacy",
    "repository_credentials",
    "",
    undefined,
  ]) {
    assert.equal(isDriverCapability(unsupported), false);
  }
});

test("Configuration consumer kinds contain only the explicitly supported Agent kind", () => {
  assert.deepEqual(CONFIGURATION_KINDS, ["agent"]);
  assert.equal(Object.isFrozen(CONFIGURATION_KINDS), true);
});

test("Harness execution supports only explicit embedded and dedicated placement", () => {
  assert.deepEqual(HARNESS_EXECUTION_MODES, ["embedded", "dedicated"]);
  assert.equal(Object.isFrozen(HARNESS_EXECUTION_MODES), true);
});

test("Sandbox facets expose only the initial containment surfaces", () => {
  assert.deepEqual(SANDBOX_FACETS, ["networking", "filesystem", "process"]);
  assert.equal(Object.isFrozen(SANDBOX_FACETS), true);

  for (const facet of SANDBOX_FACETS) {
    assert.equal(isSandboxFacet(facet), true);
  }
  for (const unsupported of ["exec", "tool", "workspace", "network", "", undefined]) {
    assert.equal(isSandboxFacet(unsupported), false);
  }
});

test("logging helpers admit one platform-owned native JSON policy", () => {
  assert.deepEqual(LOGGING_LEVELS, ["debug", "info", "warn", "error"]);
  assert.equal(normalizeLoggingLevel(undefined), "info");
  assert.equal(normalizeLoggingLevel("debug"), "debug");
  for (const value of ["trace", "INFO", "", null]) {
    assert.throws(() => normalizeLoggingLevel(value), /debug, info, warn, or error/);
  }

  const draft = {
    logging: {
      level: "debug",
      consoleLevel: "error",
      consoleStyle: "pretty",
      redactSensitive: "off",
      keep: true,
    },
    diagnostics: { otel: { logs: true, traces: true }, retain: "diagnostics" },
    feature: "preserved",
  };
  const admitted = admitLoggingConfiguration(draft, "warn");
  assert.deepEqual(admitted, {
    logging: {
      level: "warn",
      consoleLevel: "warn",
      consoleStyle: "json",
      keep: true,
    },
    diagnostics: { otel: { logs: false, traces: true }, retain: "diagnostics" },
    feature: "preserved",
  });
  assert.deepEqual(draft.logging, {
    level: "debug",
    consoleLevel: "error",
    consoleStyle: "pretty",
    redactSensitive: "off",
    keep: true,
  });
  assert.equal(admittedLoggingLevel(admitted), "warn");

  for (const configuration of [
    {},
    {
      logging: {
        level: "info",
        consoleLevel: "debug",
        consoleStyle: "json",
      },
      diagnostics: { otel: { logs: false } },
    },
    {
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "pretty",
      },
      diagnostics: { otel: { logs: false } },
    },
    {
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
      },
      diagnostics: { otel: { logs: true } },
    },
    {
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
        redactSensitive: "off",
      },
      diagnostics: { otel: { logs: false } },
    },
    {
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
        redactSensitive: "tools",
      },
      diagnostics: { otel: { logs: false } },
    },
  ]) {
    assert.throws(() => admittedLoggingLevel(configuration), /admitted|Admitted/);
  }
});

test("the singleton platform resource model keeps Namespace ownership explicit", () => {
  assert.deepEqual(RESOURCE_KINDS, [
    "installation",
    "namespace",
    "configuration",
    "preset",
    "service_account",
    "secret",
    "agent",
    "agent_revision",
    "credential_source",
    "sandbox_policy",
  ]);
  assert.equal(Object.isFrozen(RESOURCE_KINDS), true);

  for (const kind of RESOURCE_KINDS) {
    assert.equal(isResourceKind(kind), true);
  }
  for (const unsupported of ["provider", "driver", "plugin", "gateway", "claw", "", undefined]) {
    assert.equal(isResourceKind(unsupported), false);
  }
});

test("an admitted AgentRevision is a detached and deeply immutable deployment snapshot", () => {
  const toolDefaults: { approval: PluginApprovalMode; reviewer: PluginReviewer } = {
    approval: "all_actions",
    reviewer: "human",
  };
  const harness: {
    -readonly [Key in keyof AgentRevision["harness"]]: AgentRevision["harness"][Key];
  } = {
    id: "codex",
    version: "1.0.0",
    mode: "dedicated",
    overrides: {},
    configuration: {},
  };
  const listTool: { enabled: boolean } = { enabled: true };
  const mutableRevision = {
    id: "revision-a-1",
    namespaceId: "namespace-a",
    agentId: "agent-a",
    revision: 1,
    executionAdmission: { version: 2, mode: "unprotected" },
    backendId: "chatgpt",
    configurationId: "configuration-a",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: { model: "gpt-test", temperature: "0", tool: "lookup" },
    gatewayManagedMode: false,
    harness,
    compute: { id: "compute-test", implementation: "deterministic-fake" },
    harnessAuth: {
      method: "codex_pat",
      source: { kind: "service_account", namespaceId: "namespace-a", id: "service-account-a" },
      credential: { kind: "access_token", secretRef: { name: "account-source", key: "token" } },
      backendBinding: {
        backendId: "chatgpt",
        driverId: "accounts",
        workspaceId: "workspace-a",
        credentialIssued: true,
      },
    },
    sandboxDriverId: "sandbox-test",
    plugins: {
      driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
      plugins: {
        "codex-plugin:github@openai-curated-remote": {
          enabled: true,
          toolDefaults,
          tools: { "repos/list": listTool, "repos/write": { approval: "none" } },
          driverPolicy: { destructiveEnabled: false },
        },
      },
    },
    repositoryCredentials: {
      driver: { id: "repository-credentials", implementation: "repository-test" },
      deadlineWallMs: 1786755600000,
      bindings: [
        {
          repositoryRef: "application",
          profile: "write-profile",
          backendId: "repository-provider",
          grant: {
            providerInstanceId: "provider-instance",
            repositoryId: "repository-identity",
            grantId: "admitted-grant",
          },
        },
      ] satisfies [NonNullable<AgentRevision["repositoryCredentials"]>["bindings"][number]],
    },
    servicePrincipalId: "service-principal-agent-a",
    createdAt: "2026-08-15T00:00:00.000Z",
  } satisfies AgentRevision;

  const admitted = freezeAgentRevision(mutableRevision);
  assert.ok(isServiceAccountHarnessAuth(admitted.harnessAuth));
  assert.ok(admitted.repositoryCredentials?.bindings[0]);
  assert.notEqual(admitted, mutableRevision);
  assert.equal(Object.isFrozen(admitted), true);
  assert.equal(Object.isFrozen(admitted.configuration), true);
  assert.equal(Object.isFrozen(admitted.harness), true);
  assert.equal(Object.isFrozen(admitted.compute), true);
  assert.equal(Object.isFrozen(admitted.harnessAuth), true);
  assert.equal(Object.isFrozen(admitted.harnessAuth.credential.secretRef), true);
  assert.equal(Object.isFrozen(admitted.harnessAuth.backendBinding), true);
  assert.equal(Object.isFrozen(admitted.repositoryCredentials), true);
  assert.equal(Object.isFrozen(admitted.repositoryCredentials.driver), true);
  assert.equal(Object.isFrozen(admitted.repositoryCredentials.bindings), true);
  assert.equal(Object.isFrozen(admitted.repositoryCredentials.bindings[0]), true);
  assert.equal(Object.isFrozen(admitted.repositoryCredentials.bindings[0].grant), true);
  assert.equal(admitted.sandboxDriverId, "sandbox-test");
  assert.equal(admitted.configurationId, "configuration-a");
  assert.equal(admitted.configurationKind, "agent");
  assert.equal(admitted.configurationGeneration, 1);

  mutableRevision.configuration.model = "modified-after-admission";
  mutableRevision.configuration.temperature = "1";
  mutableRevision.configuration.tool = "mutated-tool";
  mutableRevision.harness.version = "changed-after-admission";
  mutableRevision.harness.mode = "embedded";
  mutableRevision.compute.implementation = "changed-after-admission";
  mutableRevision.sandboxDriverId = "changed-after-admission";
  mutableRevision.harnessAuth.credential.secretRef.name = "replacement-source";
  mutableRevision.harnessAuth.backendBinding.workspaceId = "replacement-workspace";
  const draftPlugin = mutableRevision.plugins.plugins["codex-plugin:github@openai-curated-remote"];
  draftPlugin.toolDefaults.approval = "none";
  draftPlugin.toolDefaults.reviewer = "auto";
  draftPlugin.tools["repos/list"].enabled = false;
  draftPlugin.driverPolicy.destructiveEnabled = true;
  // Partial tool policies stay partial in the immutable deployment snapshot.
  const admittedPlugin = admitted.plugins?.plugins["codex-plugin:github@openai-curated-remote"];
  assert.deepEqual(admittedPlugin, {
    enabled: true,
    toolDefaults: { approval: "all_actions", reviewer: "human" },
    tools: { "repos/list": { enabled: true }, "repos/write": { approval: "none" } },
    driverPolicy: { destructiveEnabled: false },
  });
  // Draft mutation must not retarget or extend an already admitted repository grant.
  mutableRevision.repositoryCredentials.driver.id = "replacement-driver";
  mutableRevision.repositoryCredentials.deadlineWallMs += 60_000;
  mutableRevision.repositoryCredentials.bindings[0].profile = "replacement-profile";
  mutableRevision.repositoryCredentials.bindings[0].grant.repositoryId = "replacement-repository";
  mutableRevision.repositoryCredentials.bindings.push({
    ...mutableRevision.repositoryCredentials.bindings[0],
    repositoryRef: "additional-repository",
  });
  assert.equal(admitted.harnessAuth.credential.secretRef.name, "account-source");
  assert.equal(admitted.harnessAuth.backendBinding.workspaceId, "workspace-a");
  assert.equal(admitted.repositoryCredentials.driver.id, "repository-credentials");
  assert.equal(admitted.repositoryCredentials.deadlineWallMs, 1786755600000);
  assert.equal(admitted.repositoryCredentials.bindings.length, 1);
  assert.equal(admitted.repositoryCredentials.bindings[0].profile, "write-profile");
  assert.equal(
    admitted.repositoryCredentials.bindings[0].grant.repositoryId,
    "repository-identity",
  );

  assert.deepEqual(admitted.configuration, {
    model: "gpt-test",
    temperature: "0",
    tool: "lookup",
  });
  assert.deepEqual(admitted.harness, {
    id: "codex",
    version: "1.0.0",
    mode: "dedicated",
    overrides: {},
    configuration: {},
  });
  assert.deepEqual(admitted.compute, {
    id: "compute-test",
    implementation: "deterministic-fake",
  });
  assert.equal(admitted.sandboxDriverId, "sandbox-test");
  // These writes are also refused when attempted by an untyped caller.
  assert.throws(() => {
    // @ts-expect-error Exercise the runtime freeze of the admitted configuration.
    admitted.configuration.model = "unauthorized-revision-mutation";
  }, TypeError);
  assert.throws(() => {
    // @ts-expect-error Exercise the runtime freeze of the Configuration generation.
    admitted.configurationGeneration = 2;
  }, TypeError);
  assert.throws(() => {
    // @ts-expect-error Exercise the runtime freeze of the Harness version.
    admitted.harness.version = "unauthorized-harness-mutation";
  }, TypeError);
  assert.throws(() => {
    // @ts-expect-error Exercise the runtime freeze of the Harness placement.
    admitted.harness.mode = "embedded";
  }, TypeError);
  assert.throws(() => {
    // @ts-expect-error Exercise the runtime freeze of the Compute selection.
    admitted.compute.implementation = "unauthorized-compute-mutation";
  }, TypeError);
  assert.throws(() => {
    // @ts-expect-error Exercise the runtime freeze of the Sandbox Driver selection.
    admitted.sandboxDriverId = "unauthorized-sandbox-mutation";
  }, TypeError);
  const admittedRepository = admitted.repositoryCredentials.bindings[0];
  assert.throws(() => {
    // @ts-expect-error Exercise the runtime freeze of the admitted repository grant.
    admittedRepository.grant.repositoryId = "unauthorized-repository";
  }, TypeError);
  const admittedListTool =
    admitted.plugins?.plugins["codex-plugin:github@openai-curated-remote"]?.tools?.["repos/list"];
  assert.ok(admittedListTool);
  assert.throws(() => {
    // @ts-expect-error Exercise the runtime freeze of a nested tool policy.
    admittedListTool.enabled = false;
  }, TypeError);
});

test("only a codex_pat Harness binding names a ServiceAccount source, and only exactly", () => {
  const namespaceId = `ns_${randomUUID()}`;
  const account = {
    kind: "service_account",
    namespaceId,
    id: `sa_${randomUUID()}`,
  } satisfies ServiceAccountReference;
  const secret = {
    kind: "secret",
    namespaceId,
    id: `sec_${randomUUID()}`,
  } satisfies SecretReference;
  const managed = { method: "codex_pat", source: account } as const;
  assert.deepEqual(normalizeHarnessAuthBinding(managed), managed);
  assert.equal(isServiceAccountHarnessAuth(managed), true);
  assert.equal(isSecretHarnessAuth(managed), false);
  for (const binding of [
    { method: "api_key", source: secret },
    { method: "codex_pat", source: secret },
  ] as const) {
    const { method } = binding;
    assert.deepEqual(normalizeHarnessAuthBinding(binding), binding);
    assert.equal(isSecretHarnessAuth(binding), true, method);
    assert.equal(isServiceAccountHarnessAuth(binding), false, method);
  }
  // The predicates read the method and the source kind together.
  for (const method of ["api_key", "oauth"] as const) {
    const binding = { method, source: account };
    // @ts-expect-error Exercise the predicate on an unsupported JavaScript input.
    assert.equal(isServiceAccountHarnessAuth(binding), false, method);
    // @ts-expect-error Exercise the predicate on an unsupported JavaScript input.
    assert.equal(isSecretHarnessAuth(binding), false, method);
  }
  for (const invalid of [
    // A managed account authenticates only through the Codex PAT login.
    { method: "api_key", source: account },
    { method: "oauth", source: account },
    // Browser OAuth now binds a Gateway credential source, never a Secret.
    { method: "oauth", source: secret },
    // The retired managed-account shape.
    { method: "chatgpt_service_account", serviceAccountId: account.id },
    // The account reference is closed and exactly typed.
    { method: "codex_pat", source: { ...account, name: "extra" } },
    { method: "codex_pat", source: { ...account, namespaceId: "default" } },
    { method: "codex_pat", source: { ...account, id: secret.id } },
    { method: "codex_pat", source: { ...account, kind: "secret" } },
  ]) {
    assert.throws(
      () => normalizeHarnessAuthBinding(invalid),
      /one supported exact source binding/,
      JSON.stringify(invalid),
    );
  }
});

registerRuntimeDiagnosticCases();
registerConfigurationCases();
