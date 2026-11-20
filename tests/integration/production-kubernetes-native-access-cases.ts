import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import Type, { type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

import { asRecord } from "../../packages/utils/src/index.ts";
import { parseProductionChart, renderExecutionChart } from "../helpers/production-chart.ts";
import {
  render,
  tooling,
  type ChartRenderOptions,
  type ChartValues,
} from "../helpers/production-chart-network-fixture.ts";
import { findResource } from "../helpers/production-chart-resource.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const labels = Type.Record(Type.String(), Type.String());
const chartResources = Type.Array(
  Type.Object({
    kind: Type.String(),
    metadata: Type.Object({
      name: Type.String(),
      namespace: Type.Optional(Type.String()),
      labels: Type.Optional(labels),
    }),
    spec: Type.Optional(Type.Unknown()),
    rules: Type.Optional(Type.Unknown()),
  }),
);
type ChartResource = Static<typeof chartResources>[number];

const gatewaySpec = Type.Object({
  gatewayClassName: Type.String(),
  listeners: Type.Array(
    Type.Object({
      name: Type.String(),
      hostname: Type.Optional(Type.String()),
      port: Type.Integer(),
      tls: Type.Optional(
        Type.Object({ certificateRefs: Type.Array(Type.Object({ name: Type.String() })) }),
      ),
    }),
  ),
});
const envoyProxySpec = Type.Object({
  provider: Type.Object({
    kubernetes: Type.Object({ envoyService: Type.Object({ type: Type.String() }) }),
  }),
});
const selector = Type.Object({ matchLabels: Type.Optional(labels) });
const networkPolicySpec = Type.Object({
  podSelector: selector,
  ingress: Type.Optional(
    Type.Array(
      Type.Object({
        from: Type.Optional(
          Type.Array(Type.Object({ namespaceSelector: Type.Optional(selector) })),
        ),
        ports: Type.Optional(
          Type.Array(
            Type.Object({
              port: Type.Optional(Type.Union([Type.Integer(), Type.String()])),
              protocol: Type.Optional(Type.String()),
            }),
          ),
        ),
      }),
    ),
  ),
});
const deploymentSpec = Type.Object({
  template: Type.Object({
    spec: Type.Object({
      containers: Type.Array(
        Type.Object({
          name: Type.String(),
          env: Type.Optional(
            Type.Array(Type.Object({ name: Type.String(), value: Type.Optional(Type.String()) })),
          ),
        }),
      ),
    }),
  }),
});
const requiredStrings = Type.Array(Type.String(), { minItems: 1 });
const emptyOrOmitted = Type.Optional(Type.Tuple([]));
const resourceRule = Type.Object({
  apiGroups: requiredStrings,
  resources: requiredStrings,
  verbs: requiredStrings,
  resourceNames: Type.Optional(Type.Array(Type.String())),
  nonResourceURLs: emptyOrOmitted,
});
const urlRule = Type.Object({
  nonResourceURLs: requiredStrings,
  verbs: requiredStrings,
  apiGroups: emptyOrOmitted,
  resources: emptyOrOmitted,
  resourceNames: emptyOrOmitted,
});
const roleRule = Type.Union([resourceRule, urlRule]);
const roleRulesSchema = Type.Array(resourceRule);
const clusterRoleRulesSchema = Type.Array(roleRule);
type RoleRule = Static<typeof roleRule>;
const logRoles = ["oce-openclaw-tenant-api", "oce-openclaw-gateway-observer"];

async function resources(stdout: string): Promise<ChartResource[]> {
  const decoded: unknown = await parseProductionChart(stdout);
  assert.ok(Check(chartResources, decoded), "Helm must render named Kubernetes resources");
  return decoded;
}

async function renderObjects(
  values: ChartValues = {},
  options: ChartRenderOptions = {},
): Promise<ChartResource[]> {
  return resources((await render(values, options)).stdout);
}

function resourceSpec<S extends TSchema>(
  resource: ChartResource | undefined,
  schema: S,
): Static<S> {
  assert.ok(resource, "Expected Helm to render the resource");
  assert.ok(
    Check(schema, resource.spec),
    `Unexpected spec in ${resource.kind}/${resource.metadata.name}`,
  );
  return resource.spec;
}

function productionGateway(objects: ChartResource[]): ChartResource {
  const gateway = objects.find(
    ({ kind, metadata }) =>
      kind === "Gateway" &&
      metadata.namespace === "openclaw-system" &&
      metadata.labels?.["app.kubernetes.io/instance"] === "oce" &&
      metadata.labels["app.kubernetes.io/component"] === "gateway-routing",
  );
  assert.ok(gateway, "Expected the release Gateway in the control plane namespace");
  return gateway;
}

function gatewayListener(gateway: ChartResource, name: string) {
  const listener = resourceSpec(gateway, gatewaySpec).listeners.find((item) => item.name === name);
  assert.ok(listener, `Expected ${name} listener on ${gateway.metadata.name}`);
  return listener;
}

function deploymentEnvironment(objects: ChartResource[], component: "api" | "worker") {
  const name = `openclaw-enterprise-${component}`;
  const deployment = findResource(objects, "Deployment", name);
  const container = resourceSpec(deployment, deploymentSpec).template.spec.containers.find(
    (item) => item.name === component,
  );
  assert.ok(container?.env, `Expected environment on ${component} container in ${name}`);
  return container.env;
}

function roleRules(role: ChartResource): RoleRule[] | undefined {
  if (role.rules === undefined) {
    return undefined;
  }
  const schema = role.kind === "Role" ? roleRulesSchema : clusterRoleRulesSchema;
  assert.ok(Check(schema, role.rules), `Unexpected rules in ${role.kind}/${role.metadata.name}`);
  return role.rules;
}

function clusterRoleRules(objects: ChartResource[], name: string): RoleRule[] {
  const role = findResource(objects, "ClusterRole", name);
  assert.ok(role, `Expected ClusterRole/${name}`);
  const rules = roleRules(role);
  assert.ok(rules, `Expected ClusterRole/${name} to define rules`);
  return rules;
}

function isLogRule({ resources = [] }: RoleRule): boolean {
  return resources.some((resource) => resource === "pods/log" || resource === "events");
}

export function registerSandboxIngressCase(sandboxValues: ChartValues): void {
  test("sandbox ingress uses a separate listener outside OCE cookie scope", tooling, async () => {
    const rendered = await renderObjects(sandboxValues);
    const gateway = productionGateway(rendered);
    const { name: gatewayName, namespace: gatewayNamespace } = gateway.metadata;
    assert.ok(gatewayNamespace, "Expected the release Gateway to have a namespace");
    const listener = gatewayListener(gateway, "sandbox");
    assert.equal(listener.hostname, "*.previews.example.test");
    assert.equal(listener.port, 8443);
    assert.equal(listener.tls?.certificateRefs[0]?.name, "preview-wildcard");
    assert.equal(gatewayListener(gateway, "https").port, 443);

    // Match the policy on the Gateway's Envoy Pods, then the public listener rule.
    const publicRules = rendered
      .filter(
        ({ kind, metadata }) =>
          kind === "NetworkPolicy" && metadata.namespace === "envoy-gateway-system",
      )
      .map((policy) => resourceSpec(policy, networkPolicySpec))
      .filter(
        ({ podSelector }) =>
          podSelector.matchLabels?.["gateway.envoyproxy.io/owning-gateway-namespace"] ===
            gatewayNamespace &&
          podSelector.matchLabels["gateway.envoyproxy.io/owning-gateway-name"] === gatewayName,
      )
      .flatMap(({ ingress }) => ingress ?? [])
      .filter(({ ports }) => ports?.some(({ port }) => port === 8443));
    assert.equal(publicRules.length, 1, "Expected one ingress rule for the sandbox listener");
    const [publicRule] = publicRules;
    assert.ok(publicRule);
    assert.deepEqual(publicRule.from, [
      { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "public-ingress" } } },
    ]);
    assert.deepEqual(publicRule.ports, [{ protocol: "TCP", port: 8443 }]);

    function assertDomainRejected(domain: string, expected: RegExp): Promise<void> {
      return assert.rejects(
        render({ ...sandboxValues, "gatewayRouting.sandbox.domain": domain }),
        expected,
      );
    }

    const invalidAgentDomainMessage =
      /gatewayRouting\.sandbox\.domain must be a DNS hostname usable after an Agent label/;
    await assertDomainRejected("127.1", invalidAgentDomainMessage);
    await assertDomainRejected("api.0x10", invalidAgentDomainMessage);
    await assertDomainRejected(
      "api.123",
      /gatewayRouting\.sandbox\.domain must be .*Agent label; use a DNS suffix/,
    );
    await assertDomainRejected("999.1.2.3", invalidAgentDomainMessage);
    for (const domain of ["example.invalid", "preview.example.invalid"]) {
      await assertDomainRejected(domain, /outside the OCE shared session cookie domain/);
    }
    await assert.rejects(
      render({ ...sandboxValues, "gatewayRouting.sandbox.listenerPort": "10443" }),
      /distinct from private Envoy HTTPS/,
    );
    // The public listener binds in the unprivileged Envoy container.
    await assert.rejects(
      render({ ...sandboxValues, "gatewayRouting.sandbox.listenerPort": "1023" }),
      /gatewayRouting\.sandbox\.listenerPort must be an integer unprivileged port/,
    );
    const lowestListener = await renderObjects({
      ...sandboxValues,
      "gatewayRouting.sandbox.listenerPort": "1024",
    });
    assert.equal(gatewayListener(productionGateway(lowestListener), "sandbox").port, 1024);
    // The sandbox route takes the port after the tenant Gateway port.
    await assert.rejects(
      render({ ...sandboxValues, "gatewayRouting.tenantGatewayPort": "65535" }),
      /gatewayRouting\.tenantGatewayPort must leave room for the adjacent sandbox port/,
    );
    // 65534 leaves 65535 for the sandbox route, so it renders.
    await render({ ...sandboxValues, "gatewayRouting.tenantGatewayPort": "65534" });
    // Dedicated Agent hostnames are agent-<32 hex>.<domain>, so the domain stops at 253 - 39.
    const longestLabel = "a".repeat(63);
    const longestDomain = [longestLabel, longestLabel, "a".repeat(22), longestLabel].join(".");
    const overlongDomain = [longestLabel, longestLabel, "a".repeat(23), longestLabel].join(".");
    const hostnameLimitDomain = [longestLabel, longestLabel, longestLabel, "a".repeat(61)].join(
      ".",
    );
    assert.equal(longestDomain.length, 214);
    assert.equal(overlongDomain.length, 215);
    assert.equal(hostnameLimitDomain.length, 253);
    assert.equal(`agent-${"0".repeat(32)}.${longestDomain}`.length, 253);
    const longest = await renderObjects({
      ...sandboxValues,
      "gatewayRouting.sandbox.domain": longestDomain,
    });
    assert.equal(
      gatewayListener(productionGateway(longest), "sandbox").hostname,
      `*.${longestDomain}`,
    );
    for (const domain of [
      "a..b.com",
      "example.com-",
      "example.-com",
      `${"a".repeat(64)}.test`,
      "localhost",
    ]) {
      await assertDomainRejected(domain, /must be a DNS hostname/);
    }
    for (const domain of [overlongDomain, hostnameLimitDomain]) {
      await assertDomainRejected(
        domain,
        /must not exceed 214 characters, leaving room for the agent-<32 hex>\. prefix/,
      );
    }
    await assert.rejects(
      render({
        ...sandboxValues,
        "agentNativeAdmin.enabled": "false",
        "gatewayRouting.enabled": "false",
      }),
      /sandbox requires gatewayRouting.enabled/,
    );
  });
}

