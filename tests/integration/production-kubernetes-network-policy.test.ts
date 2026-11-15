import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import Type, { type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import {
  parseProductionChart,
  productionCollectorValues,
  renderExecutionChart,
} from "../helpers/production-chart.mjs";
import {
  gatewayRoutingValues,
  gatewaySandboxValues,
  protectedRepositoryValues,
  render,
  repositoryCredentialValues,
  stringNameMessage,
  tooling,
  type ChartRenderOptions,
  type ChartValues,
} from "../helpers/production-chart-network-fixture.ts";
import { findResource } from "../helpers/production-chart-resource.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const sandboxPeerValidationValues = {
  ...gatewayRoutingValues,
  "gatewayRouting.sandbox.enabled": "true",
  "gatewayRouting.sandbox.domain": "sandbox.example.test",
  "gatewayRouting.sandbox.tlsSecretName": "sandbox-tls",
};

const labelMap = Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]));
const labelSelector = Type.Object({
  matchLabels: Type.Optional(Type.Union([labelMap, Type.Null()])),
});
const policyPeer = Type.Object({
  ipBlock: Type.Optional(Type.Union([Type.Object({ cidr: Type.String() }), Type.Null()])),
  namespaceSelector: Type.Optional(Type.Union([labelSelector, Type.Null()])),
  podSelector: Type.Optional(Type.Union([labelSelector, Type.Null()])),
});
const policyRule = Type.Object({
  from: Type.Optional(Type.Array(policyPeer)),
  to: Type.Optional(Type.Array(policyPeer)),
  ports: Type.Optional(
    Type.Array(Type.Object({ port: Type.Union([Type.Number(), Type.String()]) })),
  ),
});
const policySpec = Type.Object({
  ingress: Type.Optional(Type.Array(policyRule)),
  egress: Type.Optional(Type.Array(policyRule)),
});
const gatewaySpec = Type.Object({
  listeners: Type.Array(
    Type.Object({
      name: Type.String(),
      port: Type.Number(),
      tls: Type.Optional(
        Type.Object({ certificateRefs: Type.Array(Type.Object({ name: Type.String() })) }),
      ),
    }),
  ),
});
const containerShape = Type.Object({
  name: Type.String(),
  env: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String(),
        value: Type.Optional(Type.String()),
        valueFrom: Type.Optional(Type.Unknown()),
      }),
    ),
  ),
  ports: Type.Optional(
    Type.Array(Type.Object({ name: Type.String(), containerPort: Type.Number() })),
  ),
});
const deploymentSpec = Type.Object({
  template: Type.Object({
    spec: Type.Object({
      containers: Type.Array(containerShape),
      initContainers: Type.Optional(Type.Array(containerShape)),
    }),
  }),
});
const serviceSpec = Type.Object({
  ports: Type.Array(Type.Object({ port: Type.Number() })),
});
const chartResources = Type.Array(
  Type.Object({
    kind: Type.String(),
    metadata: Type.Object({ name: Type.String() }),
    spec: Type.Optional(Type.Unknown()),
  }),
);
type ChartResource = Static<typeof chartResources>[number];

async function resources(stdout: string): Promise<ChartResource[]> {
  const decoded: unknown = await parseProductionChart(stdout);
  assert.ok(Check(chartResources, decoded), "Helm must render named Kubernetes resources");
  return decoded;
}

async function renderObjects(overrides: ChartValues = {}, options: ChartRenderOptions = {}) {
  return resources((await render(overrides, options)).stdout);
}

function spec<S extends TSchema>(resource: ChartResource | undefined, schema: S): Static<S> {
  assert.ok(resource, "Expected Helm to render the resource");
  assert.ok(
    Check(schema, resource.spec),
    `Unexpected spec in ${resource.kind}/${resource.metadata.name}`,
  );
  return resource.spec;
}

function isHelmError(error: unknown): error is { stderr: string; code?: unknown } {
  return (
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    typeof error.stderr === "string"
  );
}

function executionPeerLabels(policy: ChartResource | undefined, peer: number) {
  const labels = spec(policy, policySpec).egress?.[peer]?.to?.[0]?.podSelector?.matchLabels;
  assert.ok(labels !== undefined, `Expected execution NetworkPolicy pod labels at egress[${peer}]`);
  return labels;
}

function firstContainer(deployment: ChartResource | undefined) {
  const [container] = spec(deployment, deploymentSpec).template.spec.containers;
  assert.ok(container, "Expected the Deployment's first container");
  return container;
}

