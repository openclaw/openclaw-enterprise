import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import Type, { type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

import type { ConfigurationValidationError as ConfigurationValidationErrorType } from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { selectedImageMigrationEntry } from "../../scripts/lib/selected-image-migration.ts";
import {
  goToolEnvironment,
  parseProductionChart,
  renderExecutionChart,
  renderProductionChart,
} from "../helpers/production-chart.ts";
import {
  gatewayRoutingValues,
  render,
  stringNameMessage,
  tooling,
  type ChartRenderOptions,
  type ChartValues,
} from "../helpers/production-chart-network-fixture.ts";
import { findResource } from "../helpers/production-chart-resource.ts";
import { loadYaml, yamlMapping } from "../helpers/kubernetes-yaml.ts";
import {
  initialUpgradeChart,
  inspectWorkerProbe,
  stageSigninChart,
} from "../helpers/production-worker-chart.ts";
import {
  productionChartPath,
  productionValuesTemplateArgs,
} from "../helpers/production-values-template.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const helm = process.env.OCC_HELM_BIN ?? "helm";

const labels = Type.Record(Type.String(), Type.String());
const namedEnvironment = Type.Array(
  Type.Object({ name: Type.String(), value: Type.Optional(Type.String()) }),
);
const migrationJobSpec = Type.Object({
  template: Type.Object({ spec: Type.Object({ initContainers: Type.Array(Type.Unknown()) }) }),
});
const migrationContainer = Type.Object({ name: Type.String(), args: Type.Array(Type.String()) });
const podContainersSpec = Type.Object({
  template: Type.Object({ spec: Type.Object({ containers: Type.Array(Type.Unknown()) }) }),
});
const bootstrapContainer = Type.Object({ env: namedEnvironment });
const jobVolumesSpec = Type.Object({
  template: Type.Object({
    spec: Type.Object({
      volumes: Type.Array(Type.Object({ persistentVolumeClaim: Type.Optional(Type.Unknown()) })),
    }),
  }),
});
const jobTemplateLabelsSpec = Type.Object({
  template: Type.Object({ metadata: Type.Object({ labels }) }),
});
const workerProbe = Type.Object({ exec: Type.Object({ command: Type.Array(Type.String()) }) });
const workerContainer = Type.Object({
  name: Type.String(),
  env: Type.Optional(namedEnvironment),
  volumeMounts: Type.Optional(
    Type.Array(Type.Object({ name: Type.String(), mountPath: Type.String() })),
  ),
  readinessProbe: workerProbe,
  livenessProbe: workerProbe,
  startupProbe: workerProbe,
});
const computeExampleConfiguration = Type.Object({
  network: Type.Object({ gatewayClients: Type.Optional(Type.Unknown()) }),
  resources: Type.Object({
    gateway: Type.Object({
      limits: Type.Object({ cpu: Type.String() }),
      requests: Type.Object({ cpu: Type.String() }),
    }),
    agent: Type.Object({ limits: Type.Object({ cpu: Type.String() }) }),
  }),
  gatewayRouting: Type.Object({ gatewayName: Type.String(), gatewayNamespace: Type.String() }),
});
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

function migrationFrom(resource: ChartResource | undefined): Static<typeof migrationContainer> {
  const containers = resourceSpec(resource, migrationJobSpec).template.spec.initContainers;
  const migration = findNamed(containers, "migration");
  assert.ok(
    Check(migrationContainer, migration),
    "Expected the selected-image migration init container",
  );
  return migration;
}

function workerFrom(resource: ChartResource | undefined): Static<typeof workerContainer> {
  const containers = resourceSpec(resource, podContainersSpec).template.spec.containers;
  const worker = findNamed(containers, "worker");
  assert.ok(Check(workerContainer, worker), "Expected the worker container and its chart probes");
  return worker;
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
      // Automation attestation opts into only the execution-side absence reads.
      const automationObserver = "oce-execution-tenant-automation-observer";
      assert.deepEqual(clusterRoleRules(execution, automationObserver), [
        { apiGroups: [""], resources: ["configmaps"], verbs: ["get"] },
        { apiGroups: ["networking.k8s.io"], resources: ["networkpolicies"], verbs: ["get"] },
      ]);
      assert.equal(
        execution.some(
          (object) =>
            ["RoleBinding", "ClusterRoleBinding"].includes(object.kind) &&
            asRecord(asRecord(object)?.roleRef)?.name === automationObserver,
        ),
        false,
        "The execution automation observer must remain unbound until an administrator grants it.",
      );
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
const themeContainers = Type.Union([Type.String(), yamlItems]);
const themeDeploymentSpec = Type.Object({
  template: Type.Object({
    metadata: Type.Optional(Type.Unknown()),
    spec: Type.Object({
      initContainers: Type.Optional(Type.Union([Type.Null(), themeContainers])),
      containers: themeContainers,
      volumes: yamlItems,
    }),
  }),
});

export function findResourceByComponent<T>(
  objects: readonly T[],
  kind: string,
  component: string,
): T | undefined {
  return objects.find((object) => {
    assert.ok(object !== null && object !== undefined, "Expected a non-null Helm document");
    const resource = asRecord(object);
    if (resource?.kind !== kind) {
      return false;
    }
    assert.ok(
      resource.metadata !== null && resource.metadata !== undefined,
      "Expected resource metadata",
    );
    return (
      asRecord(asRecord(resource.metadata)?.labels)?.["app.kubernetes.io/component"] === component
    );
  });
}

export function controlPlaneWorkloads<T>(objects: readonly T[]) {
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

function findThemeDeployment(objects: readonly unknown[], component: string) {
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
  return asRecord(deployment);
}

function themePod(objects: readonly unknown[], component: string) {
  const spec = findThemeDeployment(objects, component)?.spec;
  assert.ok(Check(themeDeploymentSpec, spec), `Expected the ${component} Deployment pod template`);
  return spec.template;
}

function themeValuesPod(objects: readonly unknown[]) {
  const template = asRecord(asRecord(findThemeDeployment(objects, "api")?.spec)?.template);
  const volumes = asRecord(template?.spec)?.volumes;
  assert.ok(Check(yamlItems, volumes), "Expected API Deployment volumes");
  return { template, volumes };
}

function workloadNodeSelector(workload: unknown): unknown {
  const podSpec = asRecord(asRecord(asRecord(workload)?.spec)?.template)?.spec;
  assert.ok(podSpec !== null && podSpec !== undefined, "Expected workload pod template");
  return asRecord(podSpec)?.nodeSelector;
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
      assert.ok(pod.metadata !== null && pod.metadata !== undefined, "Expected pod metadata");
      assert.equal(
        asRecord(asRecord(pod.metadata)?.annotations)?.["openclaw.dev/console-theme-checksum"],
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
      const objects = await parseProductionChart(
        (await render({}, { valuesFiles: [quoted] })).stdout,
      );
      const api = themeValuesPod(objects);
      assert.equal(
        asRecord(asRecord(findNamed(api.volumes, "console-theme"))?.configMap)?.name,
        "no",
      );
      assert.equal(
        asRecord(asRecord(api.template?.metadata)?.annotations)?.[
          "openclaw.dev/console-theme-checksum"
        ],
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
      const named = await parseProductionChart(
        (
          await render(
            { "api.consoleTheme.checksum": "revision-two" },
            { strings: { "api.consoleTheme.configMapName": "false" } },
          )
        ).stdout,
      );
      const deployment = themeValuesPod(named);
      assert.equal(
        asRecord(asRecord(findNamed(deployment.volumes, "console-theme"))?.configMap)?.name,
        "false",
      );
    },
  );
}

export function registerOptionalControlPlaneSelectorsCase(): void {
  test("control-plane node selectors are optional unless configured", tooling, async () => {
    const { initialization, api, worker } = controlPlaneWorkloads(
      await parseProductionChart((await render()).stdout),
    );
    for (const workload of [initialization, api, worker]) {
      assert.equal(workloadNodeSelector(workload), undefined);
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
      const api = findResourceByComponent(await parseProductionChart(stdout), "Deployment", "api");
      const selector = workloadNodeSelector(api);
      assert.equal(asRecord(selector)?.[`${"a".repeat(253)}/pool`], "control");
    },
  );
}

export async function checkNamedYamlScalarValues(stringNameCaValues: {
  database: ChartValues;
  oidc: ChartValues;
  execution: ChartValues;
}): Promise<void> {
  // --set reads true or 1 as a boolean or number, as YAML does for yes/on/1. Rendered as "true"
  // or "1", the name would pass the name pattern and the Pod would wait for a Secret, key or
  // Namespace that does not exist.
  const scalarCases: [string, string, ChartValues?][] = [
    ["installation.secretName", "true"],
    ["installation.key", "true"],
    ["database.secretName", "123"],
    ["database.caSecretName", "true"],
    ["auth.secretKey", "true"],
    ["dns.namespace", "true"],
    ["api.clients[0].namespace", "1"],
    ["database.appUrlKey", "2"],
    ["bootstrap.credentials.secretName", "true"],
    ["gatewayRouting.envoyNamespace", "true", gatewayRoutingValues],
    ["gatewayRouting.gatewayName", "2024", gatewayRoutingValues],
    ["gatewayRouting.tlsSecretName", "true", gatewayRoutingValues],
    ["api.consoleTheme.configMapName", "true"],
    ["api.consoleTheme.checksum", "1"],
    ["controlPlane.installationChecksum", "1"],
    // Finding 2321: these fields meet an eq comparison first, which cannot compare a string
    // with a number or boolean and used to fail with a Go template type error instead.
    ["database.caKey", "1", stringNameCaValues.database],
    ["auth.oidc.secretName", "2024", stringNameCaValues.oidc],
    ["auth.oidc.secretName", "false", stringNameCaValues.oidc],
    ["database.caSecretName", "2024", stringNameCaValues.oidc],
    ["auth.oidc.caSecretName", "2024", stringNameCaValues.oidc],
    ["executionCluster.apiKubeconfigSecretName", "2024", stringNameCaValues.execution],
    ["executionCluster.workerKubeconfigSecretName", "true", stringNameCaValues.execution],
  ];
  for (const [field, value, enabled = {}] of scalarCases) {
    await assert.rejects(
      render({ ...enabled, [field]: value }),
      (error) => error instanceof Error && error.message.includes(`${field} ${stringNameMessage}`),
      field,
    );
  }
  // An optional name that reads as false or 0 is still unset, as the notice says.
  for (const [value, mounted] of [
    ["occ-database-ca-test", true],
    ["false", false],
    ["0", false],
  ] satisfies [string, boolean][]) {
    const { stdout } = await render({
      ...stringNameCaValues.database,
      "database.caSecretName": value,
    });
    assert.equal(stdout.includes("/etc/openclaw/database-ca"), mounted, value);
  }
}

export async function checkProductionExamples(
  t: TestContext,
  productionExamples: URL,
  ConfigurationValidationError: typeof ConfigurationValidationErrorType,
): Promise<void> {
  const { loadInstallationConfiguration } =
    await import("../../apps/controller/src/composition/installation-config.ts");
  // Operators must replace the trust placeholder with their observed proxy source.
  // A documentation-only address is never a runnable trust default.
  const directory = await temporaryDirectory(t, "occ-production-example-");
  const example = await readFile(new URL("installation.yaml", productionExamples), "utf8");
  assert.match(example, /<actual-proxy-source-cidr>/);
  const installationPath = join(directory, "installation.yaml");
  await writeFile(installationPath, example.replace("<actual-proxy-source-cidr>", "192.0.2.10/32"));
  const drivers = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: installationPath },
  });
  assert.ok(drivers, "Expected production Installation configuration");
  assert.equal(drivers.installation.occ.cluster, "production-west");
  assert.deepEqual(drivers.installation.backend, []);
  assert.equal(drivers.installation.presets?.includeDefaults, true);
  assert.ok(drivers.defaultPresets);
  assert.deepEqual(drivers.defaultPresets.map(({ name }) => name).sort(), [
    "Standard Codex",
    "Standard OpenClaw",
    "default-codex",
  ]);
  const pluginDriver = drivers.pluginDrivers?.[0];
  assert.ok(pluginDriver, "Expected the example Codex Plugin Driver");
  assert.equal(pluginDriver.id, "codex-plugin");
  assert.equal(pluginDriver.discoveryCredential, "none");
  assert.ok(pluginDriver.discoverCatalog, "Expected Plugin catalog discovery");
  const catalog = await pluginDriver.discoverCatalog({ q: "Linear" });
  assert.ok(catalog.plugins.some(({ name }) => name === "Linear"));
  assert.equal(drivers.computeDriver.id, "compute-kubernetes");
  const compute = drivers.installation.drivers.compute.configuration;
  assert.ok(
    Check(computeExampleConfiguration, compute),
    "Expected the example Kubernetes Compute configuration",
  );
  assert.equal(compute.network.gatewayClients, undefined);
  assert.equal(compute.resources.gateway.limits.cpu, "4");
  assert.equal(compute.resources.agent.limits.cpu, "4");
  assert.equal(compute.resources.gateway.requests.cpu, "100m");
  // An unquoted YAML quantity is a number; startup names the field it rejects.
  const unquotedPath = join(directory, "unquoted-cpu.yaml");
  await writeFile(
    unquotedPath,
    example
      .replace("<actual-proxy-source-cidr>", "192.0.2.10/32")
      .replace(/^( {10}limits:\n {12}cpu: )"4"$/m, (_, prefix: string) => `${prefix}4`),
  );
  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: unquotedPath },
    }),
    (error) => {
      assert.ok(error instanceof ConfigurationValidationError);
      assert.deepEqual(error.error.details, [
        {
          path: "/resources/gateway/limits/cpu",
          code: "INVALID_TYPE",
          message: "Configuration does not satisfy type.",
        },
      ]);
      return true;
    },
  );
  // Trusted Installation startup must reject a validly spelled request that
  // Kubernetes refuses against its smaller limit, before any cluster operation.
  const impossible = loadYaml(example.replace("<actual-proxy-source-cidr>", "192.0.2.10/32"));
  yamlMapping(
    impossible,
    "drivers",
    "compute",
    "configuration",
    "resources",
    "gateway",
    "requests",
  ).cpu = "5";
  const impossiblePath = join(directory, "request-over-limit.yaml");
  await writeFile(impossiblePath, JSON.stringify(impossible));
  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: impossiblePath },
    }),
    (error) => {
      assert.ok(error instanceof ConfigurationValidationError);
      const detail = error.error.details?.[0];
      assert.ok(detail, "Expected an invalid CPU range detail");
      assert.equal(detail.path, "/resources/gateway/requests/cpu");
      assert.equal(detail.code, "INVALID_RANGE");
      assert.ok(typeof detail.message === "string", "Expected the CPU range error message");
      assert.match(detail.message, /Gateway CPU request .* cannot exceed its limit/);
      return true;
    },
  );
  const values = loadYaml(await readFile(new URL("values.yaml", productionExamples), "utf8"));
  assert.equal(yamlMapping(values, "gatewayRouting").enabled, true);
  assert.equal(compute.gatewayRouting.gatewayName, "oce-agent-gateways");
  assert.equal(compute.gatewayRouting.gatewayNamespace, "openclaw-system");
  assert.equal(drivers.configurationDriver.id, "config-kubernetes");
  assert.equal(drivers.secretDriver.id, "secret-kubernetes");
  assert.equal(Object.hasOwn(drivers.installation.drivers, "service_account"), false);

  const bootstrapValues = yamlMapping(values, "bootstrap");
  assert.equal(yamlMapping(bootstrapValues, "credentials").secretName, "occ-bootstrap-credentials");
  assert.equal(Object.hasOwn(bootstrapValues, "password"), false);
  assert.equal(Object.hasOwn(bootstrapValues, "serviceKey"), false);
}