export function registerNativeAdminAndRuntimeLogCases(
  agentNativeAdminValues: ChartValues,
  runtimeLogRules: readonly RoleRule[],
): void {
  test(
    "Agent native admin pilot renders public host settings with private gateway routing",
    tooling,
    async () => {
      const objects = await renderObjects(agentNativeAdminValues);

      const apiEnvironment = deploymentEnvironment(objects, "api");
      const workerEnvironment = deploymentEnvironment(objects, "worker");
      assert.deepEqual(
        apiEnvironment.filter(({ name }) => name.startsWith("OCC_AGENT_NATIVE_ADMIN_")),
        [
          { name: "OCC_AGENT_NATIVE_ADMIN_ENABLED", value: "true" },
          { name: "OCC_AGENT_NATIVE_ADMIN_DOMAIN", value: "agents.example.invalid" },
        ],
      );
      assert.deepEqual(
        apiEnvironment.filter(({ name }) => name === "OCC_AUTH_COOKIE_DOMAIN"),
        [],
      );
      assert.ok(!workerEnvironment.some(({ name }) => name.startsWith("OCC_AGENT_NATIVE_ADMIN_")));
      assert.ok(!workerEnvironment.some(({ name }) => name === "OCC_AUTH_COOKIE_DOMAIN"));
      assert.deepEqual(
        apiEnvironment.filter(({ name }) => name === "OCC_GATEWAY_API_KEY_PATH"),
        [{ name: "OCC_GATEWAY_API_KEY_PATH", value: "/etc/openclaw/gateway-api-key/key" }],
      );
      const gateway = productionGateway(objects);
      assert.equal(resourceSpec(gateway, gatewaySpec).gatewayClassName, "private-envoy-gateway");
      const envoyProxy = findResource(objects, "EnvoyProxy", gateway.metadata.name);
      assert.equal(envoyProxy?.metadata.namespace, gateway.metadata.namespace);
      assert.equal(
        resourceSpec(envoyProxy, envoyProxySpec).provider.kubernetes.envoyService.type,
        "ClusterIP",
      );

      const longest = `${"a.".repeat(99)}example.invalid`;
      // Keep the whole suffix at 214 while preserving the fixture cookie parent.
      const boundary = `a${longest}`;
      assert.equal(boundary.length, 214);
      const boundaryObjects = await renderObjects({
        ...agentNativeAdminValues,
        "agentNativeAdmin.domain": boundary,
      });
      assert.deepEqual(
        deploymentEnvironment(boundaryObjects, "api").filter(
          ({ name }) => name === "OCC_AGENT_NATIVE_ADMIN_DOMAIN",
        ),
        [{ name: "OCC_AGENT_NATIVE_ADMIN_DOMAIN", value: boundary }],
      );
      for (const length of [215, 217, 253]) {
        await assert.rejects(
          render({
            ...agentNativeAdminValues,
            "agentNativeAdmin.domain": `${"a".repeat(length - boundary.length)}${boundary}`,
          }),
          /agentNativeAdmin.domain must not exceed 214 characters/,
        );
      }

      const disabledObjects = await renderObjects();
      const disabledApiEnvironment = deploymentEnvironment(disabledObjects, "api");
      assert.deepEqual(
        disabledApiEnvironment.filter(({ name }) => name.startsWith("OCC_AGENT_NATIVE_ADMIN_")),
        [
          { name: "OCC_AGENT_NATIVE_ADMIN_ENABLED", value: "false" },
          { name: "OCC_AGENT_NATIVE_ADMIN_DOMAIN", value: "agents.example.invalid" },
        ],
      );
      assert.ok(!disabledApiEnvironment.some(({ name }) => name === "OCC_AUTH_COOKIE_DOMAIN"));
    },
  );

  test(
    "Agent runtime log reads add read-only log and Event grants only when enabled",
    tooling,
    async () => {
      const enabled = await renderObjects();
      assert.deepEqual(
        deploymentEnvironment(enabled, "api").filter(
          ({ name }) => name === "OCC_AGENT_RUNTIME_LOGS_ENABLED",
        ),
        [{ name: "OCC_AGENT_RUNTIME_LOGS_ENABLED", value: "true" }],
      );
      for (const name of logRoles) {
        assert.deepEqual(clusterRoleRules(enabled, name).filter(isLogRule), runtimeLogRules, name);
      }
      // Worker and Collector identities never gain log or Event reads.
      for (const object of enabled.filter(
        ({ kind, metadata }) =>
          ["ClusterRole", "Role"].includes(kind) &&
          !(kind === "ClusterRole" && logRoles.includes(metadata.name)),
      )) {
        assert.equal(roleRules(object)?.some(isLogRule) ?? false, false, object.metadata.name);
      }

      const disabled = await renderObjects({ "agentRuntimeLogs.enabled": "false" });
      assert.deepEqual(
        deploymentEnvironment(disabled, "api").filter(
          ({ name }) => name === "OCC_AGENT_RUNTIME_LOGS_ENABLED",
        ),
        [{ name: "OCC_AGENT_RUNTIME_LOGS_ENABLED", value: "false" }],
      );
      for (const name of logRoles) {
        assert.equal(clusterRoleRules(disabled, name).some(isLogRule), false, name);
      }

      // The execution chart grants its tenant API role the observer's Pod and proxy reads
      // (runtime diagnostics) and the same log reads.
      const execution = await resources((await renderExecutionChart()).stdout);
      const executionPodReads = [
        { apiGroups: ["apps"], resources: ["deployments"], verbs: ["list"] },
        { apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] },
        { apiGroups: [""], resources: ["pods/proxy"], verbs: ["get"] },
      ];
      assert.deepEqual(clusterRoleRules(execution, "oce-execution-tenant-api"), [
        ...executionPodReads,
        ...runtimeLogRules,
      ]);
      assert.equal(
        clusterRoleRules(execution, "oce-execution-tenant-worker").some(isLogRule),
        false,
      );
      // Bootstrap Jobs need worker-only creation and retirement, not mutation or TTL authority.
      for (const workerRules of [
        clusterRoleRules(enabled, "oce-openclaw-tenant-worker"),
        clusterRoleRules(execution, "oce-execution-tenant-worker"),
      ]) {
        assert.deepEqual(
          workerRules.filter(({ resources = [] }) => resources.includes("jobs")),
          [{ apiGroups: ["batch"], resources: ["jobs"], verbs: ["get", "create", "delete"] }],
        );
      }
      for (const apiRules of [
        clusterRoleRules(enabled, "oce-openclaw-tenant-api"),
        clusterRoleRules(execution, "oce-execution-tenant-api"),
      ]) {
        assert.equal(
          apiRules.some(({ resources = [] }) => resources.includes("jobs")),
          false,
        );
      }
      const executionDisabled = await resources(
        (await renderExecutionChart("--set", "agentRuntimeLogs.enabled=false")).stdout,
      );
      assert.deepEqual(
        clusterRoleRules(executionDisabled, "oce-execution-tenant-api"),
        executionPodReads,
      );
    },
  );
}

