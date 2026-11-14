import {
  ConfigurationValidationError as SharedConfigurationValidationError,
  type AgentRevision,
  type HarnessAuthSnapshot,
  type OpenClawConfigurationDocument,
  type OpenClawConfigurationValue,
  type RevisionHarnessDescriptor,
  type SecretBindings,
} from "../../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import {
  createKubernetesComputeDriver,
  KubernetesComputeDriver,
  kubernetesNamespaceName,
  kubernetesGatewayNamespaceName,
  PLUGIN_RUNTIME_STATUS_PORT,
  type KubernetesComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  ComputeGatewaySettingError,
  ConfigurationHarnessError,
} from "../../packages/occ/src/index.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  ACCEPTED_DEVICE_AUTO_APPROVE,
  INVALID_ALLOW_USERS,
  INVALID_DEVICE_AUTO_APPROVE,
} from "../helpers/trusted-proxy-shapes.mjs";
import {
  CODEX_PLACEMENT_REFUSAL,
  KUBERNETES_ALLOW_USERS_REFUSAL,
  KUBERNETES_DEVICE_AUTO_APPROVE_REFUSAL,
} from "../helpers/refusal-text.mjs";
import {
  tenant,
  apiKeyAuth,
  authContext,
  options,
  digest,
  gatewayRouting,
  routedOptions,
  routedRevision,
} from "../helpers/kubernetes-routed-scenarios.mjs";
import { conformanceKubeconfig } from "../helpers/kubernetes-compute.mjs";
import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import { asRecord } from "../../packages/utils/src/objects.ts";
import { unexpectedNodeEnrollment } from "./kubernetes-namespace-placement-cases.ts";

type NamespaceAddress = { readonly name: string; readonly plane: "control" | "execution" };
type KubernetesSdk = Awaited<ReturnType<typeof createKubernetesClientConfiguration>>["sdk"];
type NetworkingApi = InstanceType<KubernetesSdk["NetworkingV1Api"]>;
type NetworkPolicy = Awaited<ReturnType<NetworkingApi["readNamespacedNetworkPolicy"]>>;
type ExecutionCluster = NonNullable<KubernetesComputeDriverOptions["executionCluster"]>;

function sandboxSettings(document: OpenClawConfigurationDocument) {
  const apps = asRecord(asRecord(document.mcp)?.apps);
  const sandboxOrigin = apps?.sandboxOrigin;
  const sandboxPort = apps?.sandboxPort;
  assert.ok(typeof sandboxOrigin === "string");
  assert.ok(typeof sandboxPort === "number");
  return { sandboxOrigin, sandboxPort };
}

const { kubeconfigPath, context: contextName } = conformanceKubeconfig;

export function twoClusterOptions() {
  const executionCluster: ExecutionCluster = {
    authentication: { mode: "kubeconfig", kubeconfigPath, context: "execution-cluster" },
    harnessRouting: {
      ...gatewayRouting,
      gatewayName: "harnesses",
      hostname: "harness.example.test",
    },
    network: {
      dns: options().network.dns,
      harnessEndpointCidrs: ["192.0.2.2/32"],
      gatewayEndpointCidrs: ["192.0.2.1/32"],
      pluginStatusProxySourceCidrs: ["192.0.2.2/32"],
    },
  };
  return {
    ...routedOptions({
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
    }),
    executionCluster,
  };
}