export async function checkInitializationHookNames(t: TestContext): Promise<void> {
  const names = new Set<string>();
  for (const release of [
    "oce",
    "a".repeat(48),
    "a".repeat(49),
    "a".repeat(53),
    "a".repeat(52) + "b",
  ]) {
    await t.test(`release ${release.length} characters, ending ${release.at(-1)}`, async () => {
      let installedName: string | undefined;
      for (const isUpgrade of [false, true]) {
        const objects = await renderObjects({}, { release, isUpgrade });
        const job = objects.find(({ kind }) => kind === "Job");
        assert.ok(job, "Expected an initialization Job");
        const spec = resourceSpec(job, jobTemplateLabelsSpec);
        // The real Helm hook must survive admission before migration/bootstrap can run.
        assert.ok(
          job.metadata.name.length <= 63,
          `Job name exceeds 63 characters: ${job.metadata.name}`,
        );
        assert.match(job.metadata.name, /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
        assert.ok(job.metadata.name.startsWith(release));
        assert.equal(job.metadata.labels?.["app.kubernetes.io/instance"], release);
        assert.equal(spec.template.metadata.labels["app.kubernetes.io/instance"], release);
        assert.equal(
          asRecord(asRecord(job.metadata)?.annotations)?.["helm.sh/hook"],
          "pre-install,pre-upgrade",
        );
        if (isUpgrade) {
          assert.equal(job.metadata.name, installedName);
        } else {
          installedName = job.metadata.name;
          assert.ok(!names.has(installedName), "Distinct releases must keep distinct hook names");
          names.add(installedName);
        }
        if (release.length <= 48) {
          assert.equal(job.metadata.name, `${release}-initialization`);
        }
      }
    });
  }
}

export async function checkRetiredBootstrapOutputs(): Promise<void> {
  // Earlier charts refused to render without bootstrap.password.claimName, so an existing
  // installation's own values still carry these keys when it upgrades.
  const retired = {
    "bootstrap.credentials.secretName": "",
    "bootstrap.password.claimName": "bootstrap-password",
    "bootstrap.serviceKey.fileName": "initial-admin-service-key.json",
  };
  const objects = await renderObjects(retired, { isUpgrade: true });
  const initializerPod = resourceSpec(
    objects.find(({ kind }) => kind === "Job"),
    jobVolumesSpec,
  ).template.spec;
  assert.ok(!initializerPod.volumes.some(({ persistentVolumeClaim }) => persistentVolumeClaim));
  // A fresh install still has to name the precreated credentials Secret.
  await assert.rejects(render(retired), (error: unknown) => {
    const stderr = asRecord(error)?.stderr;
    return (
      typeof stderr === "string" &&
      /bootstrap\.credentials\.secretName must reference a precreated Secret/.test(stderr)
    );
  });
}

export async function checkPackagedProductionChart(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "oce-chart-package-"));
  try {
    const release = yamlMapping(
      JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")),
    );
    assert.ok(typeof release.version === "string", "Expected the OCE package version");
    const archive = join(directory, `openclaw-enterprise-${release.version}.tgz`);
    await execute(helm, ["package", productionChartPath, "--destination", directory], {
      cwd: repository,
      env: goToolEnvironment(),
    });
    const { stdout: metadata } = await execute(helm, ["show", "chart", archive], {
      cwd: repository,
      env: goToolEnvironment(),
    });
    const chart = yamlMapping(loadYaml(metadata));
    assert.equal(chart.name, "openclaw-enterprise");
    assert.equal(chart.version, release.version);
    assert.equal(chart.appVersion, release.version);

    // A registry consumer receives the archive, so it must render the same resources as source.
    const source = await execute(helm, productionValuesTemplateArgs(productionChartPath), {
      cwd: repository,
      env: goToolEnvironment(),
      maxBuffer: 2_000_000,
    });
    const packaged = await execute(helm, productionValuesTemplateArgs(archive), {
      cwd: repository,
      env: goToolEnvironment(),
      maxBuffer: 2_000_000,
    });
    assert.equal(packaged.stdout, source.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function checkInstallationNameValues(): Promise<void> {
  const message =
    /installation\.name must follow the Name rule: 1 to 200 characters, with no leading or trailing whitespace and no control characters or line or paragraph separators/;
  for (const name of [
    "",
    " ",
    " name",
    "name ",
    "name\nmore",
    "a".repeat(201),
    "名".repeat(201),
    "\uFEFFname",
    "name\u00A0",
  ]) {
    await assert.rejects(
      render({ "installation.name": name }),
      (error: unknown) => {
        const failure = asRecord(error);
        return (
          typeof failure?.stderr === "string" &&
          Number.isInteger(failure.code) &&
          failure.code !== 0 &&
          message.test(failure.stderr)
        );
      },
      JSON.stringify(name),
    );
  }
  for (const name of [
    "openclaw-enterprise",
    "OpenClaw Local Development",
    "a".repeat(200),
    "名".repeat(200),
    "a\uFEFFb",
  ]) {
    const objects = await renderObjects({ "installation.name": name });
    const bootstrap = objects.find(
      ({ kind, metadata }) => kind === "Job" && metadata.name.endsWith("-initialization"),
    );
    const container = resourceSpec(bootstrap, podContainersSpec).template.spec.containers[0];
    assert.ok(Check(bootstrapContainer, container), "Expected the bootstrap container environment");
    assert.ok(
      container.env.some(
        ({ name: envName, value }) =>
          envName === "OCC_BOOTSTRAP_INSTALLATION_NAME" && value === name,
      ),
      JSON.stringify(name),
    );
  }
}

export async function checkImageSelectedMigration(t: TestContext): Promise<void> {
  const objects = await resources((await renderProductionChart()).stdout);
  const migration = migrationFrom(findResourceByComponent(objects, "Job", "initialization"));
  assert.equal(migration.args.at(-1), "--expect-empty");
  const invocation = migration.args.slice(0, -1);
  async function layout(
    entry: string,
    command: string | string[],
    source: string,
  ): Promise<string> {
    const directory = await temporaryDirectory(t, "occ-migration-layout-");
    await mkdir(join(directory, "scripts"));
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        type: "module",
        scripts: { "db:migrate:production": command },
      }),
    );
    // Each isolated layout contains only its own generation's executable.
    await writeFile(join(directory, entry), source);
    return directory;
  }

  // The first strict .mjs command supports --check. Newer commands also
  // support the first-install and separate-migration guards.
  for (const [extension, supported] of [
    ["mjs", ["--check"]],
    ["ts", ["--check", "--expect-empty", "--require-current"]],
  ] satisfies [string, string[]][]) {
    const entry = `scripts/migrate-production.${extension}`;
    const directory = await layout(
      entry,
      `NODE_ENV=production node ${entry}`,
      `const args = process.argv.slice(2);
       if (args.length > 1 || (args.length === 1 && !${JSON.stringify(supported)}.includes(args[0]))) {
         throw new Error("Unsupported migration argument.");
       }
       process.stdout.write(JSON.stringify({pid: process.pid, args}));`,
    );
    for (const args of [[], ...supported.map((option) => [option])]) {
      const processResult = execute(process.execPath, [...invocation, ...args], {
        cwd: directory,
      });
      assert.deepEqual(JSON.parse((await processResult).stdout), {
        pid: processResult.child.pid,
        args,
      });
    }
    await assert.rejects(
      execute(process.execPath, [...invocation, "--unsupported-mode"], { cwd: directory }),
      { code: 1, stdout: "", stderr: /Unsupported migration argument/ },
    );
  }

  // The oldest package ignores argv. The sentinel proves import itself is
  // refused for a guarded invocation, even if the executable would exit zero.
  const legacyEntry = "scripts/migrate-production.mjs";
  const unguarded =
    'import { writeFileSync } from "node:fs";\n' +
    'writeFileSync(new URL("../imported", import.meta.url), "entered");';
  const legacy = await layout(legacyEntry, `node ${legacyEntry}`, unguarded);
  const imported = join(legacy, "imported");
  for (const args of [
    ["--check"],
    ["--expect-empty"],
    ["--require-current"],
    ["--expect-installation", "ins_fixture"],
  ]) {
    await assert.rejects(execute(process.execPath, [...invocation, ...args], { cwd: legacy }), {
      code: 1,
      stdout: "",
      stderr: /does not declare support for production migration mode arguments/,
    });
    await assert.rejects(readFile(imported, "utf8"), { code: "ENOENT" });
  }
  // Omitting Node's separator must fail before a legacy apply can start.
  await assert.rejects(
    execute(process.execPath, [...invocation.slice(0, -1), "--check"], { cwd: legacy }),
    { code: 9, stdout: "" },
  );
  await assert.rejects(readFile(imported, "utf8"), { code: "ENOENT" });
  await execute(process.execPath, invocation, { cwd: legacy });
  assert.equal(await readFile(imported, "utf8"), "entered");

  // A JSON array cannot declare guarded support by coercing to a command string.
  const malformed = await layout(
    legacyEntry,
    [`NODE_ENV=production node ${legacyEntry}`],
    unguarded,
  );
  await assert.rejects(execute(process.execPath, [...invocation, "--check"], { cwd: malformed }), {
    code: 1,
    stdout: "",
    stderr: /does not declare a supported production migration command/,
  });
  await assert.rejects(lstat(join(malformed, "imported")), { code: "ENOENT" });
}

