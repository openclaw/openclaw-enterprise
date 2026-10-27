import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { constants as osConstants } from "node:os";
import test from "node:test";
import { getSystemErrorMap } from "node:util";
import vm from "node:vm";

import {
  AGENT_RUNTIME_ENTRYPOINT,
  AGENT_WITH_NODE_ENTRYPOINT,
  GATEWAY_RUNTIME_ENTRYPOINT,
  NATIVE_WORKER_ENTRYPOINT,
  PLUGIN_RUNTIME_HELPERS,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  PROCESS_EXIT_ERROR_CODES,
  PROCESS_EXIT_SIGNALS,
  RUNTIME_COMPONENTS,
  RUNTIME_DIAGNOSTIC_CHECKS,
  RUNTIME_DIAGNOSTIC_CODES,
  RUNTIME_FAILURE_CHECKS,
  WORKSPACE_SETUP_CHECK,
  WORKSPACE_SETUP_FAILED,
} from "../../packages/contracts/src/runtime-failure.mjs";
import { deploymentDiagnostics } from "../../packages/occ/src/deployment-diagnostics.ts";
import {
  validateFailureData,
  validateRuntimeFailureEvidence,
} from "../../packages/occ/src/state/controller-work.ts";
import {
  validateConfiguration,
  requireConfiguration,
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
  sandboxNetworkGrantsWithinCeiling,
  validateSandboxNetworkGrants,
} from "../../packages/contracts/src/index.ts";

test("network delegation covers every requested host label and port without broadening executables", () => {
  const grant = {
    id: "python",
    binary: "/usr/bin/python3.11",
    host: "api.example.org",
    ports: [{ from: 443, to: 445 }],
  };
  const ceiling = [
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
  ]) {
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
  const mutableRevision = {
    id: "revision-a-1",
    namespaceId: "namespace-a",
    agentId: "agent-a",
    revision: 1,
    configurationId: "configuration-a",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: { model: "gpt-test", temperature: "0", tool: "lookup" },
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
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
          toolDefaults: { approval: "all_actions", reviewer: "human" },
          tools: { "repos/list": { enabled: true }, "repos/write": { approval: "none" } },
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
      ],
    },
    servicePrincipalId: "service-principal-agent-a",
    createdAt: "2026-08-15T00:00:00.000Z",
  };

  const admitted = freezeAgentRevision(mutableRevision);
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
  assert.deepEqual(admitted.plugins.plugins["codex-plugin:github@openai-curated-remote"], {
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
  assert.deepEqual(admitted.harness, { id: "codex", version: "1.0.0", mode: "dedicated" });
  assert.deepEqual(admitted.compute, {
    id: "compute-test",
    implementation: "deterministic-fake",
  });
  assert.equal(admitted.sandboxDriverId, "sandbox-test");
  assert.throws(() => {
    admitted.configuration.model = "unauthorized-revision-mutation";
  }, TypeError);
  assert.throws(() => {
    admitted.configurationGeneration = 2;
  }, TypeError);
  assert.throws(() => {
    admitted.harness.version = "unauthorized-harness-mutation";
  }, TypeError);
  assert.throws(() => {
    admitted.harness.mode = "embedded";
  }, TypeError);
  assert.throws(() => {
    admitted.compute.implementation = "unauthorized-compute-mutation";
  }, TypeError);
  assert.throws(() => {
    admitted.sandboxDriverId = "unauthorized-sandbox-mutation";
  }, TypeError);
  assert.throws(() => {
    admitted.repositoryCredentials.bindings[0].grant.repositoryId = "unauthorized-repository";
  }, TypeError);
  assert.throws(() => {
    admitted.plugins.plugins["codex-plugin:github@openai-curated-remote"].tools[
      "repos/list"
    ].enabled = false;
  }, TypeError);
});