export function checkNativeGatewayListenerPorts() {
  const runtime = { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" };
  // Plugin status serves on 18791 without a native runtime too, so 18791 is refused either way.
  for (const [gatewayPort, sandbox, withRuntime] of [
    [18791, false, true],
    [18791, false, false],
    [18790, true, true],
  ] as const) {
    const configured = routedOptions({
      ...(withRuntime ? { runtime } : {}),
      network: { gatewayPort },
      gatewayRouting: {
        ...gatewayRouting,
        ...(sandbox ? { sandbox: { domain: "previews.example.test" } } : {}),
      },
    });
    assert.throws(
      () => createKubernetesComputeDriver(configured),
      SharedConfigurationValidationError,
    );
  }
  // 18790 remains valid without the auxiliary listener; neighboring ordinary
  // and sandbox ports must retain the existing configured-port contract.
  for (const [gatewayPort, sandbox] of [
    [18790, false],
    [18792, true],
    [8080, true],
  ] as const) {
    const configured = routedOptions({
      runtime,
      network: { gatewayPort },
      gatewayRouting: {
        ...gatewayRouting,
        ...(sandbox ? { sandbox: { domain: "previews.example.test" } } : {}),
      },
    });
    assert.doesNotThrow(() => createKubernetesComputeDriver(configured));
  }
}

export function checkMcpAppsListenerPorts() {
  const runtime = { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" };
  const driverFor = (gatewayPort: number, withRuntime = true) => {
    const configured = routedOptions({
      ...(withRuntime ? { runtime } : {}),
      network: { gatewayPort },
    });
    return createKubernetesComputeDriver(configured);
  };
  const reserved = new RegExp(
    `^Configuration setting mcp\\.apps\\.sandboxPort .*reserved runtime status port ${PLUGIN_RUNTIME_STATUS_PORT}\\.$`,
  );
  // OpenClaw binds mcp.apps.sandboxPort, else gatewayPort + 1, whether or not Compute routes it.
  const rejected: readonly [number, OpenClawConfigurationDocument, boolean][] = [
    [8080, { sandboxPort: PLUGIN_RUNTIME_STATUS_PORT }, true],
    [8080, { enabled: false, sandboxPort: PLUGIN_RUNTIME_STATUS_PORT }, false],
    [PLUGIN_RUNTIME_STATUS_PORT - 1, { enabled: true }, true],
    [PLUGIN_RUNTIME_STATUS_PORT - 1, { enabled: true }, false],
  ];
  for (const [gatewayPort, apps, withRuntime] of rejected) {
    const driver = driverFor(gatewayPort, withRuntime);
    // Admission names the setting, so the refusal reaches the Agent's owner before deploy.
    assert.throws(
      () => driver.validateGatewaySettings({ mcp: { apps } }),
      (error) => error instanceof Error && reserved.test(error.message),
      JSON.stringify({ gatewayPort, apps, withRuntime }),
    );
  }
  const accepted: readonly [number, OpenClawConfigurationDocument][] = [
    [8080, { enabled: true }],
    [8080, { enabled: true, sandboxPort: PLUGIN_RUNTIME_STATUS_PORT + 1 }],
    [PLUGIN_RUNTIME_STATUS_PORT - 1, { enabled: true, sandboxPort: 9000 }],
    [PLUGIN_RUNTIME_STATUS_PORT - 1, { enabled: false }],
    [PLUGIN_RUNTIME_STATUS_PORT - 1, {}],
  ];
  for (const [gatewayPort, apps] of accepted) {
    assert.doesNotThrow(
      () => driverFor(gatewayPort).validateGatewaySettings({ mcp: { apps } }),
      JSON.stringify({ gatewayPort, apps }),
    );
  }
}

export function checkSandboxPreviewRouting() {
  const driver = createKubernetesComputeDriver(
    routedOptions({
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
      gatewayRouting: {
        ...gatewayRouting,
        sandbox: { domain: "previews.example.test", publicPort: 9443 },
      },
    }),
  );
  const revision = routedRevision(driver);
  const document = driver["gatewaySandboxConfiguration"](revision, revision.configuration);
  const origin = new URL(sandboxSettings(document).sandboxOrigin);
  assert.equal(origin.protocol, "https:");
  assert.equal(origin.port, "9443");
  assert(origin.hostname.endsWith(".previews.example.test"));
  assert.notEqual(origin.hostname, gatewayRouting.hostname);
  assert.deepEqual(document.gateway, revision.configuration.gateway);
  const embeddedConfiguration = {
    ...revision.configuration,
    mcp: { apps: { sandboxOrigin: "https://embedded-preview.example.test" } },
  };
  assert.deepEqual(
    driver["gatewaySandboxConfiguration"](
      { ...revision, harness: { ...revision.harness, mode: "embedded" } },
      embeddedConfiguration,
    ),
    embeddedConfiguration,
    "dedicated preview routing must not replace an Embedded Agent's native configuration",
  );
  assert.equal(
    sandboxSettings(
      driver["gatewaySandboxConfiguration"](
        { ...revision, id: "replacement" },
        revision.configuration,
      ),
    ).sandboxOrigin,
    origin.origin,
  );
  assert.notEqual(
    sandboxSettings(
      driver["gatewaySandboxConfiguration"](
        { ...revision, agentId: "another-agent" },
        revision.configuration,
      ),
    ).sandboxOrigin,
    origin.origin,
  );
  assert.throws(
    () =>
      driver["gatewaySandboxConfiguration"](revision, {
        ...revision.configuration,
        mcp: { apps: { sandboxOrigin: "https://trusted-admin.example.test" } },
      }),
    /Compute-owned sandbox route/,
  );
  const ownership = { namespaceId: tenant.id, agentId: revision.agentId };
  const namespace: NamespaceAddress = {
    name: kubernetesNamespaceName(tenant.id),
    plane: "control",
  };
  const service = driver["service"]("gateway-test", ownership, namespace, {});
  const route = driver["gatewayRoute"](revision, ownership, namespace, service, "sandbox");
  const spec = route?.spec;
  assert.deepEqual(spec?.hostnames, [origin.hostname]);
  const parentRefs = spec?.parentRefs;
  assert.ok(Array.isArray(parentRefs));
  assert.equal(asRecord(parentRefs[0])?.sectionName, "sandbox");

  function firstRule(routeSpec: typeof spec) {
    const rules = routeSpec?.rules;
    assert.ok(Array.isArray(rules));
    const rule = asRecord(rules[0]);
    assert.ok(rule);
    return rule;
  }
  function backendPort(rule: ReturnType<typeof firstRule>) {
    const backendRefs = rule.backendRefs;
    assert.ok(Array.isArray(backendRefs));
    const port = asRecord(backendRefs[0])?.port;
    assert.equal(typeof port, "number");
    return port;
  }

  const rule = firstRule(spec);
  const matches = rule.matches;
  assert.ok(Array.isArray(matches));
  assert.deepEqual(
    matches.map((match: unknown) => asRecord(match)?.method),
    ["GET", "HEAD"],
  );
  const port = backendPort(rule);
  assert.equal(port, sandboxSettings(document).sandboxPort);
  assert.notEqual(
    port,
    backendPort(firstRule(driver["gatewayRoute"](revision, ownership, namespace, service)?.spec)),
  );

  const filters = rule.filters;
  assert.ok(Array.isArray(filters));
  const headers = asRecord(asRecord(filters[0])?.requestHeaderModifier);
  const removedHeaders = headers?.remove;
  const setHeaders = headers?.set;
  assert.ok(Array.isArray(removedHeaders));
  assert.ok(Array.isArray(setHeaders));
  for (const name of ["cookie", "authorization", "x-api-key", "x-occ-identity"]) {
    assert.ok(removedHeaders.includes(name));
    assert.ok(!setHeaders.some((header: unknown) => asRecord(header)?.name === name));
  }
  const servicePorts = service.spec?.ports;
  assert.ok(Array.isArray(servicePorts));
  assert.ok(servicePorts.some((servicePort: unknown) => asRecord(servicePort)?.port === port));
  const disabled = createKubernetesComputeDriver(routedOptions());
  assert.equal(
    disabled["gatewayRoute"](revision, ownership, namespace, service, "sandbox"),
    undefined,
  );
}

// Preparation renders the native hook relay and the sandbox route into a dedicated Agent's
// document, and refused a caller's conflicting value only after a dedicated deployment had
// stopped its predecessors (findings 2315, 2317). Deployment admission now names the setting.
export function checkRenderedGatewaySettingsAdmission() {
  const driver = new KubernetesComputeDriver(
    routedOptions({
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
      gatewayRouting: {
        ...gatewayRouting,
        sandbox: { domain: "previews.example.test", publicPort: 9443 },
      },
    }),
    { nodeEnrollment: unexpectedNodeEnrollment() },
  );
  const codex: RevisionHarnessDescriptor = { id: "codex", version: "1.0.0", mode: "dedicated" };
  const configuration = createHarnessConfiguration("codex", "gpt-5");
  const authentication: HarnessAuthSnapshot = {
    ...apiKeyAuth,
    method: "api_key",
    source: { ...apiKeyAuth.source, kind: "secret" },
  };
  const revision = routedRevision(driver, { configuration });
  const { sandboxOrigin, sandboxPort } = sandboxSettings(
    driver["gatewaySandboxConfiguration"](revision, configuration),
  );
  const prepare = (document: OpenClawConfigurationDocument) =>
    driver["gatewayNativeHookRelayConfiguration"](
      revision,
      driver["gatewaySandboxConfiguration"](revision, document),
    );
  const admit = (
    document: OpenClawConfigurationDocument,
    harness = codex,
    secretBindings: SecretBindings | null = {},
  ) => driver.validateHarnessAuth(harness, authentication, document, secretBindings);
  const { codex: plugin } = configuration.plugins?.entries ?? {};
  assert.ok(plugin);
  const withAppServer = (appServer: OpenClawConfigurationValue): OpenClawConfigurationDocument => {
    return {
      ...configuration,
      plugins: {
        ...configuration.plugins,
        entries: { codex: { ...plugin, config: { ...plugin.config, appServer } } },
      },
    };
  };
  const appServer = plugin.config.appServer;
  const hookRelay = "plugins.entries.codex.config.appServer.nativeHookRelay";
  const route = "match the Compute-owned sandbox route";

  // Compute's own values, and a document that leaves them unset (or null on the relay's path),
  // pass both.
  for (const document of [
    configuration,
    { ...configuration, mcp: { apps: { enabled: true, sandboxOrigin, sandboxPort } } },
    withAppServer(null),
  ]) {
    admit(document);
    prepare(document);
  }
  const refusals: readonly [OpenClawConfigurationDocument, string, string][] = [
    [
      withAppServer({
        ...appServer,
        nativeHookRelay: { url: "https://other-agent.example.test/hooks" },
      }),
      hookRelay,
      "must be unset on Dedicated Codex: the native hook relay is owned by the Compute Driver",
    ],
    [
      withAppServer({ ...appServer, nativeHookRelay: null }),
      hookRelay,
      "must be unset on Dedicated Codex: the native hook relay is owned by the Compute Driver",
    ],
    [
      withAppServer("on"),
      "plugins.entries.codex.config.appServer",
      "must be an object on Dedicated Codex",
    ],
    [{ ...configuration, mcp: "on" }, "mcp", "must be an object"],
    [{ ...configuration, mcp: { apps: [] } }, "mcp.apps", "must be an object"],
    // The administrative origin, and the route's origin without its port, under another
    // domain, or with a path.
    ...[
      "https://trusted-admin.example.test",
      sandboxOrigin.replace(":9443", ""),
      sandboxOrigin.replace("previews.example.test", "previews.example.test.evil.test"),
      `${sandboxOrigin}/x`,
    ].map((origin): [OpenClawConfigurationDocument, string, string] => [
      { ...configuration, mcp: { apps: { sandboxOrigin: origin } } },
      "mcp.apps.sandboxOrigin",
      `must be unset or ${route}`,
    ]),
    [
      { ...configuration, mcp: { apps: { sandboxPort: sandboxPort + 1 } } },
      "mcp.apps.sandboxPort",
      `must be unset or ${sandboxPort} to ${route}`,
    ],
  ];
  for (const [document, setting, requirement] of refusals) {
    const message = `Configuration setting ${setting} ${requirement}.`;
    assert.throws(() => admit(document), { name: "ConfigurationHarnessError", message }, setting);
    assert.throws(() => prepare(document), { message }, setting);
    // They follow the Installation's runtime and routing, so Agent save leaves them to deployment.
    admit(document, codex, null);
  }
  // Admission has no Agent identity: another Agent's origin passes it, and preparation refuses it.
  const otherAgent = {
    ...configuration,
    mcp: {
      apps: {
        sandboxOrigin: sandboxOrigin.replace(/agent-[0-9a-f]{32}/, `agent-${"0".repeat(32)}`),
      },
    },
  };
  admit(otherAgent);
  assert.throws(() => prepare(otherAgent), {
    message: `Configuration setting mcp.apps.sandboxOrigin must be unset or ${route}.`,
  });
  // Without Compute's rendering the caller's values stay: an Embedded Agent keeps its native
  // preview settings, and a Compute with no runtime or routing renders no hook relay.
  const embedded = createHarnessConfiguration("openclaw", "gpt-5");
  admit(
    { ...embedded, mcp: { apps: { sandboxOrigin: "https://embedded-preview.example.test" } } },
    { id: "openclaw", version: "1.0.0", mode: "embedded" },
  );
  const relayed = withAppServer({
    ...appServer,
    nativeHookRelay: { url: "https://hooks.example.test" },
  });
  // Without gatewayRouting.sandbox the caller's own preview settings stay too.
  const previews = {
    ...relayed,
    mcp: { apps: { sandboxOrigin: "https://preview.example.test", sandboxPort: 1234 } },
  };
  createKubernetesComputeDriver(routedOptions()).validateHarnessAuth(
    codex,
    authentication,
    previews,
    {},
  );
  // Runtime storage without gateway routing renders neither, and admission refuses the
  // dedicated deployment itself (finding 2349).
  assert.throws(
    () =>
      createKubernetesComputeDriver(
        options({
          runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
        }),
      ).validateHarnessAuth(codex, authentication, previews, {}),
    { message: CODEX_PLACEMENT_REFUSAL },
  );
  // Compute relays native hooks only for Codex: a dedicated OpenClaw document keeps the key.
  const openclaw: AgentRevision = {
    ...revision,
    harness: { ...revision.harness, id: "openclaw" },
  };
  assert.equal(driver["gatewayNativeHookRelayConfiguration"](openclaw, relayed), relayed);
}

function assertConfigurationRefusal(
  configuration: unknown,
  path: string,
  code: string,
  message?: RegExp,
) {
  assert.throws(
    () => {
      // @ts-expect-error Submit malformed options to the public factory as a JavaScript caller can.
      createKubernetesComputeDriver(configuration);
    },
    (error) => {
      assert.ok(error instanceof SharedConfigurationValidationError);
      const [detail] = error.error.details;
      assert.equal(detail.path, path);
      assert.equal(detail.code, code);
      if (message !== undefined) {
        assert.ok(detail.message);
        assert.match(detail.message, message);
      }
      return true;
    },
  );
}

export function checkHarnessRoutingHostnames() {
  const twoCluster = twoClusterOptions();
  const { harnessRouting, ...cluster } = twoCluster.executionCluster;
  const { hostname: validHostname, ...withoutHostname } = harnessRouting;
  const configure = (hostname?: string | number) => ({
    ...twoCluster,
    executionCluster: {
      ...cluster,
      harnessRouting: hostname === undefined ? withoutHostname : { ...withoutHostname, hostname },
    },
  });
  const path = "/executionCluster/harnessRouting/hostname";
  // These final labels would make a URL parser read the name as IPv4 instead of a DNS hostname.
  for (const hostname of ["127.1", "0x7f.1", "api.123", "harness.0x10"]) {
    assertConfigurationRefusal(configure(hostname), path, "INVALID_FORMAT", /parses as IPv4/);
  }
  for (const hostname of ["Harness.example.test", "harness.example.test:443", "harness_1.test"]) {
    assertConfigurationRefusal(configure(hostname), path, "INVALID_FORMAT");
  }
  assertConfigurationRefusal(configure(7), path, "INVALID_TYPE");
  assertConfigurationRefusal(configure(""), path, "REQUIRED");
  assertConfigurationRefusal(configure(), path, "REQUIRED");
  for (const hostname of [validHostname, "1password.example.test", "0x.example.test"]) {
    assert.doesNotThrow(
      () =>
        createKubernetesComputeDriver({
          ...twoCluster,
          executionCluster: { ...cluster, harnessRouting: { ...harnessRouting, hostname } },
        }),
      hostname,
    );
  }
}

export function checkHarnessRoutingSettings() {
  const twoCluster = twoClusterOptions();
  const { harnessRouting, ...cluster } = twoCluster.executionCluster;
  const { gatewayName, envoyNamespace, ...withoutGatewayOrEnvoy } = harnessRouting;
  const refusals = [
    ["gatewayName", { ...harnessRouting, gatewayName: "Bad_Name" }, "INVALID_FORMAT"],
    ["gatewayName", { ...withoutGatewayOrEnvoy, envoyNamespace }, "REQUIRED"],
    [
      "gatewayNamespace",
      { ...harnessRouting, gatewayNamespace: "Bad_Namespace" },
      "INVALID_FORMAT",
    ],
    ["gatewayNamespace", { ...harnessRouting, gatewayNamespace: "" }, "REQUIRED"],
    ["envoyNamespace", { ...harnessRouting, envoyNamespace: "envoy.system" }, "INVALID_FORMAT"],
    ["envoyNamespace", { ...withoutGatewayOrEnvoy, gatewayName }, "REQUIRED"],
    ["envoyHttpsTargetPort", { ...harnessRouting, envoyHttpsTargetPort: 0 }, "INVALID_VALUE"],
    ["envoyHttpsTargetPort", { ...harnessRouting, envoyHttpsTargetPort: 65536 }, "INVALID_VALUE"],
    ["envoyHttpsTargetPort", { ...harnessRouting, envoyHttpsTargetPort: 443.5 }, "INVALID_TYPE"],
    ["envoyHttpsTargetPort", { ...harnessRouting, envoyHttpsTargetPort: "10443" }, "INVALID_TYPE"],
  ] as const;
  // Execution reuses the harness routing as its Gateway routing. Admission must identify
  // the setting the operator configured on the execution cluster.
  for (const [field, candidate, code] of refusals) {
    assertConfigurationRefusal(
      {
        ...twoCluster,
        executionCluster: { ...cluster, harnessRouting: candidate },
      },
      `/executionCluster/harnessRouting/${field}`,
      code,
    );
  }
  assert.doesNotThrow(() =>
    createKubernetesComputeDriver({
      ...twoCluster,
      executionCluster: {
        ...cluster,
        harnessRouting: { ...harnessRouting, envoyHttpsTargetPort: 8443 },
      },
    }),
  );
}

export function checkSandboxRoutingDomainLimits() {
  const label = "a".repeat(63);
  const sandboxDriver = (domain: string) =>
    createKubernetesComputeDriver(
      routedOptions({
        runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
        gatewayRouting: { ...gatewayRouting, sandbox: { domain } },
      }),
    );
  const longest = [label, label, "a".repeat(22), label].join(".");
  assert.equal(longest.length, 214);
  const driver = sandboxDriver(longest);
  const revision = routedRevision(driver);
  const origin = new URL(
    sandboxSettings(driver["gatewaySandboxConfiguration"](revision, revision.configuration))
      .sandboxOrigin,
  );
  assert.equal(origin.hostname.length, 253);
  for (const domain of [
    [label, label, "a".repeat(23), label].join("."),
    [label, label, label, "a".repeat(61)].join("."),
  ]) {
    assert.throws(() => sandboxDriver(domain), SharedConfigurationValidationError);
  }
  assert.throws(() => sandboxDriver("a..b.test"), SharedConfigurationValidationError);
  // The chart requires a dot too; a single label could never get a usable wildcard certificate.
  for (const domain of ["localhost", "previews", "a".repeat(63)]) {
    assert.throws(() => sandboxDriver(domain), SharedConfigurationValidationError);
  }
  assert.doesNotThrow(() => sandboxDriver("previews.localhost"));
}

export function checkGatewayRoutingNameLimits() {
  const routedDriver = (gatewayName: string) =>
    createKubernetesComputeDriver(
      routedOptions({ gatewayRouting: { ...gatewayRouting, gatewayName } }),
    );
  // The name labels Envoy's proxy Pods, which the NetworkPolicies select on.
  const longest = `${"a".repeat(31)}.${"b".repeat(31)}`;
  assert.equal(longest.length, 63);
  const driver = routedDriver(longest);
  const ingress = driver["networkPolicies"](
    { namespaceId: tenant.id, agentId: "agent-routed" },
    { name: kubernetesNamespaceName(tenant.id), plane: "execution" },
  ).find(
    (policy: unknown) => asRecord(asRecord(policy)?.metadata)?.name === "allow-gateway-ingress",
  );
  const rules = asRecord(asRecord(ingress)?.spec)?.ingress;
  assert.ok(Array.isArray(rules));
  const sources = asRecord(rules[0])?.from;
  assert.ok(Array.isArray(sources));
  const selector = asRecord(asRecord(sources[0])?.podSelector);
  assert.equal(
    asRecord(selector?.matchLabels)?.["gateway.envoyproxy.io/owning-gateway-name"],
    longest,
  );
  for (const gatewayName of ["a".repeat(64), "a".repeat(253)]) {
    assert.throws(() => routedDriver(gatewayName), SharedConfigurationValidationError);
  }
  for (const gatewayName of ["Bad_Name", "a".repeat(254)]) {
    assert.throws(() => routedDriver(gatewayName), SharedConfigurationValidationError);
  }
  // The two-cluster harness Gateway is labelled the same way.
  const twoCluster = twoClusterOptions();
  assert.throws(
    () =>
      createKubernetesComputeDriver({
        ...twoCluster,
        executionCluster: {
          ...twoCluster.executionCluster,
          harnessRouting: {
            ...twoCluster.executionCluster.harnessRouting,
            gatewayName: "a".repeat(64),
          },
        },
      }),
    SharedConfigurationValidationError,
  );
}

export function checkTrustedProxyIdentities() {
  const auth = {
    mode: "trusted-proxy",
    trustedProxy: {
      userHeader: "x-occ-identity",
      allowUsers: ["occ-workspace-files", "oidc:member-01", "oidc:maintainer-02"],
    },
    identityScopes: {
      "occ-workspace-files": ["operator.admin"],
      "oidc:member-01": ["operator.read", "operator.write"],
      "oidc:maintainer-02": ["operator.admin"],
    },
  };
  for (const configure of [options, routedOptions]) {
    const driver = createKubernetesComputeDriver(configure());
    const revision = routedRevision(driver);
    const gateway = revision.configuration.gateway;
    assert.ok(typeof gateway === "object" && gateway !== null && !Array.isArray(gateway));
    const configuration = {
      ...revision.configuration,
      gateway: { ...gateway, auth: structuredClone(auth) },
    };
    const original = structuredClone(configuration);

    // Provisioning and rendering must preserve individual identities without
    // replacing the platform's independently privileged workspace connection.
    driver.validateAgentProvisioning({
      executionMode: "dedicated",
      configuration,
    });
    const rendered = driver["kubernetesGatewayConfigurationDocument"](configuration);
    // Native HTTP APIs ignore identityScopes and give a header-less trusted-proxy request
    // OpenClaw's default operator scopes, operator.admin included (finding 2183). Admitting
    // a human therefore makes the Gateway require x-openclaw-scopes on every request.
    assert.deepEqual(asRecord(rendered.gateway)?.auth, {
      ...auth,
      trustedProxy: { ...auth.trustedProxy, requiredHeaders: ["x-openclaw-scopes"] },
    });
    assert.deepEqual(configuration, original);
    // `auth` with `fields` over it; trustedProxy fields go over its trustedProxy.
    const withAuth = ({
      trustedProxy,
      ...fields
    }: {
      trustedProxy?: OpenClawConfigurationDocument;
      identityScopes?: OpenClawConfigurationDocument;
    } = {}): OpenClawConfigurationDocument => ({
      gateway: {
        auth: { ...auth, ...fields, trustedProxy: { ...auth.trustedProxy, ...trustedProxy } },
      },
    });
    const provision = (configuration: OpenClawConfigurationDocument) => () =>
      driver.validateAgentProvisioning({ executionMode: "dedicated", configuration });
    const settingRefusal =
      (setting: string, text = "") =>
      (error: unknown) =>
        error instanceof ComputeGatewaySettingError &&
        error.setting === setting &&
        error.message.includes(text);
    // Deploy admission (409) and Configuration save (400) refuse with the same text.
    const refusedAtAdmissionAndSave = (
      configuration: OpenClawConfigurationDocument,
      message: string,
      label: string,
    ) => {
      assert.throws(
        () => driver.validateGatewaySettings(configuration),
        (error) => error instanceof ComputeGatewaySettingError && error.message === message,
        label,
      );
      assert.throws(
        () => driver.validateConfiguration(configuration),
        (error) => error instanceof ConfigurationHarnessError && error.message === message,
        label,
      );
    };
    // Machine-only grants keep the identityScopes checks from refusing first.
    const machineGrant = { "occ-workspace-files": ["operator.admin"] };
    const renderedRequiredHeaders = (
      trustedProxy: OpenClawConfigurationDocument,
      identityScopes: OpenClawConfigurationDocument = auth.identityScopes,
    ) => {
      const rendered = driver["kubernetesGatewayConfigurationDocument"](
        withAuth({ trustedProxy, identityScopes }),
      );
      const renderedProxy = asRecord(asRecord(asRecord(rendered.gateway)?.auth)?.trustedProxy);
      assert.ok(renderedProxy);
      return renderedProxy.requiredHeaders;
    };
    // Operator-supplied required headers are kept, the Gateway matches names case-insensitively,
    // and routed access requires a scope ceiling even with a machine-only allowlist.
    assert.deepEqual(renderedRequiredHeaders({ requiredHeaders: ["x-real-ip"] }), [
      "x-real-ip",
      "x-openclaw-scopes",
    ]);
    assert.deepEqual(
      renderedRequiredHeaders({ requiredHeaders: ["X-OpenClaw-Scopes", "x-real-ip"] }),
      ["X-OpenClaw-Scopes", "x-real-ip"],
    );
    assert.deepEqual(renderedRequiredHeaders({ requiredHeaders: [] }), ["x-openclaw-scopes"]);
    // One admitted human is enough to require the header (finding 3007).
    assert.deepEqual(
      renderedRequiredHeaders(
        { allowUsers: ["occ-workspace-files", "oidc:member-01"] },
        { ...machineGrant, "oidc:member-01": ["operator.read"] },
      ),
      ["x-openclaw-scopes"],
    );
    assert.deepEqual(
      renderedRequiredHeaders({ allowUsers: ["occ-workspace-files"] }, machineGrant),
      configure === routedOptions ? ["x-openclaw-scopes"] : undefined,
    );
    assert.deepEqual(
      renderedRequiredHeaders(
        { allowUsers: ["occ-workspace-files"], requiredHeaders: ["x-real-ip"] },
        machineGrant,
      ),
      configure === routedOptions ? ["x-real-ip", "x-openclaw-scopes"] : ["x-real-ip"],
    );
    // Header names the Gateway could never match would refuse every request; non-arrays
    // fail its schema at startup. Both are refused before rollout.
    for (const requiredHeaders of [
      "x-openclaw-scopes",
      null,
      {},
      [""],
      [" x-openclaw-scopes"],
      ["x-openclaw-scopes "],
      ["x-real-ip", 42],
    ]) {
      assert.throws(
        provision(withAuth({ trustedProxy: { requiredHeaders } })),
        settingRefusal("gateway.auth.trustedProxy.requiredHeaders"),
        JSON.stringify(requiredHeaders),
      );
    }
    // The operator HTTPRoute strips these headers, so requiring one on a routed Agent
    // would refuse OCC's own access for good; without routing the operator's proxy decides.
    for (const header of ["authorization", "Cookie", "forwarded", "x-forwarded-for"]) {
      const validate = provision(
        withAuth({ trustedProxy: { requiredHeaders: [header, "x-real-ip"] } }),
      );
      if (configure === routedOptions) {
        assert.throws(
          validate,
          settingRefusal("gateway.auth.trustedProxy.requiredHeaders", "route removes"),
        );
      } else {
        assert.doesNotThrow(validate);
      }
    }

    // Legacy auto-approval grants are unioned into every human's identity scopes upstream.
    // A human allowlist must not silently inherit the pilot's admin device grant.
    for (const adminScope of [
      "operator.admin",
      " operator.admin",
      "operator.admin ",
      "\toperator.admin\n",
    ]) {
      assert.throws(
        provision(
          withAuth({
            trustedProxy: { deviceAutoApprove: { enabled: true, scopes: [adminScope] } },
          }),
        ),
        settingRefusal("gateway.auth.trustedProxy.deviceAutoApprove.scopes"),
      );
    }
    // The Gateway's strict schema refuses these at startup, after a dedicated deployment stopped
    // its predecessor; scopes that are not a list would also skip the admin check above. Deploy
    // admission and Configuration save refuse them, with or without humans (finding 3006).
    for (const deviceAutoApprove of INVALID_DEVICE_AUTO_APPROVE) {
      for (const allowUsers of [auth.trustedProxy.allowUsers, ["occ-workspace-files"]]) {
        refusedAtAdmissionAndSave(
          withAuth({
            trustedProxy: { allowUsers, deviceAutoApprove },
            identityScopes: machineGrant,
          }),
          KUBERNETES_DEVICE_AUTO_APPROVE_REFUSAL,
          JSON.stringify({ allowUsers, deviceAutoApprove }),
        );
      }
    }
    for (const deviceAutoApprove of ACCEPTED_DEVICE_AUTO_APPROVE) {
      const configuration = withAuth({ trustedProxy: { deviceAutoApprove } });
      driver.validateGatewaySettings(configuration);
      driver.validateConfiguration(configuration);
    }
    for (const scopes of [
      "operator.read",
      null,
      {},
      ["operator.read", 42],
      ["operator.reed"],
      [" operator.read"],
      ["operator.read "],
    ]) {
      assert.throws(
        provision(
          withAuth({ identityScopes: { ...auth.identityScopes, "oidc:member-01": scopes } }),
        ),
        settingRefusal("gateway.auth.identityScopes"),
        JSON.stringify(scopes),
      );
    }
    // Removing login admission must not leave channel-linked authority behind.
    // Empty/padded keys also make a native Gateway configuration invalid or ambiguous.
    for (const identity of ["", " oidc:member-01", "oidc:member-01 ", "oidc:removed-03"]) {
      assert.throws(
        provision(
          withAuth({ identityScopes: { ...auth.identityScopes, [identity]: ["operator.admin"] } }),
        ),
        settingRefusal("gateway.auth.identityScopes"),
        JSON.stringify(identity),
      );
    }
    assert.throws(
      provision(withAuth({ trustedProxy: { allowUsers: ["occ-workspace-files"] } })),
      settingRefusal("gateway.auth.identityScopes"),
    );
    // Each native operator scope accepted by the pinned runtime remains usable.
    assert.doesNotThrow(
      provision(
        withAuth({
          identityScopes: {
            ...auth.identityScopes,
            "oidc:member-01": [
              "operator.admin",
              "operator.read",
              "operator.write",
              "operator.sessions.read",
              "operator.sessions.write",
              "operator.approvals",
              "operator.questions",
              "operator.pairing",
              "operator.talk",
              "operator.talk.secrets",
            ],
          },
        }),
      ),
    );
    // Machine-only pilot Agents retain their existing admin auto-approval contract.
    assert.doesNotThrow(
      provision(
        withAuth({
          trustedProxy: {
            allowUsers: ["occ-workspace-files"],
            deviceAutoApprove: { enabled: true, scopes: ["operator.admin"] },
          },
          identityScopes: machineGrant,
        }),
      ),
    );

    // Human grants must not change the machine identity's exact administration.
    for (const machineScopes of [
      [],
      ["operator.read", "operator.write"],
      ["operator.admin", "operator.read"],
      "operator.admin",
    ]) {
      assert.throws(
        provision(
          withAuth({
            identityScopes: { ...auth.identityScopes, "occ-workspace-files": machineScopes },
          }),
        ),
        settingRefusal("gateway.auth.identityScopes", "exactly operator.admin"),
        JSON.stringify(machineScopes),
      );
    }
    // Upstream matches allowUsers exactly, but resolves identityScopes for "@" identities
    // case-insensitively; only exact-case, non-email identities may differ by case.
    assert.doesNotThrow(() =>
      driver["kubernetesGatewayConfigurationDocument"](
        withAuth({
          trustedProxy: { allowUsers: [...auth.trustedProxy.allowUsers, "oidc:Member-01"] },
        }),
      ),
    );

    // An empty list means "allow every proxy user" upstream. Additional humans
    // must not turn explicit admission into a wildcard or remove machine access.
    // Duplicates, case variants that share a grant or spoof the machine identity, and
    // identities a proxy header cannot carry exactly are refused as well.
    for (const allowUsers of INVALID_ALLOW_USERS) {
      const configuration = withAuth({
        trustedProxy: { allowUsers },
        identityScopes: machineGrant,
      });
      const label = JSON.stringify(allowUsers);
      // Preparation renders the same refusal as a setting failure.
      assert.throws(
        () => driver["kubernetesGatewayConfigurationDocument"](configuration),
        (error) =>
          error instanceof Error &&
          "setting" in error &&
          error.setting === "gateway.auth.trustedProxy.allowUsers" &&
          error.message === KUBERNETES_ALLOW_USERS_REFUSAL,
        label,
      );
      // Admission refuses it before any revision, so a dedicated Agent's predecessor keeps
      // serving, and save refuses it where it is written (finding 3032). Neither names a
      // submitted identity.
      refusedAtAdmissionAndSave(configuration, KUBERNETES_ALLOW_USERS_REFUSAL, label);
    }
    // A custom allowlist the Gateway accepts saves and passes admission.
    driver.validateConfiguration({ gateway: { auth } });
    driver.validateGatewaySettings({ gateway: { auth } });
    assert.throws(
      () =>
        driver["kubernetesGatewayConfigurationDocument"](
          withAuth({ identityScopes: { "oidc:maintainer-02": ["operator.admin"] } }),
        ),
      /identityScopes/,
    );
  }
}

export async function checkPodFacingGatewayListeners() {
  const invalid: readonly [OpenClawConfigurationDocument, string][] = [
    [{ bind: "loopback" }, "gateway.bind"],
    [{ bind: "tailnet" }, "gateway.bind"],
    // Native's schema refuses these at startup; admission names them first.
    [{ bind: "Loopback" }, "gateway.bind"],
    [{ bind: "all" }, "gateway.bind"],
    [{ bind: 7 }, "gateway.bind"],
    [{ bind: "custom", customBindHost: "127.0.0.1" }, "gateway.customBindHost"],
    [{ bind: "custom", customBindHost: " 127.1.2.3 " }, "gateway.customBindHost"],
    // Custom needs a plain IPv4 the Pod owns at startup; a Pod IP changes on reschedule.
    [{ bind: "custom" }, "gateway.customBindHost"],
    [{ bind: "custom", customBindHost: "" }, "gateway.customBindHost"],
    [{ bind: "custom", customBindHost: "localhost" }, "gateway.customBindHost"],
    [{ bind: "custom", customBindHost: "::" }, "gateway.customBindHost"],
    [{ bind: "custom", customBindHost: "10.42.0.17" }, "gateway.customBindHost"],
    // Tailscale serve and funnel force a loopback listener whatever bind says.
    [{ tailscale: { mode: "serve" } }, "gateway.tailscale.mode"],
    [{ bind: "lan", tailscale: { mode: "funnel" } }, "gateway.tailscale.mode"],
    [{ tailscale: "serve" }, "gateway.tailscale"],
  ];
  for (const configure of [options, routedOptions]) {
    const driver = createKubernetesComputeDriver(configure());
    let settingFailure: Error | undefined;
    for (const [gateway, setting] of invalid) {
      const candidate = routedRevision(driver, { configuration: { gateway } });
      assert.throws(
        () => driver.validateGatewaySettings(candidate.configuration),
        (error) => error instanceof ComputeGatewaySettingError && error.setting === setting,
      );
      assert.throws(
        () =>
          driver.validateAgentProvisioning({
            executionMode: "dedicated",
            configuration: candidate.configuration,
          }),
        (error) => error instanceof ComputeGatewaySettingError && error.setting === setting,
      );
      // No remote read or write is necessary to reject a listener that cannot
      // accept the Service's Pod-IP traffic. This protects both worker phases.
      driver["clients"] = async () => {
        throw new Error("unexpected cluster access");
      };
      // Preparation refuses it like any other gateway setting, not as an admission conflict.
      if (settingFailure === undefined) {
        const other = routedRevision(driver, { configuration: { gateway: { auth: null } } });
        settingFailure = await driver
          .prepareRevision(other, { ...authContext(other), secretEnvironment: [] })
          .then(
            () => assert.fail("gateway.auth null must be refused"),
            (error: unknown) => {
              assert.ok(error instanceof Error);
              return error;
            },
          );
        assert.match(settingFailure.message, /gateway\.auth /);
      }
      const SettingFailure = settingFailure.constructor;
      for (const operation of ["prepareRevision", "activateRevision"] as const) {
        await assert.rejects(
          driver[operation](candidate, { ...authContext(candidate), secretEnvironment: [] }),
          (error) =>
            error instanceof Error &&
            error.constructor === SettingFailure &&
            new RegExp(setting.replaceAll(".", "\\.")).test(error.message),
        );
      }
    }
    for (const gateway of [
      {},
      { bind: "auto" },
      { bind: "lan" },
      { bind: "custom", customBindHost: " 0.0.0.0 " },
      { bind: "lan", customBindHost: "127.0.0.1" },
      { tailscale: { mode: "off" } },
    ]) {
      assert.doesNotThrow(() => driver.validateGatewaySettings({ gateway }));
    }
  }
}

export function checkTrustedProxyProvisioningAdmission() {
  const driver = createKubernetesComputeDriver(routedOptions());
  const revision = routedRevision(driver);
  assert.deepEqual(driver.agentProvisioning.executionModes, ["dedicated"]);

  assert.doesNotThrow(() =>
    driver.validateAgentProvisioning({
      executionMode: "dedicated",
      configuration: revision.configuration,
    }),
  );
  assert.throws(
    () =>
      driver.validateAgentProvisioning({
        executionMode: "embedded",
        configuration: revision.configuration,
      }),
    { message: "Kubernetes Agent provisioning supports only dedicated execution mode." },
  );

  // Gateway settings in the caller's own Configuration are refused with a typed error that
  // names the setting and what is accepted, never the submitted value (API: 409 with this text).
  const invalid: readonly [OpenClawConfigurationDocument, string, string][] = [
    [
      { gateway: { auth: { mode: "oauth" } } },
      "gateway.auth.mode",
      "must be trusted-proxy: Kubernetes Compute supports only native trusted-proxy gateway authentication",
    ],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            unsupportedField: true,
          },
        },
      },
      "gateway.auth.unsupportedField",
      "is not a supported native gateway authentication field",
    ],
    [
      {
        gateway: {
          auth: {
            identityScopes: { "occ-workspace-files": ["operator.read"] },
          },
        },
      },
      "gateway.auth.identityScopes",
      "must grant occ-workspace-files exactly operator.admin when set",
    ],
    [
      { gateway: { trustedProxies: ["10.99.0.0/16"] } },
      "gateway.trustedProxies",
      "must be omitted or match the Installation's network.gatewayTrustedProxyCidrs",
    ],
    // An invalid list is the same caller mistake, not an Installation fault.
    [
      { gateway: { trustedProxies: ["0.0.0.0/0"] } },
      "gateway.trustedProxies",
      "must be omitted or match the Installation's network.gatewayTrustedProxyCidrs",
    ],
    [{ gateway: { auth: { trustedProxy: [] } } }, "gateway.auth.trustedProxy", "must be an object"],
    [
      { gateway: { auth: { trustedProxy: { userHeader: "x-forwarded-user" } } } },
      "gateway.auth.trustedProxy.userHeader",
      "must be x-occ-identity when set",
    ],
    [
      { gateway: { auth: { trustedProxy: { allowLoopback: true } } } },
      "gateway.auth.trustedProxy.allowLoopback",
      "must be false when set",
    ],
    [
      { gateway: { allowRealIpFallback: false } },
      "gateway.allowRealIpFallback",
      "must be true when set: native trusted-proxy authentication requires it",
    ],
  ];
  for (const [configuration, setting, requirement] of invalid) {
    const failClosed = createKubernetesComputeDriver(routedOptions());
    let clusterTouched = false;
    failClosed["clients"] = async () => {
      clusterTouched = true;
      throw new Error("cluster touched");
    };
    assert.throws(
      () =>
        failClosed.validateAgentProvisioning({
          executionMode: "dedicated",
          configuration: { ...revision.configuration, ...configuration },
        }),
      (error) => {
        assert.ok(error instanceof ComputeGatewaySettingError, String(error));
        assert.equal(error.setting, setting);
        assert.equal(error.message, `Configuration setting ${setting} ${requirement}.`);
        return true;
      },
    );
    assert.equal(clusterTouched, false);
  }
  // The setting path can hold a submitted key: its control characters are replaced, and a
  // long one is cut so the message fits the 256-character provisioning status cap.
  const longKey = `bad\u0007${"k".repeat(300)}`;
  assert.throws(
    () =>
      createKubernetesComputeDriver(routedOptions()).validateAgentProvisioning({
        executionMode: "dedicated",
        configuration: {
          ...revision.configuration,
          gateway: { auth: { mode: "trusted-proxy", [longKey]: true } },
        },
      }),
    (error) => {
      assert.ok(error instanceof ComputeGatewaySettingError, String(error));
      assert.equal(error.setting, `gateway.auth.${longKey}`);
      assert.equal(Array.from(error.message).length, 256);
      assert.match(
        error.message,
        /^Configuration setting gateway\.auth\.bad\?k+… is not a supported native gateway authentication field\.$/,
      );
      return true;
    },
  );

  const missingRouting = createKubernetesComputeDriver(
    options({
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
    }),
  );
  // An Installation that cannot route the plan is not the caller's setting to fix.
  assert.throws(
    () =>
      missingRouting.validateAgentProvisioning({
        executionMode: "dedicated",
        configuration: revision.configuration,
      }),
    (error) =>
      error instanceof Error &&
      !(error instanceof ComputeGatewaySettingError) &&
      /gateway routing and node enrollment/i.test(error.message),
  );
}