export async function checkStagedWorkerProbes(t: TestContext): Promise<void> {
  const directory = await temporaryDirectory(t, "occ-signin-chart-");
  const reviewed = { reviewedSource: "7e1ac6d88e3893c3d4e6444fb3b9b9776519a3fb" };
  const chartDirectory = await stageSigninChart({
    harnessRoot: repository,
    directory,
    plan: { fixture: "v3-to-v3", previous: reviewed, candidate: reviewed },
  });
  const liveness = ["node", "scripts/production-healthcheck.mjs", "worker"];
  const readiness = [...liveness, "ready"];

  // The OIDC upgrade re-renders the chart before the first controller image cut.
  for (const isUpgrade of [false, true]) {
    const current = await renderProductionChart({}, { isUpgrade });
    const staged = await renderProductionChart({}, { chartDirectory, isUpgrade });
    const expected = await resources(
      current.stdout.replaceAll(
        "scripts/production-healthcheck.ts",
        "scripts/production-healthcheck.mjs",
      ),
    );
    const rendered = await resources(staged.stdout);
    assert.deepEqual(rendered, expected);
    const job = findResourceByComponent(rendered, "Job", "initialization");
    const migration = migrationFrom(job);
    assert.deepEqual(migration.args, [
      ...selectedImageMigrationEntry,
      ...(isUpgrade ? [] : ["--expect-empty"]),
    ]);
    const worker = workerFrom(findResourceByComponent(rendered, "Deployment", "worker"));
    assert.deepEqual(worker.readinessProbe.exec.command, readiness);
    assert.deepEqual(worker.livenessProbe.exec.command, liveness);
    assert.deepEqual(worker.startupProbe.exec.command, liveness);
  }
}