const yamlItems = Type.Array(Type.Unknown());
const themeContainer = Type.Object({
  name: Type.String(),
  env: yamlItems,
  volumeMounts: Type.Optional(Type.Unknown()),
});
const themeDeploymentSpec = Type.Object({
  template: Type.Object({
    metadata: Type.Object({ annotations: Type.Optional(Type.Unknown()) }),
    spec: Type.Object({
      initContainers: Type.Optional(Type.Union([Type.Null(), yamlItems])),
      containers: yamlItems,
      volumes: yamlItems,
    }),
  }),
});
const workloadSelectorSpec = Type.Object({
  template: Type.Object({ spec: Type.Object({ nodeSelector: Type.Optional(Type.Unknown()) }) }),
});

type ComponentResource = { kind: string; metadata: { labels?: Record<string, string> } };

export function findResourceByComponent<T extends ComponentResource>(
  objects: readonly T[],
  kind: string,
  component: string,
): T | undefined {
  return objects.find(
    (object) =>
      object.kind === kind && object.metadata.labels?.["app.kubernetes.io/component"] === component,
  );
}

export function controlPlaneWorkloads<T extends ComponentResource>(objects: readonly T[]) {
  return {
    initialization: findResourceByComponent(objects, "Job", "initialization"),
    api: findResourceByComponent(objects, "Deployment", "api"),
    worker: findResourceByComponent(objects, "Deployment", "worker"),
  };
}