export function checkKubernetesConfigurationRequirements() {
  const base = options();
  const {
    authentication,
    resources,
    network: baseNetwork,
    servicePrincipalCredentials,
    ...other
  } = base;
  const { gatewayTrustedProxyCidrs: _trustedProxyCidrs, ...withoutTrustedProxyCidrs } = baseNetwork;
  const refusals = [
    [
      { ...other, resources, network: baseNetwork, servicePrincipalCredentials },
      "/authentication",
      "REQUIRED",
    ],
    [
      options({ authentication: { mode: "kubeconfig", kubeconfigPath, context: "" } }),
      "/authentication/context",
      "REQUIRED",
    ],
    [
      options({
        authentication: {
          mode: "kubeconfig",
          kubeconfigPath: "relative/config",
          context: contextName,
        },
      }),
      "/authentication/kubeconfigPath",
      "INVALID_FORMAT",
    ],
    [{ ...base, authentication: { mode: "ambient" } }, "/authentication/mode", "INVALID_VALUE"],
    [
      options({ images: { gateway: "", agent: "agent:local", requireImmutableDigest: false } }),
      "/images/gateway",
      "REQUIRED",
    ],
    [
      options({ images: { gateway: "gateway:local", agent: "", requireImmutableDigest: false } }),
      "/images/agent",
      "REQUIRED",
    ],
    [
      { ...other, authentication, network: baseNetwork, servicePrincipalCredentials },
      "/resources",
      "REQUIRED",
    ],
    [{ ...other, authentication, resources, servicePrincipalCredentials }, "/network", "REQUIRED"],
    [
      { ...base, network: withoutTrustedProxyCidrs },
      "/network/gatewayTrustedProxyCidrs",
      "REQUIRED",
    ],
    [
      options({ network: { ...baseNetwork, gatewayTrustedProxyCidrs: [] } }),
      "/network/gatewayTrustedProxyCidrs",
      "INVALID_FORMAT",
    ],
  ] as const;
  for (const [configuration, path, code] of refusals) {
    assertConfigurationRefusal(configuration, path, code);
  }
  for (const cidr of ["10.42.0.1/", "10.42.0.1/00", "10.42.0.1/+0", "10.42.0.1/1e1"]) {
    assertConfigurationRefusal(
      options({ network: { ...baseNetwork, gatewayTrustedProxyCidrs: [cidr] } }),
      "/network/gatewayTrustedProxyCidrs/0",
      "INVALID_FORMAT",
      /must be a valid IPv4 or IPv6 CIDR/,
    );
  }
  const unrestrictedCidrs = ["0.0.0.0/0", "::/0", "::ffff:0:0/96", "::ffff:0.0.0.0/96"];
  for (const cidr of unrestrictedCidrs) {
    assertConfigurationRefusal(
      options({ network: { ...baseNetwork, gatewayTrustedProxyCidrs: [cidr] } }),
      "/network/gatewayTrustedProxyCidrs/0",
      "INVALID_FORMAT",
      /Trusted proxy CIDRs cannot cover every address/,
    );
  }
  // The same rule applies to a broad status proxy entry following a permitted source.
  for (const cidr of unrestrictedCidrs) {
    assertConfigurationRefusal(
      options({
        network: { ...baseNetwork, pluginStatusProxySourceCidrs: ["192.0.2.20/32", cidr] },
      }),
      "/network/pluginStatusProxySourceCidrs/1",
      "INVALID_FORMAT",
      /Plugin status proxy CIDRs cannot cover every address/,
    );
  }
  assertConfigurationRefusal(
    options({ network: { ...baseNetwork, pluginStatusProxySourceCidrs: ["10.42.0.1/"] } }),
    "/network/pluginStatusProxySourceCidrs/0",
    "INVALID_FORMAT",
    /Plugin status proxy CIDR 0 must be a valid/,
  );
  assertConfigurationRefusal(
    { ...other, authentication, resources, network: baseNetwork },
    "/servicePrincipalCredentials",
    "REQUIRED",
  );

  // Narrower sources, the Pod CIDR included, start: preflight warns about them instead.
  for (const pluginStatusProxySourceCidrs of [
    ["10.42.0.1/32"],
    ["10.42.0.0/16"],
    ["::/96"],
    ["2001:db8::1/128"],
  ]) {
    assert.doesNotThrow(() =>
      createKubernetesComputeDriver(
        options({ network: { ...baseNetwork, pluginStatusProxySourceCidrs } }),
      ),
    );
  }

  for (const gatewayTrustedProxyCidrs of [
    ["::/96"],
    ["::ffff:0.0.0.0/120"],
    ["::1/128"],
    ["2001:db8::/32"],
  ]) {
    assert.doesNotThrow(() =>
      createKubernetesComputeDriver(
        options({ network: { ...baseNetwork, gatewayTrustedProxyCidrs } }),
      ),
    );
  }

  assert.doesNotThrow(() =>
    createKubernetesComputeDriver(options({ authentication: { mode: "inCluster" } })),
  );
}

