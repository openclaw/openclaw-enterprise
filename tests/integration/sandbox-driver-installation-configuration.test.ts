import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { InstallationFieldError } from "../../apps/controller/src/composition/installation-fields.ts";
import { validateOpenShellRepositoryTransport } from "../../apps/controller/src/drivers/egress-proxy/openshell-configuration.ts";
import type { OpenShellSandboxDriverOptions } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type { ConfigurationValidationError } from "../../packages/contracts/src/index.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { makeStructuralRefusal as structuralRefusal } from "./sandbox-driver-installation-fixture.ts";
import {
  buildSandboxInstallation as sandboxInstallation,
  rejectsAtStartup,
} from "./sandbox-driver-startup-installation-fixture.ts";

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
type SandboxInput = Mutable<OpenShellSandboxDriverOptions>;
type SandboxInstallation = { drivers: { sandbox: { configuration: SandboxInput } } };
type NetworkPolicyInput = SandboxInput["policy"]["networkPolicies"][number];
type EndpointInput = NetworkPolicyInput["endpoints"][number];
type RefusalDetail = ConfigurationValidationError["error"]["details"][number];
// Each test changes settings of a valid Installation, and startup refuses each change.
const TLS_MODE = structuralRefusal("/policy/networkPolicies/0/endpoints/0/tls", "enum");
const LANDLOCK = structuralRefusal("/policy/landlockCompatibility", "const");
const sandboxOf = (configuration: SandboxInstallation): SandboxInput =>
  configuration.drivers.sandbox.configuration;
const policiesOf = (configuration: SandboxInstallation): NetworkPolicyInput[] =>
  sandboxOf(configuration).policy.networkPolicies;
const firstPolicyOf = (configuration: SandboxInstallation): NetworkPolicyInput => {
  const policy = policiesOf(configuration)[0];
  assert.ok(policy);
  return policy;
};
const endpointOf = (configuration: SandboxInstallation): EndpointInput => {
  const endpoint = firstPolicyOf(configuration).endpoints[0];
  assert.ok(endpoint);
  return endpoint;
};
const readinessWait = {
  serviceName: "openshell-gateway",
  podSelector: { "app.kubernetes.io/name": "openshell" },
};

// The gateway refuses these in CreateSandbox, which runs only after a dedicated deploy has
// stopped its predecessors, so startup applies the same rules (findings 2331-2333).
const invalidValue = (path: string, message: string): RefusalDetail[] => [
  { path, code: "INVALID_VALUE", message },
];
const IDENTITY =
  "Use sandbox or a numeric ID from 1 to 4294967294; OpenShell refuses other identities.";
const FILESYSTEM_PATH =
  "Use an absolute path that is not the filesystem root and has no .. segment.";

test("startup rejects OpenShell network values outside the v0.1 protocol enums", (t) =>
  rejectsAtStartup(t, (c) => Reflect.set(endpointOf(c), "tls", "inspect"), TLS_MODE));

test("startup refuses OpenShell filesystem modes that can weaken containment", async (t) => {
  for (const mode of ["best_effort", "hard-requirement"]) {
    await rejectsAtStartup(
      t,
      (c) => Reflect.set(sandboxOf(c).policy, "landlockCompatibility", mode),
      LANDLOCK,
    );
  }
});
test("startup refuses OpenShell process identities the gateway refuses", async (t) => {
  for (const [field, value] of [
    ["runAsUser", "root"],
    ["runAsUser", "0"],
    ["runAsGroup", "users"],
    ["runAsGroup", "4294967295"],
    ["runAsUser", "-1"],
  ] as const) {
    await rejectsAtStartup(
      t,
      (c) => (sandboxOf(c).policy.process[field] = value),
      invalidValue(`/policy/process/${field}`, IDENTITY),
    );
  }
  const required = (path: string): RefusalDetail[] => [
    { path, code: "REQUIRED", message: "This configuration field is required." },
  ];
  await rejectsAtStartup(
    t,
    (c) => Reflect.deleteProperty(sandboxOf(c).policy.process, "runAsGroup"),
    required("/policy/process/runAsGroup"),
  );
  await rejectsAtStartup(
    t,
    (c) => Reflect.deleteProperty(sandboxOf(c).policy, "process"),
    required("/policy/process"),
  );
  // Control: the gateway's own name, the top of its numeric range, and the spellings its
  // u32 parser also accepts load.
  for (const value of ["sandbox", "4294967294", "+5", "007"]) {
    const configuration = sandboxInstallation();
    sandboxOf(configuration).policy.process = { runAsUser: value, runAsGroup: value };
    await loadInstallationFile(t, configuration);
  }
});