function findNamed(items: readonly unknown[], name: string): unknown {
  return items.find((item) => {
    assert.ok(item !== null && item !== undefined, "Expected a non-null YAML list item");
    return asRecord(item)?.name === name;
  });
}

function themePod(objects: readonly unknown[], component: string) {
  const deployment = objects.find((object) => {
    assert.ok(object !== null && object !== undefined, "Expected a non-null Helm document");
    const resource = asRecord(object);
    if (resource?.kind !== "Deployment") {
      return false;
    }
    assert.ok(
      resource.metadata !== null && resource.metadata !== undefined,
      "Expected Deployment metadata",
    );
    return asRecord(resource.metadata)?.name === `openclaw-enterprise-${component}`;
  });
  const spec = asRecord(deployment)?.spec;
  assert.ok(Check(themeDeploymentSpec, spec), `Expected the ${component} Deployment pod template`);
  return spec.template;
}

export function assertConsoleThemeMounts(
  defaults: readonly unknown[],
  themed: readonly unknown[],
): void {
  for (const objects of [defaults, themed]) {
    for (const component of ["api", "worker"]) {
      const enabled = objects === themed && component === "api";
      const pod = themePod(objects, component);
      const container = findNamed(
        [...(pod.spec.initContainers ?? []), ...pod.spec.containers],
        component,
      );
      assert.ok(Check(themeContainer, container), `Expected the ${component} container`);
      assert.equal(findNamed(container.env, "OCC_CONSOLE_THEME_DIR") !== undefined, enabled);
      const volume = findNamed(pod.spec.volumes, "console-theme");
      assert.equal(volume !== undefined, enabled);
      assert.equal(
        asRecord(pod.metadata.annotations)?.["openclaw.dev/console-theme-checksum"],
        enabled ? "revision-two" : undefined,
      );
      if (enabled) {
        assert.deepEqual(asRecord(volume)?.configMap, {
          name: "console-branding",
        });
        assert.ok(Check(yamlItems, container.volumeMounts), "Expected container volume mounts");
        assert.deepEqual(findNamed(container.volumeMounts, "console-theme"), {
          name: "console-theme",
          mountPath: "/etc/openclaw/console-theme",
          readOnly: true,
        });
      }
    }
  }
}