test("only a codex_pat Harness binding names a ServiceAccount source, and only exactly", () => {
  const namespaceId = `ns_${randomUUID()}`;
  const account = { kind: "service_account", namespaceId, id: `sa_${randomUUID()}` };
  const secret = { kind: "secret", namespaceId, id: `sec_${randomUUID()}` };
  const managed = { method: "codex_pat", source: account };
  assert.deepEqual(normalizeHarnessAuthBinding(managed), managed);
  assert.equal(isServiceAccountHarnessAuth(managed), true);
  assert.equal(isSecretHarnessAuth(managed), false);
  for (const method of ["api_key", "codex_pat"]) {
    const binding = { method, source: secret };
    assert.deepEqual(normalizeHarnessAuthBinding(binding), binding);
    assert.equal(isSecretHarnessAuth(binding), true, method);
    assert.equal(isServiceAccountHarnessAuth(binding), false, method);
  }
  // The predicates read the method and the source kind together.
  for (const method of ["api_key", "oauth"]) {
    assert.equal(isServiceAccountHarnessAuth({ method, source: account }), false, method);
    assert.equal(isSecretHarnessAuth({ method, source: account }), false, method);
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

// Findings 1660 and 1673-1675: the runtime failure vocabulary lives in the contract. The
// Kubernetes runtime programs get it injected and refuse anything else, and OCC records, and
// reads back, a value outside it as UNRECOGNIZED: a provider-owned Harness serves runtime
// evidence from inside its Sandbox, where Agent code can answer in its place.

const runtimeSources = [
  "../../apps/controller/src/drivers/compute/gateway-tool-policy.ts",
  "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts",
  "../../apps/controller/src/drivers/compute/runtime-startup.ts",
];
const driverRoot = new URL("../../apps/controller/src/drivers/", import.meta.url);

async function runtimeSourceText() {
  return (
    await Promise.all(
      runtimeSources.map((path) => readFile(new URL(path, import.meta.url), "utf8")),
    )
  ).join("\n");
}
const runtimeCheckedAt = "2026-10-17T12:00:00.000Z";

function injectedRuntimeList(program, name) {
  const match = new RegExp(`const ${name} = new Set\\((\\[[^\\n]*\\])\\);`, "u").exec(program);
  assert.ok(match, `${name} is not injected from the contract; update this test`);
  return JSON.parse(match[1]);
}

function recordedRuntimeFailure(runtimeFailure) {
  return validateFailureData("CONVERGENCE_DEADLINE_EXCEEDED", { timeoutMs: 1, runtimeFailure })
    .runtimeFailure;
}

function returnedDiagnostics(checks) {
  return deploymentDiagnostics(
    { revisionId: "rev_1", observedAt: runtimeCheckedAt, checks },
    "rev_1",
  ).checks;
}

// Every brace-free object literal with a check key in a Compute driver source, outside the
// runtime programs: evidence (or, with a state, a diagnostic check) the driver builds itself. A
// copy of what the runtime published (failed.check) adds no value of its own. As a backstop for
// objects this cannot read (nested braces, say), every literal check must belong to one it read.
async function driverBuiltRuntimeValues() {
  const files = (await readdir(driverRoot, { recursive: true }))
    .filter((path) => path.endsWith(".ts"))
    .filter((path) => !runtimeSources.some((source) => source.endsWith(`/drivers/${path}`)));
  const records = [];
  for (const path of files) {
    const text = await readFile(new URL(path, driverRoot), "utf8");
    const readCheckOffsets = new Set();
    for (const object of text.matchAll(/\{[^{}]*\}/gu)) {
      const literal = object[0];
      const checkKey = /\bcheck\s*:/u.exec(literal);
      if (!checkKey) {
        continue;
      }
      readCheckOffsets.add(object.index + checkKey.index);
      const value = (key) =>
        new RegExp(`\\b${key}\\s*:\\s*("[^"\\n]*"|[^,\\n}]+)`, "u").exec(literal)?.[1].trim();
      const [check, code] = [value("check"), value("code")];
      if (/^[A-Za-z_$][\w$]*\.check$/u.test(check) && /^[A-Za-z_$][\w$]*\.code$/u.test(code)) {
        continue;
      }
      assert.match(
        `${check} ${code}`,
        /^"[^"]+" "[^"]+"$/u,
        `${path} builds a runtime check this test cannot read; update it:\n${literal}`,
      );
      const diagnostic = /\bstate\s*:/u.test(literal);
      records.push({ path, diagnostic, check: JSON.parse(check), code: JSON.parse(code) });
    }
    for (const match of text.matchAll(/\bcheck\s*:\s*("[^"\n]*")/gu)) {
      assert.ok(
        readCheckOffsets.has(match.index),
        `${path} sets check ${match[1]} in a shape this test cannot read; update it`,
      );
    }
  }
  return records;
}

test("every check and code a runtime entrypoint publishes is recorded as published", async () => {
  // The runtime programs check what they publish against the contract's lists, injected as is.
  for (const program of [
    GATEWAY_RUNTIME_ENTRYPOINT,
    AGENT_RUNTIME_ENTRYPOINT,
    AGENT_WITH_NODE_ENTRYPOINT,
    NATIVE_WORKER_ENTRYPOINT,
  ]) {
    assert.deepEqual(injectedRuntimeList(program, "RUNTIME_DIAGNOSTIC_CODES"), [
      ...RUNTIME_DIAGNOSTIC_CODES,
    ]);
    assert.deepEqual(injectedRuntimeList(program, "RUNTIME_FAILURE_CHECKS"), [
      ...RUNTIME_FAILURE_CHECKS,
    ]);
    assert.deepEqual(injectedRuntimeList(program, "RUNTIME_DIAGNOSTIC_CHECKS"), [
      ...RUNTIME_DIAGNOSTIC_CHECKS,
    ]);
  }
  // Every literal they hold a failure or report a check under is in those lists, so none
  // throws instead of holding.
  const text = await runtimeSourceText();
  const held = [
    ...text.matchAll(
      /(?:publishRuntimeFailure|holdFailedAuthentication|holdStartupFailure|serveHeldRuntimeFailureToTransportPeer)\(\s*"([^"]+)"(?:,\s*"([^"]+)")?/gu,
    ),
    ...text.matchAll(/function holdFailedAuthentication\(check = "([^"]+)", code = "([^"]+)"/gu),
  ];
  const diagnosed = [
    ...text.matchAll(/(?:runtimeDiagnosticCheck|statusCheckFromBoolean)\(\s*"([^"]+)"/gu),
  ];
  // Guards the extraction itself: an empty match would prove nothing.
  assert.ok(new Set(held.map(([, check]) => check)).size >= 5, JSON.stringify(held));
  assert.ok(new Set(diagnosed.map(([, check]) => check)).size >= 3, JSON.stringify(diagnosed));
  for (const [, check, code] of held) {
    assert.ok(RUNTIME_FAILURE_CHECKS.includes(check), check);
    assert.ok(code === undefined || RUNTIME_DIAGNOSTIC_CODES.includes(code), code);
  }
  for (const [, check] of diagnosed) {
    assert.ok(RUNTIME_DIAGNOSTIC_CHECKS.includes(check), check);
  }
  // Compute names the status container by its role; the provider-owned transport says "agent".
  for (const component of RUNTIME_COMPONENTS) {
    for (const check of RUNTIME_FAILURE_CHECKS) {
      for (const code of RUNTIME_DIAGNOSTIC_CODES) {
        const evidence = { component, check, checkedAt: runtimeCheckedAt, code };
        assert.deepEqual(recordedRuntimeFailure(evidence), evidence);
        const diagnostic = { component, check, state: "failed", checkedAt: runtimeCheckedAt, code };
        assert.deepEqual(returnedDiagnostics([diagnostic]), [diagnostic]);
      }
    }
    for (const check of RUNTIME_DIAGNOSTIC_CHECKS) {
      const diagnostic = { component, check, state: "unknown", checkedAt: null };
      assert.deepEqual(returnedDiagnostics([diagnostic]), [diagnostic]);
    }
  }
});

test("a runtime program refuses to publish a check or code outside the contract", () => {
  const env = {};
  const sandbox = { require: createRequire(import.meta.url), process: { env }, Buffer, console };
  vm.runInNewContext(PLUGIN_RUNTIME_HELPERS, sandbox);
  // Compute-owned: the status port serves held failures and diagnostic checks.
  Object.assign(env, {
    OPENCLAW_RUNTIME_STATUS_PORT: "18791",
    OPENCLAW_RUNTIME_STATUS_CONTAINER: "gateway",
  });
  assert.throws(
    () => sandbox.publishRuntimeFailure("see.evil.example", "UNAVAILABLE"),
    /check is invalid/,
  );
  assert.throws(() => sandbox.publishRuntimeFailure("model-probe", "CALL_ME"), /code is invalid/);
  sandbox.publishRuntimeFailure("model-probe", "UNAVAILABLE");
  assert.throws(
    () => sandbox.runtimeDiagnosticCheck("see.evil.example", "unknown", null),
    /check is invalid/,
  );
  assert.throws(
    () => sandbox.runtimeDiagnosticCheck("connectivity", "unknown", null, "CALL_ME"),
    /code is invalid/,
  );
  assert.equal(
    sandbox.runtimeDiagnosticCheck("connectivity", "unknown", null).check,
    "connectivity",
  );
  // Provider-owned: the held failure is served on the Harness port instead.
  delete env.OPENCLAW_RUNTIME_STATUS_PORT;
  Object.assign(env, { APP_TOKEN_SHA: "a".repeat(64), APP_SERVER_PORT: "4500" });
  assert.throws(
    () => sandbox.serveHeldRuntimeFailureToTransportPeer("see.evil.example", "UNAVAILABLE"),
    /check is invalid/,
  );
  assert.throws(
    () => sandbox.serveHeldRuntimeFailureToTransportPeer("model-probe", "CALL_ME"),
    /code is invalid/,
  );
});

test("every check and code a Compute driver builds itself is recorded as built", async () => {
  const records = await driverBuiltRuntimeValues();
  // Guards the extraction itself: Kubernetes Compute's workspace-setup record and its
  // unreadable-status diagnostic must be found.
  const found = (check, code, diagnostic) =>
    records.some(
      (record) =>
        record.path === "compute/kubernetes/index.ts" &&
        record.check === check &&
        record.code === code &&
        record.diagnostic === diagnostic,
    );
  assert.ok(found(WORKSPACE_SETUP_CHECK, WORKSPACE_SETUP_FAILED, false), JSON.stringify(records));
  assert.ok(found("runtime-status", "UNAVAILABLE", true), JSON.stringify(records));
  for (const component of RUNTIME_COMPONENTS) {
    for (const { diagnostic, check, code } of records) {
      if (diagnostic) {
        const built = { component, check, state: "unknown", checkedAt: null, code };
        assert.deepEqual(returnedDiagnostics([built]), [built]);
      } else {
        const evidence = { component, check, checkedAt: runtimeCheckedAt, code };
        assert.deepEqual(recordedRuntimeFailure(evidence), evidence);
      }
    }
  }
});

test("a failed workspace setup keeps its check and code through record and read", () => {
  const evidence = {
    component: "agent",
    check: "workspace-setup",
    checkedAt: runtimeCheckedAt,
    code: "WORKSPACE_SETUP_FAILED",
  };
  // The worker records the deadline failure with this evidence, and the status read validates
  // the stored row again.
  const stored = validateFailureData("CONVERGENCE_DEADLINE_EXCEEDED", {
    timeoutMs: 900_000,
    runtimeFailure: evidence,
  });
  assert.deepEqual(stored, { timeoutMs: 900_000, runtimeFailure: evidence });
  assert.deepEqual(validateFailureData("CONVERGENCE_DEADLINE_EXCEEDED", stored), stored);
});

test("recorded failure data refuses a cause off the model probe's failure, a cause in deadline data, and another code as a held model-probe failure", () => {
  const probe = {
    component: "agent",
    check: "model-probe",
    checkedAt: runtimeCheckedAt,
    code: "MODEL_PROBE_FAILED",
  };
  const cause = { kind: "PROBE_STATUS", detail: "turn-failed" };
  assert.throws(() => validateRuntimeFailureEvidence({ ...probe, code: "STARTUP_FAILED", cause }), {
    name: "ScopeViolationError",
    message: "Runtime failure cause is invalid.",
  });
  // The deadline records its runtime failure without the cause, so a stored cause is refused.
  assert.throws(
    () =>
      validateFailureData("CONVERGENCE_DEADLINE_EXCEEDED", {
        timeoutMs: 1,
        runtimeFailure: { ...probe, cause },
      }),
    { message: "Convergence deadline failure data cannot carry a cause." },
  );
  // A held model-probe failure must be the model probe's own failure, not another one.
  assert.throws(
    () =>
      validateFailureData("RUNTIME_MODEL_PROBE_FAILED", {
        runtimeFailure: { ...probe, code: "STARTUP_FAILED" },
      }),
    { message: "Model probe failure data requires its runtime failure." },
  );
});

test("runtime failure evidence outside that vocabulary is recorded as UNRECOGNIZED", () => {
  const served = {
    component: "sidecar",
    check: "see.evil.example:443",
    checkedAt: runtimeCheckedAt,
    code: "STARTUP_FAILED",
  };
  assert.deepEqual(recordedRuntimeFailure(served), {
    component: "UNRECOGNIZED",
    check: "UNRECOGNIZED",
    checkedAt: served.checkedAt,
    code: "UNRECOGNIZED",
  });
  // A held model-probe failure keeps its known code and classified cause; only the unknown
  // component and check are replaced.
  assert.deepEqual(
    validateFailureData("RUNTIME_MODEL_PROBE_FAILED", {
      runtimeFailure: {
        ...served,
        code: "MODEL_PROBE_FAILED",
        cause: { kind: "PROBE_STATUS", detail: "turn-failed" },
      },
    }),
    {
      runtimeFailure: {
        component: "UNRECOGNIZED",
        check: "UNRECOGNIZED",
        checkedAt: served.checkedAt,
        code: "MODEL_PROBE_FAILED",
        cause: { kind: "PROBE_STATUS", detail: "turn-failed" },
      },
    },
  );
});

test("a PROCESS_EXIT cause outside the contract's statuses, signals and error codes is recorded without its detail", () => {
  const failure = (detail) => ({
    runtimeFailure: {
      component: "agent",
      check: "model-probe",
      checkedAt: runtimeCheckedAt,
      code: "MODEL_PROBE_FAILED",
      cause: detail === undefined ? { kind: "PROCESS_EXIT" } : { kind: "PROCESS_EXIT", detail },
    },
  });
  for (const [served, recorded] of [
    ["exit-1", "exit-1"],
    ["exit-255", "exit-255"],
    ["signal-SIGKILL-attempt2", "signal-SIGKILL-attempt2"],
    ["error-ENOBUFS", "error-ENOBUFS"],
    // Shaped like a token, but text the Sandbox chose.
    ["exit-256", undefined],
    ["error-EVILEXAMPLECOM", undefined],
    ["signal-SIGSEEEXAMPLE-attempt2", undefined],
    // What #2763 recorded, or a runtime serves as text: rows holding it still read, without
    // the detail, and none is recorded (finding 1706).
    ["UNRECOGNIZED", undefined],
    ["UNRECOGNIZED-attempt2", undefined],
  ]) {
    // Recorded once, then read back from the stored row.
    const stored = validateFailureData("RUNTIME_MODEL_PROBE_FAILED", failure(served));
    assert.deepEqual(stored, failure(recorded), served);
    assert.deepEqual(validateFailureData("RUNTIME_MODEL_PROBE_FAILED", stored), stored, served);
  }
});

test("a PROCESS_EXIT cause recorded today reads under a controller from before the closed vocabulary", () => {
  // The cause check of a controller before #2763, which a rollback or rolling upgrade runs
  // against rows this one records: a detail must match it, or the read is refused.
  const earlierReader =
    /^(?:exit-[1-9][0-9]{0,2}|signal-SIG[A-Z0-9]{1,10}|error-E[A-Z0-9]{1,15})$/u;
  const readsEarlier = (cause) =>
    cause.kind === "PROCESS_EXIT" &&
    Object.keys(cause).every((key) => key === "kind" || key === "detail") &&
    (cause.detail === undefined || earlierReader.test(cause.detail.replace(/-attempt2$/u, "")));
  // What #2763 first recorded fails it, so this test catches a return to writing it.
  assert.equal(readsEarlier({ kind: "PROCESS_EXIT", detail: "UNRECOGNIZED" }), false);
  assert.equal(readsEarlier({ kind: "PROCESS_EXIT", detail: "UNRECOGNIZED-attempt2" }), false);
  for (const served of [
    "exit-1",
    "signal-SIGKILL-attempt2",
    "error-ENOBUFS",
    "exit-256",
    "exit-999",
    "error-EVILEXAMPLECOM",
    "signal-SIGSEEEXAMPLE-attempt2",
    // A runtime can serve the literal text too (finding 1706).
    "UNRECOGNIZED",
    "UNRECOGNIZED-attempt2",
  ]) {
    const stored = validateFailureData("RUNTIME_MODEL_PROBE_FAILED", {
      runtimeFailure: {
        component: "agent",
        check: "model-probe",
        checkedAt: runtimeCheckedAt,
        code: "MODEL_PROBE_FAILED",
        cause: { kind: "PROCESS_EXIT", detail: served },
      },
    });
    const cause = JSON.parse(JSON.stringify(stored)).runtimeFailure.cause;
    assert.ok(readsEarlier(cause), `${served} -> ${JSON.stringify(cause)}`);
  }
});

test("every model-probe cause a runtime program publishes is recorded as published", async () => {
  const text = await runtimeSourceText();
  // Each call shape a model-probe failure is built in, read for the detail tokens it publishes.
  const read = new Set();
  const causes = [];
  const extract = (pattern, toCauses) => {
    for (const match of text.matchAll(pattern)) {
      read.add(match.index);
      causes.push(...toCauses(match));
    }
  };
  extract(/probeFailure\(\s*"([A-Z_]+)"\s*\)/gu, ([, kind]) => [{ kind }]);
  extract(/probeFailure\(\s*"([A-Z_]+)",\s*"([^"]+)"\s*\)/gu, ([, kind, detail]) => [
    { kind, detail },
  ]);
  // A choice between two tokens, as for the Codex check's unexpected events.
  extract(
    /probeFailure\(\s*"([A-Z_]+)",[^?\n]*\?\s*"([^"]+)"\s*:\s*"([^"]+)"\s*\)/gu,
    ([, kind, ...details]) => details.map((detail) => ({ kind, detail })),
  );
  // The OpenClaw check's provider statuses, and "other" for the rest.
  extract(
    /probeFailure\(\s*"PROBE_STATUS",\s*\[([^\]]+)\]\.includes\(status\) \? status : "([^"]+)"\)/gu,
    ([, list, other]) =>
      [...JSON.parse(`[${list}]`), other].map((detail) => ({ kind: "PROBE_STATUS", detail })),
  );
  // The Codex check's helper names rate_limit itself, else its caller's token.
  extract(
    /probeFailure\(\s*"PROBE_STATUS",\s*codexRateLimited\(message\) \? "([^"]+)" : detail\)/gu,
    ([, detail]) => [{ kind: "PROBE_STATUS", detail }],
  );
  extract(/codexProbeStatusFailure\([^"\n]*,\s*"([^"]+)"\)/gu, ([, detail]) => [
    { kind: "PROBE_STATUS", detail },
  ]);
  // A backstop for shapes none of these read. PROCESS_EXIT details are built at run time and
  // pinned by the PROCESS_EXIT tests above.
  for (const call of text.matchAll(
    /probeFailure\(\s*"(?!PROCESS_EXIT")|codexProbeStatusFailure\((?!message, detail\))/gu,
  )) {
    assert.ok(
      read.has(call.index),
      `a probe failure is built in a shape this test cannot read; update it:\n${text.slice(call.index, call.index + 120)}`,
    );
  }
  // Guards the extraction itself: an empty or partial match would prove nothing.
  const found = new Set(
    causes.map(({ kind, detail }) => (detail === undefined ? kind : `${kind}/${detail}`)),
  );
  for (const expected of [
    "INVALID_OUTPUT/json",
    "INVALID_OUTPUT/shape",
    "PROBE_STATUS/no-reply",
    "PROBE_STATUS/turn-failed",
    "PROBE_STATUS/error-event",
    "PROBE_STATUS/tool-event",
    "PROBE_STATUS/unexpected-event",
    "PROBE_STATUS/rate_limit",
    "PROBE_STATUS/no_model",
    "PROBE_STATUS/other",
    "WRAPPER_ERROR",
  ]) {
    assert.ok(found.has(expected), `${expected} not found in ${JSON.stringify([...found])}`);
  }
  for (const cause of causes) {
    // The retried check holds its second failure with the "-attempt2" suffix on its detail.
    for (const held of cause.detail === undefined
      ? [cause]
      : [cause, { ...cause, detail: `${cause.detail}-attempt2` }]) {
      const failure = {
        runtimeFailure: {
          component: "agent",
          check: "model-probe",
          checkedAt: runtimeCheckedAt,
          code: "MODEL_PROBE_FAILED",
          cause: held,
        },
      };
      const stored = validateFailureData("RUNTIME_MODEL_PROBE_FAILED", failure);
      assert.deepEqual(stored, failure, JSON.stringify(held));
      assert.deepEqual(
        validateFailureData("RUNTIME_MODEL_PROBE_FAILED", stored),
        stored,
        JSON.stringify(held),
      );
    }
  }
});

test("every signal and system error code Node names on Linux is in the PROCESS_EXIT vocabulary", (t) => {
  if (process.platform !== "linux") {
    t.skip("the runtime runs on Linux; other platforms name other codes");
    return;
  }
  for (const signal of Object.keys(osConstants.signals)) {
    assert.ok(PROCESS_EXIT_SIGNALS.includes(signal), signal);
  }
  // Node names spawn errors by libuv's names, which add a few to errno's. The runtime keeps
  // only names of this shape.
  for (const code of [
    ...Object.keys(osConstants.errno),
    ...[...getSystemErrorMap().values()].map(([name]) => name),
  ].filter((name) => /^E[A-Z0-9]{1,15}$/u.test(name))) {
    assert.ok(PROCESS_EXIT_ERROR_CODES.includes(code), code);
  }
});

test("runtime diagnostics outside that vocabulary are returned as UNRECOGNIZED", () => {
  const known = {
    component: "gateway",
    check: "connectivity",
    state: "failed",
    checkedAt: runtimeCheckedAt,
    code: "DISCONNECTED",
  };
  assert.deepEqual(
    returnedDiagnostics([
      {
        component: "sidecar",
        check: "see.evil.example:443",
        state: "failed",
        checkedAt: null,
        code: "CALL_ME",
      },
      { ...known, check: "workspace-setup", code: "WORKSPACE_SETUP_FAILED" },
      { component: "agent", check: "runtime-status", state: "unknown", checkedAt: null },
      known,
    ]),
    [
      {
        component: "UNRECOGNIZED",
        check: "UNRECOGNIZED",
        state: "failed",
        checkedAt: null,
        code: "UNRECOGNIZED",
      },
      // Only Compute builds this record, from Pod status; a runtime cannot report it.
      { ...known, check: "UNRECOGNIZED", code: "UNRECOGNIZED" },
      { component: "agent", check: "runtime-status", state: "unknown", checkedAt: null },
      known,
    ],
  );
});

// A duplicate false-subschema error must not hide useful field diagnostics, and
// removing that duplicate must not admit independently forbidden values.
test("configuration diagnostics collapse extra-field noise without accepting false schemas", () => {
  assert.deepEqual(
    validateConfiguration({ type: "object", additionalProperties: false }, { extra: 1 }),
    {
      success: false,
      error: {
        details: [
          {
            path: "",
            code: "UNKNOWN_FIELD",
            message: "Configuration does not satisfy additionalProperties.",
          },
        ],
      },
    },
  );
  for (const [schema, input] of [
    [false, 1],
    [{ type: "array", items: false }, [1]],
    [{ type: "object", properties: { additionalProperties: false } }, { additionalProperties: 1 }],
  ]) {
    const result = validateConfiguration(schema, input);
    assert.equal(result.success, false);
    assert.equal(result.error.details[0].message, "Configuration does not satisfy boolean.");
  }
});

test("configuration admission retains original values while isolating semantic callback references", () => {
  const input = { endpoint: { port: 443 } };
  let retained;
  const definition = {
    configurationSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        endpoint: {
          type: "object",
          additionalProperties: false,
          properties: { port: { type: "integer" } },
        },
      },
    },
    validateConfiguration(value) {
      retained = value;
      return [];
    },
  };
  assert.equal(requireConfiguration(definition, input), input);
  // A Driver retaining its argument cannot change data already admitted for another caller.
  assert.throws(() => {
    retained.endpoint.port = 80;
  }, TypeError);
  assert.deepEqual(input, { endpoint: { port: 443 } });
  const accessor = {
    get endpoint() {
      throw new Error("input getter must not run");
    },
  };
  assert.throws(
    () => requireConfiguration(definition, accessor),
    (error) => {
      assert.deepEqual(error.error.details, [
        {
          path: "",
          code: "INVALID_TYPE",
          message: "Configuration must contain only plain JSON values.",
        },
      ]);
      return true;
    },
  );
});