test("execution chart names reject YAML booleans and numbers", tooling, async () => {
  // Finding 2322: the execution chart rendered TLS Secret "2024", a DNS peer in Namespace
  // "true" and an EnvoyProxy in Namespace "true", so Harness Pods silently lost DNS.
  for (const [field, value] of [
    ["routing.hostname", "123"],
    ["routing.gatewayClassName", "1"],
    ["routing.gatewayName", "true"],
    ["routing.envoyNamespace", "true"],
    ["routing.tlsSecretName", "2024"],
    ["dns.namespace", "true"],
    ["dns.namespace", "false"],
  ]) {
    await assert.rejects(
      renderExecutionChart("--set", `${field}=${value}`),
      (error) => isHelmError(error) && error.stderr.includes(`${field} ${stringNameMessage}`),
      `${field}=${value}`,
    );
  }
  const objects = await resources(
    (
      await renderExecutionChart(
        "--set-string",
        "routing.tlsSecretName=2024",
        "--set-string",
        "dns.namespace=true",
      )
    ).stdout,
  );
  const gateway = spec(
    objects.find((item) => item.kind === "Gateway"),
    gatewaySpec,
  );
  assert.equal(gateway.listeners[0]?.tls?.certificateRefs[0]?.name, "2024");
  const policy = objects.find((item) => item.kind === "NetworkPolicy");
  assert.equal(
    spec(policy, policySpec).egress?.[0]?.to?.[0]?.namespaceSelector?.matchLabels?.[
      "kubernetes.io/metadata.name"
    ],
    "true",
  );
});

test("execution peer label maps reject non-string values before rendering", tooling, async () => {
  const renderExecution = (field: string, value: string, option = "--set-json") =>
    renderExecutionChart(option, `${field}=${value}`);
  const defaults = await resources((await renderExecutionChart()).stdout);
  const defaultPolicy = defaults.find(({ kind }) => kind === "NetworkPolicy");
  for (const [field, peer] of [
    ["dns.podLabels", 0],
    ["routing.envoyGatewayPodLabels", 2],
  ] as const) {
    for (const value of [
      "true",
      "31",
      "[]",
      '"text"',
      '{"probe":true}',
      '{"probe":31}',
      '{"probe":[]}',
      '{"probe":{}}',
    ]) {
      await assert.rejects(
        renderExecution(field, value),
        (error) => isHelmError(error) && error.stderr.includes(field),
      );
    }
    for (const value of [
      '{"probe":"true"}',
      '{"probe":"31"}',
      '{"probe":""}',
      '{"probe":null}',
      "{}",
      "null",
    ]) {
      const objects = await resources((await renderExecution(field, value)).stdout);
      const policy = objects.find(({ kind }) => kind === "NetworkPolicy");
      const labels = executionPeerLabels(policy, peer);
      const requested: unknown = JSON.parse(value);
      assert.ok(requested === null || Check(labelMap, requested));
      const defaultLabels = executionPeerLabels(defaultPolicy, peer);
      assert.deepEqual(labels, requested === null ? null : { ...defaultLabels, ...requested });
    }
    const quoted = await resources(
      (await renderExecution(`${field}.probe`, "true", "--set-string")).stdout,
    );
    const quotedPolicy = quoted.find(({ kind }) => kind === "NetworkPolicy");
    assert.deepEqual(executionPeerLabels(quotedPolicy, peer), {
      ...executionPeerLabels(defaultPolicy, peer),
      probe: "true",
    });
  }
});

test("database and Kubernetes API egress refuse an empty host list", tooling, async (t) => {
  // An empty list would render NetworkPolicies with no route to the database or API server.
  const directory = await temporaryDirectory(t, "oce-empty-cidrs-");
  for (const name of ["database", "cluster"]) {
    const valuesFile = join(directory, `${name}.yaml`);
    await writeFile(valuesFile, `${name}:\n  cidrs: []\n`);
    await assert.rejects(
      render({}, { valuesFiles: [valuesFile], omit: [`${name}.cidrs[0]`, `${name}.cidrs[1]`] }),
      new RegExp(`${name}\\.cidrs must contain at least one explicit IPv4 /32 host`),
      name,
    );
  }
});