export function registerConsoleThemeValuesCase(): void {
  test(
    "console theme settings reject YAML booleans and invalid ConfigMap names",
    tooling,
    async (t) => {
      const directory = await temporaryDirectory(t, "oce-console-theme-");
      const writeValues = async (name: string, body: string): Promise<string> => {
        const path = join(directory, name);
        await writeFile(path, body);
        return path;
      };
      const refusals: readonly (readonly [string, string, RegExp])[] = [
        [
          "yes.yaml",
          "api:\n  consoleTheme:\n    configMapName: yes\n    checksum: rev\n",
          /api\.consoleTheme\.configMapName must be a string/,
        ],
        [
          "no.yaml",
          "api:\n  consoleTheme:\n    configMapName: no\n",
          /api\.consoleTheme\.configMapName must be a string/,
        ],
        [
          "checksum.yaml",
          'api:\n  consoleTheme:\n    configMapName: "console-branding"\n    checksum: yes\n',
          /api\.consoleTheme\.checksum must be a string/,
        ],
      ];
      for (const [name, body, refusal] of refusals) {
        const path = await writeValues(name, body);
        await assert.rejects(render({}, { valuesFiles: [path] }), refusal);
      }
      const quoted = await writeValues(
        "quoted.yaml",
        'api:\n  consoleTheme:\n    configMapName: "no"\n    checksum: "rev"\n',
      );
      const objects = await renderObjects({}, { valuesFiles: [quoted] });
      const api = resourceSpec(
        findResource(objects, "Deployment", "openclaw-enterprise-api"),
        themeDeploymentSpec,
      ).template;
      assert.equal(
        asRecord(asRecord(findNamed(api.spec.volumes, "console-theme"))?.configMap)?.name,
        "no",
      );
      assert.equal(
        asRecord(api.metadata.annotations)?.["openclaw.dev/console-theme-checksum"],
        "rev",
      );
      await assert.rejects(
        render({ "api.consoleTheme.configMapName": "false" }),
        /api\.consoleTheme\.configMapName must be a string/,
      );
      await assert.rejects(
        render({ "api.consoleTheme.configMapName": "Not_Valid" }),
        /api\.consoleTheme\.configMapName must be a Kubernetes resource name/,
      );
      const named = await renderObjects(
        { "api.consoleTheme.checksum": "revision-two" },
        { strings: { "api.consoleTheme.configMapName": "false" } },
      );
      const deployment = resourceSpec(
        findResource(named, "Deployment", "openclaw-enterprise-api"),
        themeDeploymentSpec,
      ).template;
      assert.equal(
        asRecord(asRecord(findNamed(deployment.spec.volumes, "console-theme"))?.configMap)?.name,
        "false",
      );
    },
  );
}