// Two clusters: a dedicated Gateway lives in the control-plane Gateway namespace,
// an embedded one in the execution namespace. Activation trims only the namespace
// its own Gateway lives in.
export async function checkActivationPolicyNamespace() {
  const driver = new KubernetesComputeDriver(twoClusterOptions());
  const dedicated = routedRevision(driver);
  const embedded: AgentRevision = {
    ...dedicated,
    id: "revision-embedded-trim",
    harness: { ...dedicated.harness, id: "openclaw", mode: "embedded" },
    configuration: {
      ...dedicated.configuration,
      agents: { defaults: { model: "openai/gpt-5" } },
    },
  };
  const execution: NamespaceAddress = {
    name: kubernetesNamespaceName(tenant.id),
    plane: "execution",
  };
  const control: NamespaceAddress = {
    name: kubernetesGatewayNamespaceName(tenant.id),
    plane: "control",
  };
  const suffix = digest(dedicated.agentId);
  const names = [
    "allow-gateway-agent",
    "allow-gateway-workspace-node",
    "allow-workspace-node-gateway",
    "allow-agent-runtime",
    "allow-plugin-status-proxy",
    "allow-plugin-status-agent",
    "allow-plugin-status-gateway",
  ].map((name) => `${name}-${suffix}`);
  const fixture = (
    target: NamespaceAddress,
    objects: Map<string, NetworkPolicy>,
    deleted: string[],
  ): Pick<NetworkingApi, "readNamespacedNetworkPolicy" | "deleteNamespacedNetworkPolicy"> => ({
    async readNamespacedNetworkPolicy({ name, namespace }) {
      assert.equal(namespace, target.name);
      const value = objects.get(name);
      if (value === undefined) {
        throw Object.assign(new Error("not found"), { statusCode: 404 });
      }
      return structuredClone(value);
    },
    async deleteNamespacedNetworkPolicy({ name, namespace, body }) {
      assert.equal(namespace, target.name);
      const uid = objects.get(name)?.metadata?.uid;
      assert.ok(uid);
      assert.equal(body?.preconditions?.uid, uid);
      deleted.push(`${target.plane}/${name}`);
      objects.delete(name);
      return {};
    },
  });
  for (const [revision, trimmed] of [
    [dedicated, control],
    [embedded, execution],
  ] as const) {
    const deleted: string[] = [];
    const stored = new Map<NamespaceAddress["plane"], ReturnType<typeof fixture>>();
    for (const target of [execution, control]) {
      const objects = new Map<string, NetworkPolicy>(
        names.map((name) => {
          const policy = driver["manifest"](
            "networking.k8s.io/v1",
            "NetworkPolicy",
            name,
            { namespaceId: tenant.id, agentId: dedicated.agentId },
            target,
          );
          return [
            name,
            {
              apiVersion: policy.apiVersion,
              kind: policy.kind,
              metadata: { ...policy.metadata, uid: `${target.plane}-${name}` },
            },
          ];
        }),
      );
      stored.set(target.plane, fixture(target, objects, deleted));
    }
    const controlNetwork = stored.get("control");
    const executionNetwork = stored.get("execution");
    assert.ok(controlNetwork && executionNetwork);
    Object.assign(driver, {
      apiClients: Promise.resolve({ networking: controlNetwork }),
      executionApiClients: Promise.resolve({ networking: executionNetwork }),
    });
    const written: readonly {
      namespace: NamespaceAddress;
      resource: { metadata: { name: string } };
    }[] = driver["agentNetworkPolicies"](revision, execution);
    await driver["deleteUnwrittenAgentPolicies"](revision, execution, written);
    const kept = new Set(
      written
        .filter(({ namespace }) => namespace.plane === trimmed.plane)
        .map(({ resource }) => resource.metadata.name),
    );
    assert.ok(kept.size > 0);
    assert.deepEqual(
      deleted.sort(),
      names
        .filter((name) => !kept.has(name))
        .map((name) => `${trimmed.plane}/${name}`)
        .sort(),
      `${revision.harness.mode} trims only its Gateway namespace`,
    );
  }
}