test(
  "database routing refuses invalid ports before emitting NetworkPolicies",
  tooling,
  async (t) => {
    const directory = await temporaryDirectory(t, "oce-database-port-");
    const valuesFile = join(directory, "ports.yaml");
    for (const port of [5342.5, 65536, 0, -1, "05342", "postgresql", "9223372036854775808"]) {
      await writeFile(valuesFile, `database:\n  port: ${JSON.stringify(port)}\n`);
      await assert.rejects(
        render({}, { valuesFiles: [valuesFile] }),
        (error) =>
          isHelmError(error) && error.code !== 0 && error.stderr.includes("database.port must be"),
        JSON.stringify(port),
      );
    }
    for (const port of [1, 5433, 65535, "5433"]) {
      await writeFile(valuesFile, `database:\n  port: ${JSON.stringify(port)}\n`);
      const objects = await renderObjects({}, { valuesFiles: [valuesFile] });
      const databaseRules = objects
        .filter((object) => object.kind === "NetworkPolicy")
        .flatMap((object) => spec(object, policySpec).egress ?? [])
        .filter((rule) => rule.to?.some((peer) => peer.ipBlock?.cidr === "10.45.0.12/32"));
      assert.equal(databaseRules.length, 2, "bootstrap and controller database routing");
      for (const rule of databaseRules) {
        assert.deepEqual(rule.ports, [{ protocol: "TCP", port: Number(port) }]);
      }
    }
  },
);

test(
  "gateway routing refuses fractional YAML ports before emitting resources",
  tooling,
  async (t) => {
    const directory = await temporaryDirectory(t, "oce-routing-ports-");
    const valuesFile = join(directory, "ports.yaml");
    // Values files preserve numeric scalars; --set passes a fractional value as a string.
    for (const [key, value] of [
      ["tenantGatewayPort", 8080.5],
      ["envoyHttpsTargetPort", 10443.5],
      ["sandbox.listenerPort", 8443.5],
    ] as const) {
      const field = key.startsWith("sandbox.")
        ? `  sandbox:\n    listenerPort: ${value}\n`
        : `  ${key}: ${value}\n`;
      await writeFile(valuesFile, `gatewayRouting:\n${field}`);
      await assert.rejects(
        render(gatewaySandboxValues, { valuesFiles: [valuesFile] }),
        (error) =>
          isHelmError(error) && error.code !== 0 && error.stderr.includes(`gatewayRouting.${key}`),
        key,
      );
    }
    await writeFile(
      valuesFile,
      "gatewayRouting:\n  tenantGatewayPort: 8081\n  envoyHttpsTargetPort: 10444\n  sandbox:\n    listenerPort: 8444\n",
    );
    const rendered = await renderObjects(gatewaySandboxValues, { valuesFiles: [valuesFile] });
    const gateway = spec(
      rendered.find((item) => item.kind === "Gateway"),
      gatewaySpec,
    );
    assert.equal(gateway.listeners.find((item) => item.name === "sandbox")?.port, 8444);
    const policies = rendered.filter((item) => item.kind === "NetworkPolicy");
    for (const expected of [8081, 10444, 8444]) {
      assert.ok(
        policies.some((policy) => {
          const { ingress = [], egress = [] } = spec(policy, policySpec);
          return [...ingress, ...egress].some((rule) =>
            rule.ports?.some((port) => port.port === expected),
          );
        }),
        `NetworkPolicy port ${expected}`,
      );
    }
  },
);