test("startup refuses OpenShell filesystem paths before any Sandbox is created", async (t) => {
  for (const [filesystem, field] of [
    [{ readOnly: ["usr"] }, "readOnly/0"],
    [{ readWrite: ["/tmp", "/"] }, "readWrite/1"],
    [{ readWrite: ["//"] }, "readWrite/0"],
    [{ readOnly: ["/usr/../etc"] }, "readOnly/0"],
    [{ readOnly: ["/usr/.."] }, "readOnly/0"],
    [{ readOnly: ["/usr\0/etc"] }, "readOnly/0"],
  ] satisfies [NonNullable<SandboxInput["policy"]["filesystem"]>, string][]) {
    await rejectsAtStartup(
      t,
      (c) => (sandboxOf(c).policy.filesystem = filesystem),
      invalidValue(`/policy/filesystem/${field}`, FILESYSTEM_PATH),
    );
  }
  // A read-only data mount cannot be granted read-write.
  await rejectsAtStartup(
    t,
    (c) => {
      sandboxOf(c).kubernetes.sandboxDataMount.readOnly = true;
      sandboxOf(c).policy.filesystem = { readWrite: ["/tmp", "/sandbox/enterprise"] };
    },
    invalidValue(
      "/policy/filesystem/readWrite/1",
      "The Sandbox data mount is read-only; remove it from readWrite.",
    ),
  );
  // Every refused setting is named at once, not only the first.
  await rejectsAtStartup(
    t,
    (c) => {
      sandboxOf(c).policy.process.runAsUser = "root";
      sandboxOf(c).policy.filesystem = { readOnly: ["usr"] };
    },
    [
      ...invalidValue("/policy/process/runAsUser", IDENTITY),
      ...invalidValue("/policy/filesystem/readOnly/0", FILESYSTEM_PATH),
    ],
  );
  // Control: a writable data mount may be listed in readWrite.
  const writable = sandboxInstallation();
  sandboxOf(writable).policy.filesystem = { readWrite: ["/sandbox/enterprise"] };
  await loadInstallationFile(t, writable);
  await rejectsAtStartup(
    t,
    (c) => Reflect.set(sandboxOf(c).policy, "filesystem", { includeWorkdir: "no" }),
    structuralRefusal("/policy/filesystem/includeWorkdir", "type", "INVALID_TYPE"),
  );
  await rejectsAtStartup(
    t,
    (c) => Reflect.set(sandboxOf(c).policy, "filesystem", { readwrite: ["/data"] }),
    structuralRefusal("/policy/filesystem", "additionalProperties", "UNKNOWN_FIELD"),
  );
});

// A quoted "false" reached the Gateway as user_namespaces=true, and an endpoint without ports
// started and failed every CreateSandbox (findings 2355, 2354).
test("startup refuses a non-boolean userNamespaces and an endpoint without ports", async (t) => {
  for (const userNamespaces of ["false", 0, null]) {
    await rejectsAtStartup(
      t,
      (c) => Reflect.set(sandboxOf(c).kubernetes, "userNamespaces", userNamespaces),
      structuralRefusal("/kubernetes/userNamespaces", "type", "INVALID_TYPE"),
    );
  }
  await rejectsAtStartup(
    t,
    (c) => (endpointOf(c).ports = []),
    structuralRefusal("/policy/networkPolicies/0/endpoints/0/ports", "minItems"),
  );
});
test("startup refuses OpenShell Agent resources that are not objects", async (t) => {
  for (const [field, value] of [
    ["requests", "1"],
    ["limits", ["x"]],
  ] as const) {
    await rejectsAtStartup(
      t,
      (c) => (sandboxOf(c).kubernetes.agentResources = { [field]: value }),
      structuralRefusal(`/kubernetes/agentResources/${field}`, "type", "INVALID_TYPE"),
    );
  }
});

test("startup rejects OpenShell network policies without binary identities", (t) =>
  rejectsAtStartup(
    t,
    (c) => (firstPolicyOf(c).binaries = []),
    structuralRefusal("/policy/networkPolicies/0/binaries", "minItems"),
  ));