export function registerOptionalControlPlaneSelectorsCase(): void {
  test("control-plane node selectors are optional unless configured", tooling, async () => {
    const { initialization, api, worker } = controlPlaneWorkloads(await renderObjects());
    for (const workload of [initialization, api, worker]) {
      assert.equal(
        resourceSpec(workload, workloadSelectorSpec).template.spec.nodeSelector,
        undefined,
      );
    }
  });
}

export function registerControlPlaneSelectorValuesCase(): void {
  test(
    "the chart validates control-plane node selectors against Kubernetes label rules",
    tooling,
    async (t) => {
      const valueMessage = /controlPlane\.nodeSelector values must be Kubernetes label values/;
      const keyMessage = /controlPlane\.nodeSelector keys must be Kubernetes label keys/;
      const refusals: readonly (readonly [string, string, RegExp])[] = [
        ["oce-role", "not valid", valueMessage],
        ["oce-role", "-control", valueMessage],
        ["oce-role", "control.", valueMessage],
        ["oce-role", "a".repeat(64), valueMessage],
        ["a-", "control", keyMessage],
        ["bad key", "control", keyMessage],
      ];
      const refused =
        (message: RegExp) =>
        (error: unknown): boolean => {
          const failure = asRecord(error);
          return (
            failure !== undefined &&
            failure.code !== 0 &&
            typeof failure.stderr === "string" &&
            message.test(failure.stderr)
          );
        };
      for (const [key, value, message] of refusals) {
        await assert.rejects(
          render({}, { strings: { [`controlPlane.nodeSelector.${key}`]: value } }),
          refused(message),
          `${key}=${value}`,
        );
      }
      const directory = await temporaryDirectory(t, "openclaw-node-selector-");
      const selectorValues = join(directory, "selector.yaml");
      await writeFile(
        selectorValues,
        "controlPlane:\n  nodeSelector:\n    Example.com/role: control\n",
      );
      await assert.rejects(render({}, { valuesFiles: [selectorValues] }), refused(keyMessage));
      const { stdout } = await render(
        {},
        {
          strings: {
            "controlPlane.nodeSelector.oce-role": "control",
            "controlPlane.nodeSelector.topology\\.kubernetes\\.io/zone": "east",
            "controlPlane.nodeSelector.node-role\\.kubernetes\\.io/infra": "",
            "controlPlane.nodeSelector.edge": "a_b.c-d",
            [`controlPlane.nodeSelector.${"a".repeat(253)}/pool`]: "control",
          },
        },
      );
      assert.match(stdout, /oce-role: control/);
      assert.match(stdout, /topology\.kubernetes\.io\/zone: east/);
      // Kubernetes allows empty label values; charts before #1848 rendered them.
      assert.match(stdout, /node-role\.kubernetes\.io\/infra: ""/);
      assert.match(stdout, /edge: a_b\.c-d/);
      const api = findResourceByComponent(await resources(stdout), "Deployment", "api");
      const selector = resourceSpec(api, workloadSelectorSpec).template.spec.nodeSelector;
      assert.equal(asRecord(selector)?.[`${"a".repeat(253)}/pool`], "control");
    },
  );
}