test(
  "metrics chart requires exact scraper selectors and isolates the extra Pod ports",
  tooling,
  async () => {
    const defaults = await resources((await render()).stdout);
    for (const component of ["api", "worker"]) {
      const container = firstContainer(
        findResource(defaults, "Deployment", `openclaw-enterprise-${component}`),
      );
      assert.equal(
        container.env?.find(({ name }) => name === "OCC_METRICS_ENABLED")?.value,
        "true",
      );
      assert.ok(
        container.ports?.some(
          ({ name, containerPort }) => name === "metrics" && containerPort === 9464,
        ),
      );
    }
    assert.ok(
      !defaults.some(
        (item) => item.kind === "NetworkPolicy" && item.metadata.name.endsWith("-metrics"),
      ),
    );
    const disabled = await resources((await render({ "metrics.enabled": "false" })).stdout);
    for (const item of disabled.filter((item) => item.kind === "Deployment")) {
      assert.ok(!firstContainer(item).ports?.some(({ name }) => name === "metrics"));
    }
    // The broker shares the worker Pod; reserve its fixed listener only while both are enabled.
    for (const [overrides, metricsPort, brokerEnabled] of [
      [{ "metrics.port": "8443" }, "8443", false],
      [
        { ...repositoryCredentialValues, "metrics.enabled": "false", "metrics.port": "8443" },
        undefined,
        true,
      ],
      [repositoryCredentialValues, "9464", true],
    ] as const) {
      const accepted = await resources((await render(overrides)).stdout);
      const pod = spec(
        findResource(accepted, "Deployment", "openclaw-enterprise-worker"),
        deploymentSpec,
      ).template.spec;
      const worker = [...(pod.initContainers ?? []), ...pod.containers].find(
        ({ name }) => name === "worker",
      );
      assert.ok(worker?.env);
      assert.equal(worker.env.find(({ name }) => name === "OCC_METRICS_PORT")?.value, metricsPort);
      assert.equal(
        worker.ports?.find(({ name }) => name === "metrics")?.containerPort,
        metricsPort === undefined ? undefined : Number(metricsPort),
      );
      const broker = pod.containers.find(({ name }) => name === "repository-credentials");
      assert.equal(broker !== undefined, brokerEnabled);
      if (brokerEnabled) {
        assert.equal(
          broker?.ports?.find(({ name }) => name === "repository-tls")?.containerPort,
          8443,
        );
      }
    }
    await assert.rejects(
      render({ ...repositoryCredentialValues, "metrics.port": "8443" }),
      /metrics\.port.*repository/,
    );
    const scraperOverrides: ChartValues[] = [
      { "metrics.scraperNamespaceLabels.team": "monitoring" },
      { "metrics.scraperPodLabels.app": "prometheus" },
    ];
    for (const override of scraperOverrides) {
      await assert.rejects(render(override), /scraperNamespaceLabels/);
    }
    // The API and worker run as UID 1000 without capabilities: a port below 1024 cannot bind.
    for (const port of ["0", "010", "1023", "65536", "8080", "9.5"]) {
      await assert.rejects(render({ "metrics.port": port }), /metrics.port/);
    }
    const lowestPort = await resources((await render({ "metrics.port": "1024" })).stdout);
    for (const component of ["api", "worker"]) {
      const container = firstContainer(
        findResource(lowestPort, "Deployment", `openclaw-enterprise-${component}`),
      );
      assert.equal(container.env?.find((item) => item.name === "OCC_METRICS_PORT")?.value, "1024");
      assert.ok(
        container.ports?.some((port) => port.name === "metrics" && port.containerPort === 1024),
      );
    }
    const selected = {
      "metrics.enabled": "true",
      "metrics.scraperNamespaceLabels.kubernetes\\.io/metadata\\.name": "monitoring",
      "metrics.scraperPodLabels.app": "prometheus",
    };
    await assert.rejects(render({ ...selected, "metrics.port": "8080" }), /distinct/);
    const objects = await resources((await render(selected)).stdout);
    for (const component of ["api", "worker"]) {
      const deployment = findResource(objects, "Deployment", `openclaw-enterprise-${component}`);
      const container = firstContainer(deployment);
      assert.ok(
        container.ports?.some((port) => port.name === "metrics" && port.containerPort === 9464),
      );
      assert.deepEqual(container.env?.find((item) => item.name === "OCC_METRICS_HOST")?.valueFrom, {
        fieldRef: { fieldPath: "status.podIP" },
      });
      const policy = findResource(
        objects,
        "NetworkPolicy",
        `openclaw-enterprise-${component}-metrics`,
      );
      assert.deepEqual(spec(policy, policySpec).ingress, [
        {
          from: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "monitoring" } },
              podSelector: { matchLabels: { app: "prometheus" } },
            },
          ],
          ports: [{ protocol: "TCP", port: 9464 }],
        },
      ]);
    }
  },
);

test("the chart refuses an API port the server does not bind", tooling, async () => {
  // The API runs as UID 1000 without capabilities: a port below 1024 cannot bind.
  for (const port of ["0", "010", "80", "1023", "65536", "9.5"]) {
    await assert.rejects(render({ "api.port": port }), /api\.port must be an integer TCP port/);
  }
  // --set parses this as a float. --set-string keeps the digits, which used to pass Sprig int overflow.
  await assert.rejects(
    render({}, { strings: { "api.port": "99999999999999999999" } }),
    /api\.port must be an integer TCP port/,
  );
  const objects = await renderObjects({ "api.port": "8081" });
  const container = firstContainer(findResource(objects, "Deployment", "openclaw-enterprise-api"));
  assert.equal(container.env?.find((item) => item.name === "OCC_PORT")?.value, "8081");
  assert.ok(container.ports?.some((port) => port.name === "http" && port.containerPort === 8081));
  assert.equal(
    spec(findResource(objects, "Service", "openclaw-enterprise-api"), serviceSpec).ports[0]?.port,
    8081,
  );
  assert.equal(
    spec(findResource(objects, "NetworkPolicy", "openclaw-enterprise-api-ingress"), policySpec)
      .ingress?.[0]?.ports?.[0]?.port,
    8081,
  );
});