test("startup rejects duplicate OpenShell network policy names", async (t) => {
  for (const [name, expected] of [
    [
      "model-egress",
      [
        {
          path: "/policy/networkPolicies/1/name",
          code: "INVALID_VALUE",
          message: "Network policy names must be unique.",
        },
      ],
    ],
    [
      "workspace-node-enrollment",
      [
        {
          path: "/policy/networkPolicies/1/name",
          code: "INVALID_VALUE",
          message: "This policy name is reserved for platform networking.",
        },
      ],
    ],
  ] as const) {
    await rejectsAtStartup(t, (c) => policiesOf(c).push({ ...firstPolicyOf(c), name }), expected);
  }
});

test("startup rejects inherited OpenShell network enum property names", async (t) => {
  for (const [field, value] of [
    ["tls", "toString"],
    ["enforcement", "constructor"],
    ["access", "__proto__"],
  ] as const) {
    await rejectsAtStartup(
      t,
      (c) => Reflect.set(endpointOf(c), field, value),
      structuralRefusal(`/policy/networkPolicies/0/endpoints/0/${field}`, "enum"),
    );
  }
});

test("startup rejects the deprecated OpenShell passthrough spelling", (t) =>
  rejectsAtStartup(t, (c) => Reflect.set(endpointOf(c), "tls", "passthrough"), TLS_MODE));

test("startup rejects the removed per-Sandbox OpenShell ServiceAccount mode", (t) =>
  rejectsAtStartup(
    t,
    (c) => Reflect.set(sandboxOf(c).kubernetes.serviceAccount, "mode", "driverConfig"),
    structuralRefusal("/kubernetes/serviceAccount/mode", "const"),
  ));

test("startup rejects an invalid OpenShell gateway readiness wait", async (t) => {
  for (const [readiness, expected] of [
    [
      { ...readinessWait, timeoutMs: 0 },
      structuralRefusal("/gateway/readiness/timeoutMs", "minimum"),
    ],
    // A Node.js timer fires a longer delay after 1 ms, so the wait would poll back to back.
    [
      { ...readinessWait, timeoutMs: 1_000, pollIntervalMs: 2_147_483_648 },
      structuralRefusal("/gateway/readiness/pollIntervalMs", "maximum"),
    ],
    [
      { ...readinessWait },
      [
        {
          path: "/gateway/readiness/timeoutMs",
          code: "REQUIRED",
          message: "This configuration field is required.",
        },
      ],
    ],
  ] as const) {
    await rejectsAtStartup(
      t,
      (c) => Reflect.set(sandboxOf(c).gateway, "readiness", readiness),
      expected,
    );
  }
});

test("shipped startup names a rejected OpenShell policy without logging its name", async (t) => {
  const directory = await temporaryDirectory(t, "occ-policy-name-");
  const template = firstPolicyOf(sandboxInstallation());
  const planted = "planted-policy-token";

  function start(policies: NetworkPolicyInput[]) {
    const configuration = sandboxInstallation();
    configuration.drivers.sandbox.configuration.policy.networkPolicies = policies;
    const path = join(directory, "installation.yaml");
    return writeFile(path, JSON.stringify(configuration), "utf8").then(() =>
      spawnSync(process.execPath, ["apps/controller/src/server.mjs"], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "development",
          OCC_HOST: "127.0.0.1",
          OCC_PORT: "18081",
          OCC_AUTH_BASE_URL: "https://console.oce.localhost",
          OCC_AGENT_NATIVE_ADMIN_DOMAIN: "agents.oce.localhost",
          OCC_CONFIG_PATH: path,
        },
        encoding: "utf8",
        timeout: 20_000,
      }),
    );
  }

  function diagnostic(server: SpawnSyncReturns<string>) {
    assert.equal(server.status, 1, server.stderr);
    const event = server.stderr
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line): unknown => JSON.parse(line))
      .find(
        (line): line is Record<string, unknown> =>
          typeof line === "object" &&
          line !== null &&
          "event" in line &&
          line.event === "startup-error",
      );
    assert.ok(event, server.stderr);
    return event;
  }

  const duplicate = await start([
    { ...template, name: planted },
    { ...template, name: planted },
  ]);
  const duplicateEvent = diagnostic(duplicate);
  assert.equal(duplicateEvent.code, "DRIVER_CONFIGURATION_INVALID");
  assert.deepEqual(duplicateEvent.details, [
    {
      path: "/policy/networkPolicies/1/name",
      code: "INVALID_VALUE",
      message: "Network policy names must be unique.",
    },
  ]);
  assert.equal(duplicateEvent.reason, undefined);
  assert.equal(`${duplicate.stdout}${duplicate.stderr}`.includes(planted), false);

  const reserved = await start([
    { ...template, name: "model-egress" },
    { ...template, name: "workspace-node-enrollment" },
  ]);
  const reservedEvent = diagnostic(reserved);
  assert.equal(reservedEvent.code, "DRIVER_CONFIGURATION_INVALID");
  assert.deepEqual(reservedEvent.details, [
    {
      path: "/policy/networkPolicies/1/name",
      code: "INVALID_VALUE",
      message: "This policy name is reserved for platform networking.",
    },
  ]);
  assert.equal(reservedEvent.reason, undefined);
  assert.equal(`${reserved.stdout}${reserved.stderr}`.includes("workspace-node-enrollment"), false);
});