export async function checkProductionImageWorkerProbes(t: TestContext): Promise<void> {
  const image = process.env.OCC_TEST_PRODUCTION_IMAGE;
  assert.ok(image, "Expected the selected production image");
  const docker = process.env.OCC_DOCKER_BIN ?? "docker";
  const directory = await temporaryDirectory(t, "occ-image-health-");
  const [inspectionCommand, ...inspectionArgs] = inspectWorkerProbe;
  assert.ok(inspectionCommand, "Expected the worker probe inspection entrypoint");
  const { stdout } = await execute(docker, [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--user",
    "1000:1000",
    "--entrypoint",
    inspectionCommand,
    image,
    ...inspectionArgs,
  ]);
  // The image built from this checkout must serve the unmodified release chart.
  assert.equal(stdout.trim(), "ts");
  const chartDirectory = await initialUpgradeChart(repository, directory, stdout.trim());
  const objects = await resources((await renderProductionChart({}, { chartDirectory })).stdout);
  const worker = workerFrom(findResourceByComponent(objects, "Deployment", "worker"));
  const environment = worker.env;
  const mounts = worker.volumeMounts;
  assert.ok(environment, "Expected the worker environment");
  assert.ok(mounts, "Expected the worker volume mounts");
  const marker = (key: string): string => {
    const value = environment.find(({ name }) => name === key)?.value;
    assert.ok(value, `Expected worker marker ${key}`);
    return value;
  };
  const readiness = marker("OCC_WORKER_READINESS_PATH");
  const liveness = marker("OCC_WORKER_LIVENESS_PATH");
  const mountPath = mounts.find(({ name }) => name === "worker-readiness")?.mountPath;
  assert.ok(mountPath, "Expected the worker readiness mount");
  const ready = join(directory, "ready");
  const alive = join(directory, "alive");
  await chmod(directory, 0o755);
  await writeFile(ready, "ready\n");
  await writeFile(alive, "alive\n");
  const probe = ([entrypoint, ...args]: readonly string[]) => {
    assert.ok(entrypoint, "Expected a chart-derived probe entrypoint");
    return execute(docker, [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--user",
      "1000:1000",
      "--mount",
      `type=bind,src=${directory},dst=${mountPath},readonly`,
      "-e",
      `OCC_WORKER_READINESS_PATH=${readiness}`,
      "-e",
      `OCC_WORKER_LIVENESS_PATH=${liveness}`,
      "--entrypoint",
      entrypoint,
      image,
      ...args,
    ]);
  };
  const readyCommand = worker.readinessProbe.exec.command;
  const liveCommand = worker.livenessProbe.exec.command;
  const startupCommand = worker.startupProbe.exec.command;
  for (const command of [readyCommand, liveCommand, startupCommand]) {
    assert.deepEqual(await probe(command), { stdout: "", stderr: "" });
  }

  // A database outage leaves loop progress fresh while readiness expires.
  const stale = new Date(Date.now() - 60_000);
  await utimes(ready, stale, stale);
  await assert.rejects(probe(readyCommand), {
    code: 1,
    stdout: "",
    stderr: "The worker has not reported a recent healthy database observation.\n",
  });
  await rm(ready);
  await assert.rejects(probe(readyCommand), {
    code: 1,
    stdout: "",
    stderr: `ENOENT: no such file or directory, stat '${readiness}'\n`,
  });
  assert.deepEqual(await probe(liveCommand), { stdout: "", stderr: "" });
}

export async function checkBootstrapKeyYamlScalars(): Promise<void> {
  for (const field of ["passwordKey", "serviceKeyKey"]) {
    for (const value of ["true", "2024"]) {
      await assert.rejects(
        render({ [`bootstrap.credentials.${field}`]: value }),
        /bootstrap credential key must be a string/,
      );
    }
  }
}