// Kubernetes validates NetworkPolicy peers only when Helm applies them, after earlier objects
// of the upgrade have changed, so the chart refuses a peer the API server would (finding 2336).
test("NetworkPolicy peers from values are refused before install", tooling, async (t) => {
  const sandbox = sandboxPeerValidationValues;
  const peer = "gatewayRouting.sandbox.ingressPeers[0]";
  const selectorPeer = {
    [`${peer}.namespaceSelector.matchLabels.team`]: "public",
    [`${peer}.podSelector.matchLabels.app`]: "edge",
  };
  const expression = (selector: string, fields: ChartValues) =>
    Object.fromEntries(
      Object.entries(fields).map(([field, value]) => [
        `${peer}.${selector}.matchExpressions[0].${field}`,
        value,
      ]),
    );
  // Match Helm's own message on stderr: the error message also holds the --set command line.
  const refuses = (values: ChartValues, message: string, options: ChartRenderOptions = {}) =>
    assert.rejects(
      render({ ...sandbox, ...values }, options),
      (error) => isHelmError(error) && error.stderr.includes(message),
      message,
    );
  type PeerRefusal = [values: ChartValues, message: string];
  const invalidPeers: PeerRefusal[] = [
    [
      { [`${peer}.ipBlock.cidr`]: "10.0.0.0/33" },
      `${peer}.ipBlock.cidr requires an IPv4 or IPv6 CIDR`,
    ],
    [
      { [`${peer}.ipBlock.cidr`]: "not-a-cidr" },
      `${peer}.ipBlock.cidr requires an IPv4 or IPv6 CIDR`,
    ],
    [
      { [`${peer}.ipBlock.cidr`]: "256.0.0.0/8" },
      `${peer}.ipBlock.cidr requires an IPv4 or IPv6 CIDR`,
    ],
    [{ [`${peer}.ipBlock.cidr`]: "::/129" }, `${peer}.ipBlock.cidr requires an IPv4 or IPv6 CIDR`],
    [
      { [`${peer}.ipBlock.cidr`]: "10.0.0.0/08" },
      `${peer}.ipBlock.cidr requires an IPv4 or IPv6 CIDR`,
    ],
    // Eight groups without ::, or fewer with exactly one ::.
    ...["1:2:3:4/64", "1:2:3:4::5:6:7:8/64", "1::2::3/64"].map((cidr): PeerRefusal => [
      { [`${peer}.ipBlock.cidr`]: cidr },
      `${peer}.ipBlock.cidr contains an invalid IPv6 address`,
    ]),
    [
      { [`${peer}.ipBlock.cidr`]: "10.0.0.0/8", [`${peer}.ipBlock.except`]: "10.1.0.0/16" },
      `${peer}.ipBlock.except must be a list of CIDRs`,
    ],
    [
      { [`${peer}.ipBlock.cidr`]: "10.0.0.0/8", [`${peer}.ipBlock.except[0]`]: "10.1.0.0" },
      `${peer}.ipBlock.except[0] requires an IPv4 or IPv6 CIDR`,
    ],
    // The API server requires each except to be a strict subset of cidr (finding 2344): the
    // same family, a longer prefix and inside the range, partial hex digits and IPv4 tails included.
    ...(
      [
        ["10.0.0.0/8", "192.168.0.0/16"],
        ["10.0.0.0/8", "10.0.0.0/8"],
        ["10.0.0.0/16", "10.0.0.0/8"],
        ["10.0.0.0/8", "2001:db8::/32"],
        ["2001:db8::/32", "10.0.0.0/8"],
        ["2001:db8::/32", "2001:db9::/48"],
        ["2001:db8::/31", "2001:dba::/48"],
        ["2001:db8::/32", "2001:db8::/32"],
        ["::ffff:10.0.0.0/104", "::ffff:11.0.0.0/112"],
        // A zero-length prefix still needs the same family; groups after "::" count.
        ["::/0", "10.0.0.0/8"],
        ["2001:db8::1:0:0/96", "2001:db8::2:0:0/112"],
      ] as const
    ).map(([cidr, except]): PeerRefusal => [
      { [`${peer}.ipBlock.cidr`]: cidr, [`${peer}.ipBlock.except[0]`]: except },
      `${peer}.ipBlock.except[0] must be a strict subset of ${peer}.ipBlock.cidr`,
    ]),
    [
      {
        [`${peer}.ipBlock.cidr`]: "10.0.0.0/8",
        [`${peer}.ipBlock.except[0]`]: "10.1.0.0/16",
        [`${peer}.ipBlock.except[1]`]: "11.0.0.0/16",
      },
      `${peer}.ipBlock.except[1] must be a strict subset of ${peer}.ipBlock.cidr`,
    ],
    [
      { [`${peer}.ipBlock.cidr`]: "10.0.0.0/8", [`${peer}.ipBlock.excepts[0]`]: "10.1.0.0/16" },
      `${peer}.ipBlock has unknown field excepts`,
    ],
    [
      { ...selectorPeer, [`${peer}.ipBlock.cidr`]: "10.0.0.0/8" },
      `${peer} must set either ipBlock or selectors, not both`,
    ],
    [
      { [`${peer}.podSelectors.matchLabels.app`]: "edge" },
      `${peer} has unknown field podSelectors`,
    ],
    [
      { [`${peer}.podSelector.matchExpression[0].key`]: "app" },
      `${peer}.podSelector has unknown field matchExpression`,
    ],
    [
      expression("namespaceSelector", { key: "team", operator: "Equals", "values[0]": "public" }),
      `${peer}.namespaceSelector.matchExpressions[0].operator must be In, NotIn, Exists or DoesNotExist`,
    ],
    [
      expression("podSelector", { key: "bad key!", operator: "Exists" }),
      `${peer}.podSelector.matchExpressions[0] contains an invalid Kubernetes label key`,
    ],
    [
      expression("podSelector", { key: "a".repeat(64), operator: "Exists" }),
      `${peer}.podSelector.matchExpressions[0] contains an invalid Kubernetes label key`,
    ],
    [
      { [`${peer}.podSelector.matchExpressions.key`]: "app" },
      `${peer}.podSelector.matchExpressions must be a list`,
    ],
    [
      expression("podSelector", { key: "app", operator: "Exists", value: "edge" }),
      `${peer}.podSelector.matchExpressions[0] has unknown field value`,
    ],
    [
      expression("podSelector", { key: "app", operator: "In" }),
      `${peer}.podSelector.matchExpressions[0].values must list label values for In and NotIn`,
    ],
    [
      expression("podSelector", { key: "app", operator: "In", "values[0]": "a".repeat(64) }),
      `${peer}.podSelector.matchExpressions[0].values contains an invalid Kubernetes label value`,
    ],
    [
      expression("podSelector", { key: "app", operator: "In", "values[0]": "bad value" }),
      `${peer}.podSelector.matchExpressions[0].values contains an invalid Kubernetes label value`,
    ],
    [
      expression("podSelector", { key: "app", operator: "In", "values[0]": "1" }),
      `${peer}.podSelector.matchExpressions[0].values must be strings`,
    ],
    [
      expression("podSelector", { key: "app", operator: "Exists", "values[0]": "edge" }),
      `${peer}.podSelector.matchExpressions[0].values must be empty for Exists and DoesNotExist`,
    ],
  ];
  for (const [values, message] of invalidPeers) {
    await refuses(values, message);
  }

  // Shapes --set cannot write: an empty peer, and null fields the API server reads as unset.
  const directory = await temporaryDirectory(t, "occ-peer-shapes-");
  const peersFile = async (name: string, ingressPeers: readonly Static<typeof policyPeer>[]) => {
    const path = join(directory, `${name}.json`);
    await writeFile(path, JSON.stringify({ gatewayRouting: { sandbox: { ingressPeers } } }));
    return path;
  };
  await refuses({}, `${peer} must set either ipBlock or selectors`, {
    valuesFiles: [await peersFile("empty", [{ ipBlock: null }])],
  });
  const policyPeers = async (values: ChartValues, options: ChartRenderOptions = {}) => {
    const objects = await resources((await render({ ...sandbox, ...values }, options)).stdout);
    const policy = objects.find(
      ({ kind, metadata }) =>
        kind === "NetworkPolicy" && metadata.name.endsWith("-envoy-dataplane"),
    );
    return spec(policy, policySpec).ingress?.[0]?.from;
  };
  const nullSibling = [
    { ipBlock: null, namespaceSelector: null, podSelector: { matchLabels: { app: "edge" } } },
  ];
  assert.deepEqual(
    await policyPeers({}, { valuesFiles: [await peersFile("null-sibling", nullSibling)] }),
    nullSibling,
  );

  // Control: each valid peer shape still renders as written.
  const acceptedPeers: [ChartValues, unknown][] = [
    [
      { [`${peer}.ipBlock.cidr`]: "0.0.0.0/0", [`${peer}.ipBlock.except[0]`]: "10.0.0.0/8" },
      [{ ipBlock: { cidr: "0.0.0.0/0", except: ["10.0.0.0/8"] } }],
    ],
    [{ [`${peer}.ipBlock.cidr`]: "::/0" }, [{ ipBlock: { cidr: "::/0" } }]],
    ...(
      [
        ["10.0.0.0/8", ["10.1.0.0/16", "10.255.255.255/32"]],
        ["10.1.2.3/8", ["10.200.0.0/16"]],
        ["2001:db8::/31", ["2001:db9:ffff::/48"]],
        ["2001:DB8::/32", ["2001:db8:1::/48"]],
        ["::/0", ["2001:db8::/32"]],
        ["::ffff:10.0.0.0/104", ["::ffff:10.1.0.0/112"]],
      ] as const
    ).map(([cidr, except]): [ChartValues, unknown] => [
      {
        [`${peer}.ipBlock.cidr`]: cidr,
        ...Object.fromEntries(
          except.map((value, index) => [`${peer}.ipBlock.except[${index}]`, value]),
        ),
      },
      [{ ipBlock: { cidr, except } }],
    ]),
    [
      { [`${peer}.ipBlock.cidr`]: "2001:db8:1:2:3:4:5:6/128" },
      [{ ipBlock: { cidr: "2001:db8:1:2:3:4:5:6/128" } }],
    ],
    [
      {
        ...expression("namespaceSelector", {
          key: "kubernetes.io/metadata.name",
          operator: "NotIn",
          "values[0]": "kube-system",
        }),
        ...expression("podSelector", { key: "app", operator: "Exists" }),
      },
      [
        {
          namespaceSelector: {
            matchExpressions: [
              { key: "kubernetes.io/metadata.name", operator: "NotIn", values: ["kube-system"] },
            ],
          },
          podSelector: { matchExpressions: [{ key: "app", operator: "Exists" }] },
        },
      ],
    ],
  ];
  for (const [values, expected] of acceptedPeers) {
    assert.deepEqual(await policyPeers(values), expected);
  }

  const git = {
    ...protectedRepositoryValues,
    "openshellGit.enabled": "true",
    "openshellGit.tlsSecretName": "openshell-git-tls",
    "openshellGit.issuerPublicKeyConfigMapName": "openshell-gateway-public",
    "openshellGit.clients[0].namespaceSelector.matchLabels.kubernetes\\.io/metadata\\.name":
      "openshell-system",
    "openshellGit.clients[0].podSelector.matchLabels.app": "openshell-supervisor",
  };
  const gitRefusals: PeerRefusal[] = [
    [
      { "openshellGit.clients[0].podSelector.matchLabels.app": "-bad-" },
      "openshellGit.clients[0].podSelector.matchLabels contains an invalid Kubernetes label value",
    ],
    [
      {
        "openshellGit.clients[0].namespaceSelector.matchLabels.kubernetes\\.io/metadata\\.name":
          "openshell system",
      },
      "openshellGit.clients[0].namespaceSelector.matchLabels contains an invalid Kubernetes label value",
    ],
  ];
  for (const [values, message] of gitRefusals) {
    await assert.rejects(
      render({ ...git, ...values }),
      (error) => isHelmError(error) && error.stderr.includes(message),
      message,
    );
  }
  await render(git);

  // egressAuthority.clients go through the same peer check: --set reads tier=1 as a number.
  const authority = {
    "egressAuthority.enabled": "true",
    "egressAuthority.tlsSecretName": "authority-server-tls",
    "egressAuthority.issuerSecretName": "gateway-jwt-keys",
    "egressAuthority.clients[0].namespaceSelector.matchLabels.kubernetes\\.io/metadata\\.name":
      "openshell-system",
    "egressAuthority.clients[0].podSelector.matchLabels.app": "openshell-gateway",
  };
  const authorityRefusals: PeerRefusal[] = [
    [
      { "egressAuthority.clients[0].podSelector.matchLabels.tier": "1" },
      "egressAuthority.clients[0].podSelector.matchLabels label values must be strings",
    ],
    [
      { "egressAuthority.clients[0].namespaceSelector.matchLabels.openshell": "true" },
      "egressAuthority.clients[0].namespaceSelector.matchLabels label values must be strings",
    ],
  ];
  for (const [values, message] of authorityRefusals) {
    await assert.rejects(
      render({ ...protectedRepositoryValues, ...authority, ...values }),
      (error) => isHelmError(error) && error.stderr.includes(message),
      message,
    );
  }
  await render({ ...protectedRepositoryValues, ...authority });
});