test("repository.openShell names each unmet requirement, including ones earlier checks preempt", () => {
  const configuration = {
    registrationName: "oce-prepared-git",
    authority: {
      host: "127.0.0.1",
      port: 8443,
      certificatePath: "/certificate",
      privateKeyPath: "/private-key",
      issuerPublicKeyPath: "/issuer-public-key",
      issuer: "issuer",
      audience: "audience",
      keyId: "key",
    },
  };
  let messages: string[] = [];
  const refusal = (input: Parameters<typeof validateOpenShellRepositoryTransport>[1]) => {
    try {
      validateOpenShellRepositoryTransport(configuration, input);
    } catch (error) {
      assert.ok(error instanceof InstallationFieldError);
      messages = error.details.map(({ message }) => message);
      return error.details.map(({ path, code }) => [path, code]);
    }
    return [];
  };
  const backend = {
    id: "openshell",
    type: "openshell",
    configuration: {
      endpoint: "https://gateway.example.test:8443",
      auth: { mode: "mtls", certificatePath: "/c", privateKeyPath: "/k" },
    },
    drivers: { sandbox: "sandbox", credential_gateway: "gateway" },
  } satisfies NonNullable<Parameters<typeof validateOpenShellRepositoryTransport>[1]["backend"]>;
  const met = {
    prepared: true,
    repository: true,
    backend,
    backendIndex: 2,
    sandbox: true,
    external: false,
    kubernetes: true,
  };
  assert.deepEqual(refusal(met), []);
  assert.doesNotThrow(() =>
    validateOpenShellRepositoryTransport(undefined, { ...met, prepared: false }),
  );
  assert.deepEqual(
    refusal({
      prepared: false,
      repository: false,
      backend: undefined,
      backendIndex: -1,
      sandbox: false,
      external: false,
      kubernetes: false,
    }),
    [
      ["/repository/preparedGitHub", "REQUIRED"],
      // The github entry; its message names the type.
      ["/backend", "REQUIRED"],
      ["/drivers/sandbox", "REQUIRED"],
      ["/drivers/compute", "INVALID_VALUE"],
      // The openshell entry.
      ["/backend", "REQUIRED"],
    ],
  );
  assert.deepEqual(refusal({ ...met, external: true }), [
    ["/drivers/sandbox/package", "INVALID_VALUE"],
  ]);
  const { endpoint: _endpoint, auth: _auth, ...service } = backend.configuration;
  assert.deepEqual(refusal({ ...met, backend: { ...backend, configuration: service } }), [
    ["/backend/2/configuration/endpoint", "REQUIRED"],
    ["/backend/2/configuration/auth", "REQUIRED"],
  ]);
  assert.equal(
    messages[0],
    "repository.openShell requires the openshell backend configuration.endpoint, an https:// URL, rather than serviceName and port.",
  );
  const unauthenticated = {
    ...backend.configuration,
    auth: { mode: "unauthenticated" },
  } satisfies NonNullable<
    Parameters<typeof validateOpenShellRepositoryTransport>[1]["backend"]
  >["configuration"];
  assert.deepEqual(refusal({ ...met, backend: { ...backend, configuration: unauthenticated } }), [
    ["/backend/2/configuration/auth/mode", "INVALID_VALUE"],
  ]);
});