test("production peer matchLabels keep the native Kubernetes map contract", tooling, async (t) => {
  const scrapers = {
    "metrics.scraperNamespaceLabels.team": "observability",
    "metrics.scraperPodLabels.app": "prometheus",
  };
  const exporter = {
    ...productionCollectorValues,
    "logging.collector.exporter.cidr": "",
    "logging.collector.exporter.namespaceLabels.team": "logs",
    "logging.collector.exporter.podLabels.app": "loki",
  };
  const collectorScrapers = {
    ...productionCollectorValues,
    "logging.collector.metrics.scraperNamespaceLabels.team": "observability",
    "logging.collector.metrics.scraperPodLabels.app": "prometheus",
  };
  const sandbox = {
    ...sandboxPeerValidationValues,
    "gatewayRouting.sandbox.ingressPeers[0].namespaceSelector.matchLabels.team": "public",
    "gatewayRouting.sandbox.ingressPeers[0].podSelector.matchLabels.app": "edge",
  };
  const callers: [string, ChartValues][] = [
    ["api.clients[0].podLabels", {}],
    ["dns.podLabels", {}],
    ["gatewayRouting.envoyGatewayPodLabels", gatewayRoutingValues],
    ["metrics.scraperNamespaceLabels", scrapers],
    ["metrics.scraperPodLabels", scrapers],
    ["logging.collector.exporter.namespaceLabels", exporter],
    ["logging.collector.exporter.podLabels", exporter],
    ["logging.collector.metrics.scraperNamespaceLabels", collectorScrapers],
    ["logging.collector.metrics.scraperPodLabels", collectorScrapers],
    ["gatewayRouting.sandbox.ingressPeers[0].namespaceSelector.matchLabels", sandbox],
    ["gatewayRouting.sandbox.ingressPeers[0].podSelector.matchLabels", sandbox],
  ];
  for (const [field, configuration] of callers) {
    await assert.rejects(
      render({ ...configuration, [`${field}.probe`]: "true" }),
      (error) => isHelmError(error) && error.stderr.includes(field),
      `Must refuse the active caller's boolean label: ${field}`,
    );
    await render(configuration, { strings: { [`${field}.probe`]: "true" } });
  }
  for (const shape of ["true", "31", "{value}", "value"]) {
    await assert.rejects(
      render({ "api.clients[0].podLabels": shape }),
      /api\.clients\[0\]\.podLabels/,
    );
  }
  for (const value of ["false", "31", "{nested}", "kube/dns", "a".repeat(64)]) {
    await assert.rejects(
      render({ "api.clients[0].podLabels.probe": value }),
      /api\.clients\[0\]\.podLabels/,
    );
  }
  for (const key of ["Example.com/Name", "example.com/", "a/b/c", `${"a".repeat(254)}/Name`]) {
    await assert.rejects(
      render(
        {},
        { strings: { [`api.clients[0].podLabels.${key.replaceAll(".", "\\.")}`]: "value" } },
      ),
      /api\.clients\[0\]\.podLabels/,
    );
  }
  for (const [key, value] of [
    ["looksTrue", "true"],
    ["looksFalse", "false"],
    ["looksNumeric", "31"],
    ["looksExponent", "1e3"],
    ["looksNull", "null"],
    ["empty", ""],
    ["example.com/Name_1", ""],
    [`${"a".repeat(253)}/Name`, "x"],
    ["a".repeat(63), "b".repeat(63)],
  ] as const) {
    const objects = await renderObjects(
      {},
      { strings: { [`api.clients[0].podLabels.${key.replaceAll(".", "\\.")}`]: value } },
    );
    const policy = objects.find(
      ({ metadata }) => metadata.name === "openclaw-enterprise-api-ingress",
    );
    assert.equal(
      spec(policy, policySpec).ingress?.[0]?.from?.[0]?.podSelector?.matchLabels?.[key],
      value,
    );
  }
  await render({ "api.clients[0].podLabels.empty": "null" });
  await render({ "metrics.scraperNamespaceLabels": "false", "metrics.scraperPodLabels": "false" });
  const directory = await temporaryDirectory(t, "occ-peer-labels-");
  const path = join(directory, "values.json");
  for (const shape of [null, {}]) {
    await writeFile(
      path,
      JSON.stringify({
        gatewayRouting: {
          sandbox: {
            ingressPeers: [
              {
                namespaceSelector: { matchLabels: shape },
                podSelector: { matchLabels: { app: "edge" } },
              },
            ],
          },
        },
      }),
    );
    await render(sandboxPeerValidationValues, { valuesFiles: [path] });
  }
});
