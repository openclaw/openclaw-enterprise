import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createKubernetesComputeDriver,
  PLUGIN_RUNTIME_STATUS_PORT,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.mjs";

import {
  renderProductionChart,
  parseProductionChart as resources,
  productionValues as values,
  productionCollectorValues,
} from "../helpers/production-chart.mjs";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const { loadYaml } = controllerRequire("@kubernetes/client-node");
const productionExamples = new URL("../../deploy/examples/production/", import.meta.url);
const helm = process.env.OCC_HELM_BIN ?? "helm";
const chatgptValues = {
  "backend.chatgpt.enabled": "true",
  "backend.chatgpt.providerCidr": "198.51.100.25/32",
};
const slackProxyValues = {
  "slackProxy.enabled": "true",
};
const repositoryCredentialValues = {
  "repositoryCredentials.enabled": "true",
  "repositoryCredentials.image": `registry.example.invalid/repository-credentials@sha256:${"b".repeat(64)}`,
  "repositoryCredentials.backendId": "github-primary",
  "repositoryCredentials.registryConfigMapName": "repository-registry-v1",
  "repositoryCredentials.serviceConfigSecretName": "repository-config",
  "repositoryCredentials.appKeySecretName": "repository-app-key",
  "repositoryCredentials.tlsSecretName": "repository-tls",
  "repositoryCredentials.publicCaSecretName": "repository-public-ca",
  "repositoryCredentials.upstreamCidrs[0]": "198.51.100.0/24",
};
const gatewayRoutingValues = {
  "gatewayRouting.enabled": "true",
  "gatewayRouting.gatewayClassName": "private-envoy-gateway",
  "gatewayRouting.apiKeySecretName": "occ-gateway-api-key",
};
const externalGatewayRoutingValues = {
  ...gatewayRoutingValues,
  "gatewayRouting.hostname": "agents.example.internal",
  "gatewayRouting.issuerRef.name": "occ-private-issuer",
};
const agentNativeAdminValues = {
  ...gatewayRoutingValues,
  "agentNativeAdmin.enabled": "true",
  "agentNativeAdmin.domain": "agents.example.invalid",
  "agentNativeAdmin.sharedCookieDomain": "example.invalid",
};
// The sandbox listener's wildcard TLS Secret, on top of gateway routing.
const sandboxValues = {
  ...agentNativeAdminValues,
  "gatewayRouting.sandbox.enabled": "true",
  "gatewayRouting.sandbox.domain": "previews.example.test",
  "gatewayRouting.sandbox.tlsSecretName": "preview-wildcard",
  "gatewayRouting.sandbox.ingressPeers[0].namespaceSelector.matchLabels.kubernetes\\.io/metadata\\.name":
    "public-ingress",
};
const githubLoginValues = {
  "auth.github.enabled": "true",
  "auth.recoveryUserId": "Xk3u9pQ2rT7vW1yZ",
};
const githubEgressValues = {
  "auth.github.egressCidrs[0]": "140.82.112.0/20",
  "auth.github.egressCidrs[1]": "192.30.252.0/22",
};
const trustedProxyValues = {
  "api.trustedProxy.preset": "ingress-nginx",
  "api.trustedProxy.cidrs[0]": "10.42.0.0/16",
};
const databaseCaValues = {
  "database.caSecretName": "occ-rds-ca",
  "database.caKey": "ca.pem",
  "database.caMountPath": "/etc/openclaw/database-ca",
};
const controlPlaneSelectorValues = {
  "controlPlane.nodeSelector.oce-role": "control",
};

const render = (overrides = {}, options = {}) =>
  renderProductionChart(
    {
      "database.cidrs[1]": "10.45.0.13/32",
      "cluster.cidrs[1]": "10.43.0.2/32",
      ...overrides,
    },
    options,
  );

let tooling;
try {
  await execute(helm, ["version", "--short"], { cwd: repository });
  await execute("yq", ["--version"], { cwd: repository });
  tooling = { skip: false };
} catch {
  tooling = {
    skip: "Install Helm and yq, or set OCC_HELM_BIN, to verify the real rendered production chart.",
  };
}

test(
  "Helm DNS grants preserve configured peers and admit OpenShift backend ports",
  tooling,
  async () => {
    const dnsValues = {
      "dns.namespace": "openshift-dns",
      "dns.podLabels.k8s-app": "null",
      "dns.podLabels.dns\\.operator\\.openshift\\.io/daemonset-dns": "default",
    };
    const dnsArguments = Object.entries(dnsValues).flatMap(([key, value]) => [
      "--set",
      `${key}=${value}`,
    ]);
    // Render each shipped chart with a nondefault DNS peer; these checks do not prove CNI enforcement.
    const charts = [
      {
        objects: await resources(
          (
            await render({
              ...dnsValues,
              ...productionCollectorValues,
              ...slackProxyValues,
              ...gatewayRoutingValues,
            })
          ).stdout,
        ),
        policies: [
          "openclaw-enterprise-dependency-egress",
          "oce-bootstrap-isolation",
          "openclaw-enterprise-collector-egress",
          "openclaw-enterprise-slack-proxy",
          `oce-${routeNamespaceLabel("openclaw-system", "oce-agent-gateways")}-envoy-dataplane`,
        ],
      },
      {
        objects: await resources(
          (
            await execute(
              helm,
              [
                "template",
                "oce",
                "deploy/helm/openclaw-execution",
                "--set",
                "routing.hostname=agents.example.invalid",
                "--set",
                "routing.gatewayClassName=private-envoy-gateway",
                "--set",
                "routing.tlsSecretName=agents-tls",
                "--set",
                "routing.controlPlaneCidrs[0]=198.51.100.0/24",
                ...dnsArguments,
              ],
              { cwd: repository, maxBuffer: 2_000_000 },
            )
          ).stdout,
        ),
        policies: ["oce-harness-proxy"],
      },
      {
        objects: await resources(
          (
            await execute(
              helm,
              [
                "template",
                "demo",
                "deploy/helm/openclaw-observability-demo",
                "--set",
                "occ.namespace=openclaw-system",
                "--set",
                "occ.release=oce",
                "--set",
                "cluster.cidrs[0]=10.43.0.1/32",
                "--set",
                "grafana.adminSecretName=grafana-admin",
                ...dnsArguments,
              ],
              { cwd: repository, maxBuffer: 2_000_000 },
            )
          ).stdout,
        ),
        policies: ["demo-dns"],
      },
    ];
    for (const { objects, policies } of charts) {
      for (const name of policies) {
        const policy = objects.find(
          (object) => object.kind === "NetworkPolicy" && object.metadata.name === name,
        );
        assert.ok(policy, name);
        assert.deepEqual(
          policy.spec.egress[0],
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": "openshift-dns" },
                },
                podSelector: {
                  matchLabels: { "dns.operator.openshift.io/daemonset-dns": "default" },
                },
              },
            ],
            ports: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
              { protocol: "UDP", port: 5353 },
              { protocol: "TCP", port: 5353 },
            ],
          },
          name,
        );
      }
    }
  },
);

test("sandbox ingress uses a separate listener outside OCE cookie scope", tooling, async () => {
  const rendered = await resources((await render(sandboxValues)).stdout);
  const gateway = rendered.find((item) => item.kind === "Gateway");
  const listener = gateway.spec.listeners.find((item) => item.name === "sandbox");
  assert.equal(listener.hostname, "*.previews.example.test");
  assert.equal(listener.port, 8443);
  assert.equal(listener.tls.certificateRefs[0].name, "preview-wildcard");
  assert.equal(gateway.spec.listeners.find((item) => item.name === "https").port, 443);
  const policy = rendered.find(
    (item) => item.kind === "NetworkPolicy" && item.metadata.namespace === "envoy-gateway-system",
  );
  const publicRule = policy.spec.ingress.find((rule) =>
    rule.ports.some((port) => port.port === 8443),
  );
  assert.equal(
    publicRule.from[0].namespaceSelector.matchLabels["kubernetes.io/metadata.name"],
    "public-ingress",
  );
  assert.deepEqual(publicRule.ports, [{ protocol: "TCP", port: 8443 }]);
  for (const domain of ["example.invalid", "preview.example.invalid"]) {
    await assert.rejects(
      render({ ...sandboxValues, "gatewayRouting.sandbox.domain": domain }),
      /outside the OCE shared session cookie domain/,
    );
  }
  await assert.rejects(
    render({ ...sandboxValues, "gatewayRouting.sandbox.listenerPort": "10443" }),
    /distinct from private Envoy HTTPS/,
  );
  // Dedicated Agent hostnames are agent-<32 hex>.<domain>, so the domain stops at 253 - 39.
  const longestLabel = "a".repeat(63);
  const longestDomain = [longestLabel, longestLabel, "a".repeat(22), longestLabel].join(".");
  const overlongDomain = [longestLabel, longestLabel, "a".repeat(23), longestLabel].join(".");
  const hostnameLimitDomain = [longestLabel, longestLabel, longestLabel, "a".repeat(61)].join(".");
  assert.equal(longestDomain.length, 214);
  assert.equal(overlongDomain.length, 215);
  assert.equal(hostnameLimitDomain.length, 253);
  assert.equal(`agent-${"0".repeat(32)}.${longestDomain}`.length, 253);
  const longest = await resources(
    (await render({ ...sandboxValues, "gatewayRouting.sandbox.domain": longestDomain })).stdout,
  );
  assert.equal(
    longest
      .find((item) => item.kind === "Gateway")
      .spec.listeners.find((item) => item.name === "sandbox").hostname,
    `*.${longestDomain}`,
  );
  for (const domain of [
    "a..b.com",
    "example.com-",
    "example.-com",
    `${"a".repeat(64)}.test`,
    "localhost",
  ]) {
    await assert.rejects(
      render({ ...sandboxValues, "gatewayRouting.sandbox.domain": domain }),
      /must be a DNS hostname/,
    );
  }
  for (const domain of [overlongDomain, hostnameLimitDomain]) {
    await assert.rejects(
      render({ ...sandboxValues, "gatewayRouting.sandbox.domain": domain }),
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

test(
  "database routing refuses invalid ports before emitting NetworkPolicies",
  tooling,
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "oce-database-port-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const valuesFile = join(directory, "ports.yaml");
    for (const port of [5342.5, 65536, 0, -1, "05342", "postgresql", "9223372036854775808"]) {
      await writeFile(valuesFile, `database:\n  port: ${JSON.stringify(port)}\n`);
      await assert.rejects(
        render({}, { valuesFiles: [valuesFile] }),
        ({ code, stderr }) => code !== 0 && stderr.includes("database.port must be"),
        JSON.stringify(port),
      );
    }
    for (const port of [1, 5433, 65535, "5433"]) {
      await writeFile(valuesFile, `database:\n  port: ${JSON.stringify(port)}\n`);
      const objects = await resources((await render({}, { valuesFiles: [valuesFile] })).stdout);
      const databaseRules = objects
        .filter((object) => object.kind === "NetworkPolicy")
        .flatMap((object) => object.spec.egress ?? [])
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
    const directory = await mkdtemp(join(tmpdir(), "oce-routing-ports-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const valuesFile = join(directory, "ports.yaml");
    const routingValues = {
      ...gatewayRoutingValues,
      "gatewayRouting.sandbox.enabled": "true",
      "gatewayRouting.sandbox.domain": "previews.example.test",
      "gatewayRouting.sandbox.tlsSecretName": "preview-wildcard",
      "gatewayRouting.sandbox.ingressPeers[0].namespaceSelector.matchLabels.kubernetes\\.io/metadata\\.name":
        "public-ingress",
    };
    // Values files preserve numeric scalars; --set passes a fractional value as a string.
    for (const [key, value] of [
      ["tenantGatewayPort", 8080.5],
      ["envoyHttpsTargetPort", 10443.5],
      ["sandbox.listenerPort", 8443.5],
    ]) {
      const field = key.startsWith("sandbox.")
        ? `  sandbox:\n    listenerPort: ${value}\n`
        : `  ${key}: ${value}\n`;
      await writeFile(valuesFile, `gatewayRouting:\n${field}`);
      await assert.rejects(
        render(routingValues, { valuesFiles: [valuesFile] }),
        ({ code, stderr }) => code !== 0 && stderr.includes(`gatewayRouting.${key}`),
        key,
      );
    }
    await writeFile(
      valuesFile,
      "gatewayRouting:\n  tenantGatewayPort: 8081\n  envoyHttpsTargetPort: 10444\n  sandbox:\n    listenerPort: 8444\n",
    );
    const rendered = await resources(
      (await render(routingValues, { valuesFiles: [valuesFile] })).stdout,
    );
    assert.equal(
      rendered
        .find((item) => item.kind === "Gateway")
        .spec.listeners.find((item) => item.name === "sandbox").port,
      8444,
    );
    const policies = rendered.filter((item) => item.kind === "NetworkPolicy");
    for (const expected of [8081, 10444, 8444]) {
      assert.ok(
        policies.some((policy) =>
          [...(policy.spec.ingress ?? []), ...(policy.spec.egress ?? [])].some((rule) =>
            rule.ports?.some((port) => port.port === expected),
          ),
        ),
        `NetworkPolicy port ${expected}`,
      );
    }
  },
);

// Evaluate the selector-only, numeric-port ingress rules rendered by this chart.
// This checks additive policy semantics, not live CNI enforcement.
function matchesPolicySelector(selector = {}, labels = {}) {
  const expressions = (selector.matchExpressions ?? []).map(({ key, operator }) => {
    assert.equal(operator, "Exists", "Extend the evaluator for new selector operators");
    return Object.hasOwn(labels, key);
  });
  return (
    Object.entries(selector.matchLabels ?? {}).every(([key, value]) => labels[key] === value) &&
    expressions.every(Boolean)
  );
}

function chartAllowsIngress(objects, destination, source, port, protocol = "TCP") {
  const policies = objects.filter(
    (object) =>
      object.kind === "NetworkPolicy" &&
      object.spec.policyTypes.includes("Ingress") &&
      (object.metadata.namespace ?? "openclaw-system") === destination.namespace &&
      matchesPolicySelector(object.spec.podSelector, destination.labels),
  );
  return (
    policies.length === 0 ||
    policies.some((policy) =>
      (policy.spec.ingress ?? []).some(
        (rule) =>
          (!rule.ports?.length ||
            rule.ports.some(
              (entry) =>
                (entry.port === undefined || entry.port === port) &&
                (entry.protocol ?? "TCP") === protocol,
            )) &&
          (!rule.from?.length ||
            rule.from.some((peer) => {
              assert.equal(peer.ipBlock, undefined, "Only selector peers are supported");
              const namespaceMatches =
                peer.namespaceSelector === undefined
                  ? peer.podSelector === undefined || source.namespace === destination.namespace
                  : matchesPolicySelector(peer.namespaceSelector, source.namespaceLabels);
              return namespaceMatches && matchesPolicySelector(peer.podSelector, source.labels);
            })),
      ),
    )
  );
}

test(
  "the chart refuses tenant Gateway ports Compute refuses for the runtime status port",
  tooling,
  async () => {
    const sandboxValues = {
      ...gatewayRoutingValues,
      "gatewayRouting.sandbox.enabled": "true",
      "gatewayRouting.sandbox.domain": "previews.example.test",
      "gatewayRouting.sandbox.tlsSecretName": "preview-wildcard",
      "gatewayRouting.sandbox.ingressPeers[0].namespaceSelector.matchLabels.kubernetes\\.io/metadata\\.name":
        "public-ingress",
    };
    const compute = (gatewayPort, sandbox) => {
      const options = conformanceKubernetesOptions({
        gatewayTrustedProxyCidrs: ["10.0.0.0/8"],
        runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
      });
      // Routed Compute takes no direct gateway clients.
      const { gatewayClients, ...network } = options.network;
      return createKubernetesComputeDriver({
        ...options,
        network: { ...network, gatewayPort },
        gatewayRouting: {
          gatewayName: "oce-agent-gateways",
          gatewayNamespace: "openclaw-system",
          envoyNamespace: "envoy-gateway-system",
          ...(sandbox ? { sandbox: { domain: "previews.example.test" } } : {}),
        },
      });
    };
    // tenantGatewayPort must equal Compute's network.gatewayPort, so Helm refuses exactly
    // what controller startup refuses instead of installing a controller that cannot start.
    for (const [gatewayPort, sandbox, refused] of [
      [PLUGIN_RUNTIME_STATUS_PORT, false, true],
      [PLUGIN_RUNTIME_STATUS_PORT, true, true],
      [PLUGIN_RUNTIME_STATUS_PORT - 1, true, true],
      [PLUGIN_RUNTIME_STATUS_PORT - 1, false, false],
      [PLUGIN_RUNTIME_STATUS_PORT + 1, true, false],
      [8080, true, false],
    ]) {
      const row = JSON.stringify({ gatewayPort, sandbox });
      const chartValues = {
        ...(sandbox ? sandboxValues : gatewayRoutingValues),
        "gatewayRouting.tenantGatewayPort": String(gatewayPort),
      };
      if (refused) {
        assert.throws(() => compute(gatewayPort, sandbox), /reserved runtime status port/, row);
        await assert.rejects(
          render(chartValues),
          ({ code, stderr }) =>
            code !== 0 &&
            stderr.includes("gatewayRouting.tenantGatewayPort") &&
            stderr.includes(`reserved runtime status port ${PLUGIN_RUNTIME_STATUS_PORT}`),
          row,
        );
      } else {
        assert.doesNotThrow(() => compute(gatewayPort, sandbox), row);
        await render(chartValues);
      }
    }
  },
);

test(
  "two-cluster packaging separates remote API identities without optional services",
  tooling,
  async () => {
    const execution = {
      "executionCluster.enabled": "true",
      "executionCluster.apiKubeconfigSecretName": "execution-api",
      "executionCluster.workerKubeconfigSecretName": "execution-worker",
      "executionCluster.apiCidrs[0]": "10.44.0.2/32",
    };
    // This guard must apply even when the unrelated repository service is disabled.
    await assert.rejects(render({ "executionCluster.enabled": "true" }), /separate API and worker/);
    await assert.rejects(
      render({ ...execution, "executionCluster.workerKubeconfigSecretName": "execution-api" }),
      /separate API and worker/,
    );
    await assert.rejects(
      render({ ...execution, "executionCluster.apiKubeconfigSecretName": "occ-auth" }),
      /executionCluster\.apiKubeconfigSecretName must name a dedicated Secret; occ-auth is also auth\.secretName/,
    );
    // Optional credential Secrets count once enabled (findings 1046, 1048): the ChatGPT admin,
    // sign-in, database CA and sandbox TLS Secrets, and the Gateway Secrets cert-manager writes.
    const gatewayRoot = `occ-gateway-${createHash("sha256").update("openclaw-system/oce-agent-gateways").digest("hex").slice(0, 12)}-root`;
    for (const [values, secret, role] of [
      [chatgptValues, "occ-chatgpt-admin", "backend.chatgpt.secretName"],
      [githubLoginValues, "occ-github-login", "auth.github.secretName"],
      [gatewayRoutingValues, "oce-agent-gateways-tls", "gatewayRouting.tlsSecretName"],
      [gatewayRoutingValues, gatewayRoot, "the generated Gateway root CA"],
      [databaseCaValues, "occ-rds-ca", "database.caSecretName"],
      [sandboxValues, "preview-wildcard", "gatewayRouting.sandbox.tlsSecretName"],
    ]) {
      for (const key of ["apiKubeconfigSecretName", "workerKubeconfigSecretName"]) {
        await assert.rejects(
          render({ ...execution, ...values, [`executionCluster.${key}`]: secret }),
          ({ code, stderr }) =>
            code !== 0 &&
            stderr.includes(
              `executionCluster.${key} must name a dedicated Secret; ${secret} is also ${role}`,
            ),
          `${key} = ${secret}`,
        );
      }
      // Until that feature is enabled, its Secret name is free.
      await render({ ...execution, "executionCluster.apiKubeconfigSecretName": secret });
      await render({ ...execution, ...values });
    }
    const objects = await resources((await render(execution)).stdout);
    for (const component of ["api", "worker"]) {
      const pod = objects.find(
        (item) =>
          item.kind === "Deployment" && item.metadata.name === `openclaw-enterprise-${component}`,
      ).spec.template.spec;
      assert.equal(
        pod.volumes.find((volume) => volume.name === "execution-kubeconfig").secret.secretName,
        `execution-${component}`,
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
      const container = defaults.find(
        (item) =>
          item.kind === "Deployment" && item.metadata.name === `openclaw-enterprise-${component}`,
      ).spec.template.spec.containers[0];
      assert.equal(container.env.find(({ name }) => name === "OCC_METRICS_ENABLED")?.value, "true");
      assert.ok(
        container.ports.some(
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
      assert.ok(
        !item.spec.template.spec.containers[0].ports?.some(({ name }) => name === "metrics"),
      );
    }
    for (const override of [
      { "metrics.scraperNamespaceLabels.team": "monitoring" },
      { "metrics.scraperPodLabels.app": "prometheus" },
    ]) {
      await assert.rejects(render(override), /scraperNamespaceLabels/);
    }
    for (const port of ["0", "010", "65536", "8080", "9.5"]) {
      await assert.rejects(render({ "metrics.port": port }), /metrics.port/);
    }
    const shortPort = await resources((await render({ "metrics.port": "8" })).stdout);
    for (const component of ["api", "worker"]) {
      const container = shortPort.find(
        (item) =>
          item.kind === "Deployment" && item.metadata.name === `openclaw-enterprise-${component}`,
      ).spec.template.spec.containers[0];
      assert.equal(container.env.find((item) => item.name === "OCC_METRICS_PORT").value, "8");
      assert.ok(
        container.ports.some((port) => port.name === "metrics" && port.containerPort === 8),
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
      const deployment = objects.find(
        (item) =>
          item.kind === "Deployment" && item.metadata.name === `openclaw-enterprise-${component}`,
      );
      const container = deployment.spec.template.spec.containers[0];
      assert.ok(
        container.ports.some((port) => port.name === "metrics" && port.containerPort === 9464),
      );
      assert.deepEqual(container.env.find((item) => item.name === "OCC_METRICS_HOST").valueFrom, {
        fieldRef: { fieldPath: "status.podIP" },
      });
      const policy = objects.find(
        (item) =>
          item.kind === "NetworkPolicy" &&
          item.metadata.name === `openclaw-enterprise-${component}-metrics`,
      );
      assert.deepEqual(policy.spec.ingress, [
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
  for (const port of ["0", "010", "65536", "9.5"]) {
    await assert.rejects(render({ "api.port": port }), /api\.port must be an integer TCP port/);
  }
  const objects = await resources((await render({ "api.port": "8081" })).stdout);
  const container = objects.find(
    (item) => item.kind === "Deployment" && item.metadata.name === "openclaw-enterprise-api",
  ).spec.template.spec.containers[0];
  assert.equal(container.env.find((item) => item.name === "OCC_PORT").value, "8081");
  assert.ok(container.ports.some((port) => port.name === "http" && port.containerPort === 8081));
  assert.equal(
    objects.find(
      (item) => item.kind === "Service" && item.metadata.name === "openclaw-enterprise-api",
    ).spec.ports[0].port,
    8081,
  );
  assert.equal(
    objects.find(
      (item) =>
        item.kind === "NetworkPolicy" && item.metadata.name === "openclaw-enterprise-api-ingress",
    ).spec.ingress[0].ports[0].port,
    8081,
  );
});

function routeNamespaceLabel(namespace, gatewayName) {
  return createHash("sha256").update(`${namespace}/${gatewayName}`).digest("hex").slice(0, 12);
}

function envoyNetworkPolicyName(releaseName, namespace, gatewayName) {
  return `${releaseName.slice(0, 34).replace(/-$/, "")}-${routeNamespaceLabel(
    namespace,
    gatewayName,
  )}-envoy-dataplane`;
}

function gatewayServiceName(namespace, gatewayName) {
  return `occ-gateway-${routeNamespaceLabel(namespace, gatewayName)}`;
}

function defaultGatewayHostname(namespace, gatewayName, envoyNamespace = "envoy-gateway-system") {
  return `${gatewayServiceName(namespace, gatewayName)}.${envoyNamespace}.svc`;
}

function rootSecretName(namespace, gatewayName) {
  return `${gatewayServiceName(namespace, gatewayName)}-root`;
}

function tenantApiRules() {
  return [
    {
      apiGroups: [""],
      resources: ["secrets"],
      verbs: ["get", "create", "update", "patch", "delete"],
    },
    {
      apiGroups: ["apps"],
      resources: ["deployments"],
      verbs: ["list"],
    },
    {
      apiGroups: [""],
      resources: ["pods"],
      verbs: ["get", "list"],
    },
    {
      apiGroups: [""],
      resources: ["pods/proxy"],
      verbs: ["get"],
    },
    ...runtimeLogRules,
  ];
}

// Runtime log reads: added by agentRuntimeLogs.enabled (default true), never cluster-bound.
const runtimeLogRules = [
  { apiGroups: [""], resources: ["pods/log"], verbs: ["get"] },
  { apiGroups: [""], resources: ["events"], verbs: ["get", "list"] },
];

test("production native examples satisfy the current Helm, Installation, and PVC schemas", async (t) => {
  const { loadInstallationConfiguration } =
    await import("../../apps/controller/src/composition/installation-config.ts");
  // Operators must replace the trust placeholder with their observed proxy source.
  // A documentation-only address is never a runnable trust default.
  const directory = await mkdtemp(join(tmpdir(), "occ-production-example-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const example = await readFile(new URL("installation.yaml", productionExamples), "utf8");
  assert.match(example, /<actual-proxy-source-cidr>/);
  const installationPath = join(directory, "installation.yaml");
  await writeFile(installationPath, example.replace("<actual-proxy-source-cidr>", "192.0.2.10/32"));
  const drivers = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: installationPath },
  });
  assert.equal(drivers.installation.occ.cluster, "production-west");
  assert.deepEqual(drivers.installation.backend, []);
  assert.equal(drivers.installation.presets.includeDefaults, true);
  assert.deepEqual(drivers.defaultPresets.map(({ name }) => name).sort(), [
    "Standard Codex",
    "Standard OpenClaw",
    "default-codex",
  ]);
  assert.equal(drivers.pluginDriver.id, "codex-plugin");
  assert.equal(drivers.pluginDriver.discoveryCredential, "none");
  const catalog = await drivers.pluginDriver.discoverCatalog({ q: "Linear" });
  assert.ok(catalog.plugins.some(({ name }) => name === "Linear"));
  assert.equal(drivers.computeDriver.id, "compute-kubernetes");
  const compute = drivers.installation.drivers.compute.configuration;
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
      .replace(/^( {10}limits:\n {12}cpu: )"4"$/m, (_, prefix) => `${prefix}4`),
  );
  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: unquotedPath },
    }),
    /drivers\.compute\.configuration does not match its Driver configuration schema at \/resources\/gateway\/limits\/cpu: must be string/,
  );
  // Trusted Installation startup must reject a validly spelled request that
  // Kubernetes refuses against its smaller limit, before any cluster operation.
  const impossible = loadYaml(example.replace("<actual-proxy-source-cidr>", "192.0.2.10/32"));
  impossible.drivers.compute.configuration.resources.gateway.requests.cpu = "5";
  const impossiblePath = join(directory, "request-over-limit.yaml");
  await writeFile(impossiblePath, JSON.stringify(impossible));
  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: impossiblePath },
    }),
    /Gateway CPU request \(resources\.gateway\.requests\.cpu\) cannot exceed its limit/,
  );
  const values = loadYaml(await readFile(new URL("values.yaml", productionExamples), "utf8"));
  assert.equal(values.gatewayRouting.enabled, true);
  assert.equal(compute.gatewayRouting.gatewayName, "oce-agent-gateways");
  assert.equal(compute.gatewayRouting.gatewayNamespace, "openclaw-system");
  assert.equal(drivers.configurationDriver.id, "config-kubernetes");
  assert.equal(drivers.secretDriver.id, "secret-kubernetes");
  assert.equal(Object.hasOwn(drivers.installation.drivers, "service_account"), false);

  const bootstrapClaim = loadYaml(
    await readFile(new URL("bootstrap-pvc.yaml", productionExamples), "utf8"),
  );
  assert.equal(bootstrapClaim.kind, "PersistentVolumeClaim");
  assert.equal(bootstrapClaim.metadata.name, "occ-bootstrap-admin-password");
  assert.equal(bootstrapClaim.metadata.namespace, "openclaw-system");
  assert.deepEqual(bootstrapClaim.spec.accessModes, ["ReadWriteOnce"]);
  assert.equal(bootstrapClaim.spec.resources.requests.storage, "1Gi");
});

test(
  "production Helm custom Gateway hostname follows the loaded Compute contract",
  tooling,
  async (t) => {
    const { loadInstallationConfiguration } =
      await import("../../apps/controller/src/composition/installation-config.ts");
    const directory = await mkdtemp(join(tmpdir(), "occ-control-hostname-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const example = loadYaml(
      (await readFile(new URL("installation.yaml", productionExamples), "utf8")).replace(
        "<actual-proxy-source-cidr>",
        "192.0.2.10/32",
      ),
    );
    const installationPath = join(directory, "installation.yaml");
    const invalid = [
      "Bad_Host",
      "proxy.example.test:443",
      "https://proxy.example.test",
      "proxy..example.test",
      `${"a".repeat(64)}.test`,
      `${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(62)}`,
    ];
    const valid = [
      "proxy.example.test",
      `${"a".repeat(63)}.test`,
      `${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(61)}`,
      "",
      undefined,
    ];
    for (const hostname of [...invalid, ...valid]) {
      const configuration = structuredClone(example);
      if (hostname === undefined) {
        delete configuration.drivers.compute.configuration.gatewayRouting.hostname;
      } else {
        configuration.drivers.compute.configuration.gatewayRouting.hostname = hostname;
      }
      await writeFile(installationPath, JSON.stringify(configuration));
      const load = () =>
        loadInstallationConfiguration({
          mode: "production",
          environment: { OCC_CONFIG_PATH: installationPath },
        });
      const helmValues =
        hostname === undefined
          ? gatewayRoutingValues
          : { ...gatewayRoutingValues, "gatewayRouting.hostname": hostname };
      if (invalid.includes(hostname)) {
        await assert.rejects(
          load(),
          /Gateway routing hostname must be a DNS hostname without a port or path/,
        );
        await assert.rejects(
          render(helmValues),
          ({ stderr }) =>
            stderr.includes(
              "gatewayRouting.hostname must be a DNS hostname without a port or path",
            ),
          hostname,
        );
        continue;
      }
      const loaded = await load();
      const objects = await resources((await render(helmValues)).stdout);
      const gateway = objects.find((object) => object.kind === "Gateway");
      const envoy = objects.find((object) => object.kind === "EnvoyProxy");
      const certificate = objects.find(
        (object) => object.kind === "Certificate" && !object.spec.isCA,
      );
      const routing = loaded.installation.drivers.compute.configuration.gatewayRouting;
      const expected =
        hostname ||
        `${envoy.spec.provider.kubernetes.envoyService.name}.${routing.envoyNamespace}.svc`;
      assert.equal(
        gateway.spec.listeners.find((listener) => listener.name === "https").hostname,
        expected,
      );
      assert.deepEqual(certificate.spec.dnsNames, [expected]);
      assert.equal(routing.hostname, hostname);
    }
  },
);

test("Helm refuses a Gateway name Compute refuses", tooling, async () => {
  await assert.rejects(
    execute(
      helm,
      [
        "template",
        "oce",
        "deploy/helm/openclaw-enterprise",
        "--namespace",
        "openclaw-system",
        "--values",
        "deploy/examples/production/values.yaml",
        "--set",
        "gatewayRouting.gatewayName=Bad_Name",
      ],
      { cwd: repository },
    ),
    /gatewayRouting\.gatewayName must be a DNS-safe Kubernetes resource name/,
  );
  await assert.rejects(
    execute(
      helm,
      [
        "template",
        "oce",
        "deploy/helm/openclaw-enterprise",
        "--namespace",
        "openclaw-system",
        "--values",
        "deploy/examples/production/values.yaml",
        "--set-string",
        "gatewayRouting.gatewayName= oce-agent-gateways ",
      ],
      { cwd: repository },
    ),
    /gatewayRouting\.gatewayName must be a DNS-safe Kubernetes resource name/,
  );
  const sixtyFour = "a".repeat(64);
  await assert.rejects(
    execute(
      helm,
      [
        "template",
        "oce",
        "deploy/helm/openclaw-enterprise",
        "--namespace",
        "openclaw-system",
        "--values",
        "deploy/examples/production/values.yaml",
        "--set-string",
        `gatewayRouting.gatewayName=${sixtyFour}`,
      ],
      { cwd: repository },
    ),
    /gatewayRouting\.gatewayName must be a DNS-safe Kubernetes resource name/,
  );
  const sixtyThree = "a".repeat(63);
  const { stdout } = await execute(
    helm,
    [
      "template",
      "oce",
      "deploy/helm/openclaw-enterprise",
      "--namespace",
      "openclaw-system",
      "--values",
      "deploy/examples/production/values.yaml",
      "--set-string",
      `gatewayRouting.gatewayName=${sixtyThree}`,
    ],
    { cwd: repository, maxBuffer: 2_000_000 },
  );
  const gateway = (await resources(stdout)).find((object) => object.kind === "Gateway");
  assert.equal(gateway?.metadata.name, sixtyThree);
});

test(
  "the execution chart refuses a harness Gateway name or Envoy namespace Compute refuses",
  tooling,
  async () => {
    const template = (field, value) =>
      execute(
        helm,
        [
          "template",
          "oce",
          "deploy/helm/openclaw-execution",
          "--set",
          "routing.hostname=agents.example.invalid",
          "--set",
          "routing.gatewayClassName=private-envoy-gateway",
          "--set",
          "routing.tlsSecretName=agents-tls",
          "--set",
          "routing.controlPlaneCidrs[0]=198.51.100.0/24",
          "--set-string",
          `routing.${field}=${value}`,
        ],
        { cwd: repository, maxBuffer: 2_000_000 },
      );
    // Compute validateGatewayName: a DNS subdomain, at most 63 characters (a label value).
    for (const gatewayName of ["Bad_Name", "-gateways", "gateways-", "a..b", "a".repeat(64)]) {
      await assert.rejects(
        template("gatewayName", gatewayName),
        /routing\.gatewayName must be a DNS-safe Kubernetes resource name of at most 63 characters/,
        gatewayName,
      );
    }
    // Compute isKubernetesNamespaceName: a DNS label, at most 63 characters, no dots.
    for (const envoyNamespace of ["Envoy", "envoy.system", "-envoy", "envoy-", "a".repeat(64)]) {
      await assert.rejects(
        template("envoyNamespace", envoyNamespace),
        /routing\.envoyNamespace must be a Kubernetes namespace name \(a DNS label of at most 63 characters\)/,
        envoyNamespace,
      );
    }
    for (const gatewayName of ["gateways.example", "a".repeat(63)]) {
      const gateways = await resources((await template("gatewayName", gatewayName)).stdout);
      assert.equal(
        gateways.find((object) => object.kind === "Gateway")?.metadata.name,
        gatewayName,
      );
    }
    const envoyNamespace = "a".repeat(63);
    const envoy = await resources((await template("envoyNamespace", envoyNamespace)).stdout);
    assert.ok(envoy.some((object) => object.metadata?.namespace === envoyNamespace));
  },
);

test("production Helm values example renders the backendless default chart", tooling, async () => {
  const { stdout } = await execute(
    helm,
    [
      "template",
      "oce",
      "deploy/helm/openclaw-enterprise",
      "--namespace",
      "openclaw-system",
      "--values",
      "deploy/examples/production/values.yaml",
    ],
    { cwd: repository, maxBuffer: 2_000_000 },
  );
  const objects = await resources(stdout);
  const selected = (kind, component) =>
    objects.find(
      (object) =>
        object.kind === kind &&
        object.metadata.labels?.["app.kubernetes.io/component"] === component,
    );
  assert.ok(
    objects.some(
      ({ kind, metadata }) =>
        kind === "Job" && metadata.labels?.["app.kubernetes.io/component"] === "initialization",
    ),
  );
  const initialization = selected("Job", "initialization");
  assert.deepEqual(initialization.spec.template.spec.nodeSelector, { "oce-role": "control" });
  for (const component of ["api", "worker"]) {
    assert.deepEqual(selected("Deployment", component).spec.template.spec.nodeSelector, {
      "oce-role": "control",
    });
  }
  assert.deepEqual(selected("Deployment", "worker").spec.strategy, {
    type: "RollingUpdate",
    rollingUpdate: { maxSurge: "25%", maxUnavailable: "25%" },
  });
  // Session admission and sign-in limits are process-local: never overlap two API Pods.
  assert.deepEqual(selected("Deployment", "api").spec.strategy, { type: "Recreate" });
  for (const component of ["api", "worker"]) {
    const env = selected("Deployment", component).spec.template.spec.containers[0].env;
    assert.ok(!env.some(({ name }) => /^OCC_AUTH_(GITHUB|GOOGLE)_/.test(name)));
  }
  assert.ok(
    !objects.some(({ metadata }) => /-api-(github|google)-login-egress$/.test(metadata.name)),
  );
  assert.ok(
    initialization.spec.template.spec.volumes.some(
      ({ name, secret }) => name === "database-ca" && secret?.secretName === "occ-rds-ca",
    ),
  );
  assert.equal(objects.filter(({ kind }) => kind === "Secret").length, 0);
  assert.ok(!objects.some(({ metadata }) => metadata.name.endsWith("-api-chatgpt-egress")));
});

test(
  "initialization hooks fit Kubernetes Job names for valid Helm release names",
  tooling,
  async (t) => {
    const names = new Set();
    for (const release of [
      "oce",
      "a".repeat(48),
      "a".repeat(49),
      "a".repeat(53),
      "a".repeat(52) + "b",
    ]) {
      await t.test(`release ${release.length} characters, ending ${release.at(-1)}`, async () => {
        let installedName;
        for (const isUpgrade of [false, true]) {
          const objects = await resources((await render({}, { release, isUpgrade })).stdout);
          const job = objects.find(({ kind }) => kind === "Job");
          // The real Helm hook must survive admission before migration/bootstrap can run.
          assert.ok(
            job.metadata.name.length <= 63,
            `Job name exceeds 63 characters: ${job.metadata.name}`,
          );
          assert.match(job.metadata.name, /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
          assert.ok(job.metadata.name.startsWith(release));
          assert.equal(job.metadata.labels["app.kubernetes.io/instance"], release);
          assert.equal(job.spec.template.metadata.labels["app.kubernetes.io/instance"], release);
          assert.equal(job.metadata.annotations["helm.sh/hook"], "pre-install,pre-upgrade");
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
  },
);

test("production settings coexist in fresh and upgrade chart renders", tooling, async () => {
  const settings = {
    ...agentNativeAdminValues,
    ...repositoryCredentialValues,
    "repositoryCredentials.serviceName": "git",
    "api.channelDirectoryProxyUrl": "http://198.51.100.25:3128",
  };
  // An image upgrade must still render the operator's broker, routing and proxy
  // settings together; testing each feature separately would miss conflicts.
  for (const isUpgrade of [false, true]) {
    const controllerImage = isUpgrade
      ? `registry.example.invalid/controller@sha256:${"c".repeat(64)}`
      : values["images.controller"];
    const objects = await resources(
      (await render({ ...settings, "images.controller": controllerImage }, { isUpgrade })).stdout,
    );
    const deployment = (component) =>
      objects.find(
        ({ kind, metadata }) =>
          kind === "Deployment" && metadata.labels["app.kubernetes.io/component"] === component,
      );
    const api = deployment("api").spec.template.spec.containers[0];
    assert.equal(api.image, controllerImage);
    assert.deepEqual(
      api.env.find(({ name }) => name === "OCC_CHANNEL_DIRECTORY_PROXY_URL"),
      { name: "OCC_CHANNEL_DIRECTORY_PROXY_URL", value: "http://198.51.100.25:3128" },
    );
    assert.deepEqual(
      api.env.find(({ name }) => name === "OCC_AGENT_NATIVE_ADMIN_ENABLED"),
      { name: "OCC_AGENT_NATIVE_ADMIN_ENABLED", value: "true" },
    );
    const broker = deployment("worker").spec.template.spec.containers.find(
      ({ name }) => name === "repository-credentials",
    );
    assert.deepEqual(broker.args, [
      "--public-origin",
      "https://git.openclaw-system.svc.cluster.local",
      "--backend-id",
      "github-primary",
    ]);
    const proxyPolicy = objects.find(
      ({ kind, metadata }) =>
        kind === "NetworkPolicy" &&
        metadata.name === "openclaw-enterprise-api-channel-directory-egress",
    );
    assert.deepEqual(proxyPolicy.spec.egress, [
      {
        to: [{ ipBlock: { cidr: "198.51.100.25/32" } }],
        ports: [{ protocol: "TCP", port: 3128 }],
      },
    ]);
    assert.ok(objects.some(({ kind }) => kind === "Gateway"));
    assert.ok(objects.some(({ kind }) => kind === "EnvoyProxy"));
    assert.ok(objects.some(({ kind, metadata }) => kind === "Service" && metadata.name === "git"));
  }
});

test(
  "packaged production chart keeps the OCE version and rendered resources",
  tooling,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "oce-chart-package-"));
    try {
      const release = JSON.parse(
        await readFile(new URL("../../package.json", import.meta.url), "utf8"),
      );
      const archive = join(directory, `openclaw-enterprise-${release.version}.tgz`);
      await execute(
        helm,
        ["package", "deploy/helm/openclaw-enterprise", "--destination", directory],
        {
          cwd: repository,
        },
      );
      const { stdout: metadata } = await execute(helm, ["show", "chart", archive], {
        cwd: repository,
      });
      const chart = loadYaml(metadata);
      assert.equal(chart.name, "openclaw-enterprise");
      assert.equal(chart.version, release.version);
      assert.equal(chart.appVersion, release.version);

      // A registry consumer receives the archive, so it must render the same resources as source.
      const args = [
        "--namespace",
        "openclaw-system",
        "--values",
        "deploy/examples/production/values.yaml",
      ];
      const source = await execute(
        helm,
        ["template", "oce", "deploy/helm/openclaw-enterprise", ...args],
        { cwd: repository, maxBuffer: 2_000_000 },
      );
      const packaged = await execute(helm, ["template", "oce", archive, ...args], {
        cwd: repository,
        maxBuffer: 2_000_000,
      });
      assert.equal(packaged.stdout, source.stdout);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("control-plane node selectors are optional unless configured", tooling, async () => {
  const { stdout } = await render();
  const objects = await resources(stdout);
  const selected = (kind, component) =>
    objects.find(
      (object) =>
        object.kind === kind &&
        object.metadata.labels?.["app.kubernetes.io/component"] === component,
    );

  assert.equal(selected("Job", "initialization").spec.template.spec.nodeSelector, undefined);
  for (const component of ["api", "worker"]) {
    assert.equal(selected("Deployment", component).spec.template.spec.nodeSelector, undefined);
  }
});

test("Installation checksum rolls both control-plane Deployments", tooling, async () => {
  const checksum = "c".repeat(64);
  const objects = await resources(
    (await render({ "controlPlane.installationChecksum": checksum })).stdout,
  );
  const deployments = objects.filter(({ kind }) => kind === "Deployment");
  assert.equal(deployments.length, 2);
  for (const deployment of deployments) {
    assert.equal(
      deployment.spec.template.metadata.annotations["openclaw.dev/installation-checksum"],
      checksum,
    );
  }
  await assert.rejects(
    render({ "controlPlane.installationChecksum": "not-a-checksum" }),
    /must be an empty string or a lowercase SHA-256 digest/,
  );
});

test(
  "Agent native admin pilot renders public host settings with private gateway routing",
  tooling,
  async () => {
    const { stdout } = await render(agentNativeAdminValues);
    const objects = await resources(stdout);
    const deployment = (component) =>
      objects.find(
        ({ kind, metadata }) =>
          kind === "Deployment" && metadata.labels["app.kubernetes.io/component"] === component,
      );

    const apiEnvironment = deployment("api").spec.template.spec.containers[0].env;
    const workerEnvironment = deployment("worker").spec.template.spec.containers[0].env;
    assert.deepEqual(
      apiEnvironment.filter(({ name }) => name.startsWith("OCC_AGENT_NATIVE_ADMIN_")),
      [
        { name: "OCC_AGENT_NATIVE_ADMIN_ENABLED", value: "true" },
        { name: "OCC_AGENT_NATIVE_ADMIN_DOMAIN", value: "agents.example.invalid" },
      ],
    );
    assert.deepEqual(
      apiEnvironment.filter(({ name }) => name === "OCC_AUTH_COOKIE_DOMAIN"),
      [{ name: "OCC_AUTH_COOKIE_DOMAIN", value: "example.invalid" }],
    );
    assert.ok(!workerEnvironment.some(({ name }) => name.startsWith("OCC_AGENT_NATIVE_ADMIN_")));
    assert.ok(!workerEnvironment.some(({ name }) => name === "OCC_AUTH_COOKIE_DOMAIN"));
    assert.ok(apiEnvironment.some(({ name }) => name === "OCC_GATEWAY_API_KEY_PATH"));
    assert.ok(objects.some(({ kind }) => kind === "Gateway"));
    assert.ok(objects.some(({ kind }) => kind === "EnvoyProxy"));

    const disabledObjects = await resources((await render()).stdout);
    const disabledDeployment = (component) =>
      disabledObjects.find(
        ({ kind, metadata }) =>
          kind === "Deployment" && metadata.labels["app.kubernetes.io/component"] === component,
      );
    const disabledApiEnvironment = disabledDeployment("api").spec.template.spec.containers[0].env;
    assert.deepEqual(
      disabledApiEnvironment.filter(({ name }) => name.startsWith("OCC_AGENT_NATIVE_ADMIN_")),
      [{ name: "OCC_AGENT_NATIVE_ADMIN_ENABLED", value: "false" }],
    );
    assert.ok(!disabledApiEnvironment.some(({ name }) => name === "OCC_AUTH_COOKIE_DOMAIN"));
  },
);

test(
  "Agent runtime log reads add read-only log and Event grants only when enabled",
  tooling,
  async () => {
    const role = (objects, suffix) =>
      objects.find(
        ({ kind, metadata }) => kind === "ClusterRole" && metadata.name.endsWith(suffix),
      );
    const apiEnvironment = (objects) =>
      objects.find(
        ({ kind, metadata }) =>
          kind === "Deployment" && metadata.labels["app.kubernetes.io/component"] === "api",
      ).spec.template.spec.containers[0].env;
    const hasLogRules = (rules) =>
      rules.some(({ resources = [] }) => resources.includes("pods/log")) ||
      rules.some(({ resources = [] }) => resources.includes("events"));

    const enabled = await resources((await render()).stdout);
    assert.deepEqual(
      apiEnvironment(enabled).filter(({ name }) => name === "OCC_AGENT_RUNTIME_LOGS_ENABLED"),
      [{ name: "OCC_AGENT_RUNTIME_LOGS_ENABLED", value: "true" }],
    );
    for (const suffix of ["-openclaw-tenant-api", "-openclaw-gateway-observer"]) {
      assert.deepEqual(
        role(enabled, suffix).rules.filter(({ resources = [] }) =>
          resources.some((resource) => ["pods/log", "events"].includes(resource)),
        ),
        runtimeLogRules,
        suffix,
      );
    }
    // Worker and Collector identities never gain log or Event reads.
    for (const object of enabled.filter(
      ({ kind, metadata }) =>
        ["ClusterRole", "Role"].includes(kind) &&
        !metadata.name.endsWith("-openclaw-tenant-api") &&
        !metadata.name.endsWith("-openclaw-gateway-observer"),
    )) {
      assert.equal(hasLogRules(object.rules ?? []), false, object.metadata.name);
    }

    const disabled = await resources(
      (await render({ "agentRuntimeLogs.enabled": "false" })).stdout,
    );
    assert.deepEqual(
      apiEnvironment(disabled).filter(({ name }) => name === "OCC_AGENT_RUNTIME_LOGS_ENABLED"),
      [{ name: "OCC_AGENT_RUNTIME_LOGS_ENABLED", value: "false" }],
    );
    for (const suffix of ["-openclaw-tenant-api", "-openclaw-gateway-observer"]) {
      assert.equal(hasLogRules(role(disabled, suffix).rules), false, suffix);
    }

    // The execution chart grants its tenant API role the observer's Pod and proxy reads
    // (runtime diagnostics) and the same log reads.
    const executionArgs = [
      "template",
      "oce",
      "deploy/helm/openclaw-execution",
      "--set",
      "routing.hostname=agents.example.invalid",
      "--set",
      "routing.gatewayClassName=private-envoy-gateway",
      "--set",
      "routing.tlsSecretName=agents-tls",
      "--set",
      "routing.controlPlaneCidrs[0]=198.51.100.0/24",
    ];
    const execution = await resources(
      (await execute(helm, executionArgs, { cwd: repository, maxBuffer: 2_000_000 })).stdout,
    );
    const executionPodReads = [
      { apiGroups: ["apps"], resources: ["deployments"], verbs: ["list"] },
      { apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] },
      { apiGroups: [""], resources: ["pods/proxy"], verbs: ["get"] },
    ];
    assert.deepEqual(role(execution, "-execution-tenant-api").rules, [
      ...executionPodReads,
      ...runtimeLogRules,
    ]);
    assert.equal(hasLogRules(role(execution, "-execution-tenant-worker").rules), false);
    const executionDisabled = await resources(
      (
        await execute(helm, [...executionArgs, "--set", "agentRuntimeLogs.enabled=false"], {
          cwd: repository,
          maxBuffer: 2_000_000,
        })
      ).stdout,
    );
    assert.deepEqual(role(executionDisabled, "-execution-tenant-api").rules, executionPodReads);
  },
);

test(
  "repository credential Helm packaging keeps private inputs in its service",
  tooling,
  async () => {
    const { stdout } = await render(repositoryCredentialValues);
    const objects = await resources(stdout);
    const named = (kind, name) =>
      objects.find((object) => object.kind === kind && object.metadata.name === name);
    const api = named("Deployment", "openclaw-enterprise-api");
    const worker = named("Deployment", "openclaw-enterprise-worker");
    const workerPod = worker.spec.template.spec;
    const controller = workerPod.initContainers.find(({ name }) => name === "worker");
    const service = workerPod.containers.find(({ name }) => name === "repository-credentials");
    const mounts = (container) => container.volumeMounts.map(({ name }) => name);

    // The controller image aliases /var/run to /run; parent mounts can hide the shared socket.
    const workerMounts = controller.volumeMounts.map(({ name, mountPath }) => ({
      name,
      path: mountPath.replace(/^\/var\/run(?=\/|$)/, "/run").replace(/\/$/, ""),
    }));
    for (let index = 0; index < workerMounts.length; index += 1) {
      const current = workerMounts[index];
      for (const other of workerMounts.slice(index + 1)) {
        assert.ok(
          current.path !== other.path &&
            !current.path.startsWith(`${other.path}/`) &&
            !other.path.startsWith(`${current.path}/`),
          `worker mounts ${current.name} and ${other.name} overlap after /var/run resolution`,
        );
      }
    }
    const readinessMount = controller.volumeMounts.find(({ name }) => name === "worker-readiness");
    assert.equal(readinessMount.readOnly, undefined);
    assert.equal(
      controller.env.find(({ name }) => name === "OCC_WORKER_READINESS_PATH").value,
      `${readinessMount.mountPath}/ready`,
    );

    // Kubernetes rejects named container ports longer than 15 characters during admission.
    for (const object of objects) {
      const pod = object.spec?.template?.spec;
      for (const container of [...(pod?.initContainers ?? []), ...(pod?.containers ?? [])]) {
        for (const port of container.ports ?? []) {
          if (port.name !== undefined) {
            assert.ok(
              port.name.length <= 15,
              `${object.metadata.name}/${container.name} port name exceeds 15 characters`,
            );
          }
        }
      }
    }

    // The only Kubernetes token in the shared Pod is explicitly mounted by the trusted worker.
    assert.equal(worker.spec.replicas, 1);
    assert.deepEqual(worker.spec.strategy, { type: "Recreate" });
    assert.equal(workerPod.automountServiceAccountToken, false);
    assert.equal(workerPod.terminationGracePeriodSeconds, 75);
    assert.equal(workerPod.securityContext.runAsUser, 1000);
    assert.equal(workerPod.securityContext.runAsGroup, 1000);
    assert.equal(workerPod.securityContext.fsGroup, 1000);
    // Native sidecar termination follows broker termination, keeping receipt writes available.
    assert.equal(controller.restartPolicy, "Always");
    assert.deepEqual(
      workerPod.initContainers.map(({ name }) => name),
      ["worker"],
    );
    const apiAccess = workerPod.volumes.find(({ name }) => name === "worker-api-access");
    assert.equal(apiAccess.projected.defaultMode, 0o440);
    assert.deepEqual(apiAccess.projected.sources, [
      { serviceAccountToken: { path: "token", expirationSeconds: 3600 } },
      { configMap: { name: "kube-root-ca.crt", items: [{ key: "ca.crt", path: "ca.crt" }] } },
      {
        downwardAPI: {
          items: [
            { path: "namespace", fieldRef: { apiVersion: "v1", fieldPath: "metadata.namespace" } },
          ],
        },
      },
    ]);
    assert.deepEqual(
      controller.volumeMounts.find(({ name }) => name === "worker-api-access"),
      {
        name: "worker-api-access",
        mountPath: "/var/run/secrets/kubernetes.io/serviceaccount",
        readOnly: true,
      },
    );

    // All consumers share the operator's one registry; public trust is separate from private TLS.
    for (const deployment of [api, worker]) {
      const pod = deployment.spec.template.spec;
      assert.deepEqual(pod.volumes.find(({ name }) => name === "repository-registry").configMap, {
        name: "repository-registry-v1",
        items: [{ key: "registry.json", path: "registry.json" }],
      });
      assert.deepEqual(pod.volumes.find(({ name }) => name === "repository-public-ca").secret, {
        secretName: "repository-public-ca",
        items: [{ key: "ca.crt", path: "ca.crt" }],
      });
      for (const container of [...(pod.initContainers ?? []), ...pod.containers]) {
        assert.deepEqual(
          container.volumeMounts.find(({ name }) => name === "repository-registry"),
          {
            name: "repository-registry",
            mountPath: "/etc/openclaw/repository-registry",
            readOnly: true,
          },
        );
      }
      const main = deployment === worker ? controller : pod.containers[0];
      assert.deepEqual(
        main.volumeMounts.find(({ name }) => name === "repository-public-ca"),
        {
          name: "repository-public-ca",
          mountPath: "/etc/openclaw/repository-ca",
          readOnly: true,
        },
      );
      assert.ok(!mounts(main).includes("repository-inputs"));
      assert.ok(!mounts(main).includes("repository-private"));
    }
    assert.ok(!mounts(api.spec.template.spec.containers[0]).includes("repository-control"));
    assert.ok(mounts(controller).includes("repository-control"));
    assert.deepEqual(mounts(service).sort(), [
      "repository-control",
      "repository-inputs",
      "repository-private",
      "repository-registry",
    ]);
    assert.equal(service.env, undefined);
    assert.equal(service.securityContext.allowPrivilegeEscalation, false);
    assert.equal(service.securityContext.readOnlyRootFilesystem, true);
    assert.deepEqual(service.securityContext.capabilities.drop, ["ALL"]);
    const inputs = workerPod.volumes.find(({ name }) => name === "repository-inputs").projected;
    assert.equal(inputs.defaultMode, 0o440);
    assert.deepEqual(inputs.sources, [
      {
        secret: { name: "repository-config", items: [{ key: "config.json", path: "config.json" }] },
      },
      {
        secret: {
          name: "repository-app-key",
          items: [{ key: "private-key.pem", path: "private-key.pem" }],
        },
      },
      {
        secret: {
          name: "repository-tls",
          items: [
            { key: "tls.crt", path: "tls.crt" },
            { key: "tls.key", path: "tls.key" },
          ],
        },
      },
    ]);
    for (const name of ["repository-private", "repository-control"]) {
      const volume = workerPod.volumes.find((volume) => volume.name === name);
      assert.equal(volume.emptyDir.medium, "Memory");
      assert.ok(volume.emptyDir.sizeLimit);
    }
    assert.deepEqual(service.command, [
      "node",
      "/app/dist/composition/repository-credentials/projected-inputs.js",
    ]);
    assert.deepEqual(service.args, [
      "--public-origin",
      "https://git.openclaw-system.svc.cluster.local",
      "--backend-id",
      "github-primary",
    ]);
    assert.deepEqual(service.readinessProbe.exec.command, [
      "node",
      "/app/dist/composition/repository-credentials/probe.js",
    ]);

    // Service and CNI policy use different ports: authorization traffic reaches endpoint TCP 8443.
    const endpoint = named("Service", "git");
    assert.equal(endpoint.spec.type, "ClusterIP");
    assert.deepEqual(endpoint.spec.selector, worker.spec.selector.matchLabels);
    assert.deepEqual(endpoint.spec.ports, [
      { name: "https", port: 443, targetPort: 8443, protocol: "TCP" },
    ]);
    const ingress = named("NetworkPolicy", "openclaw-enterprise-repository-credentials-ingress");
    assert.deepEqual(ingress.spec.podSelector.matchLabels, endpoint.spec.selector);
    const egress = named("NetworkPolicy", "openclaw-enterprise-repository-provider-egress");
    assert.deepEqual(egress.spec.podSelector.matchLabels, endpoint.spec.selector);
    assert.deepEqual(egress.spec.egress, [
      { to: [{ ipBlock: { cidr: "198.51.100.0/24" } }], ports: [{ protocol: "TCP", port: 443 }] },
    ]);
    const tenantWorker = named("ClusterRole", "oce-openclaw-tenant-worker");
    assert.deepEqual(
      tenantWorker.rules.filter(({ resources }) => resources.includes("secrets")),
      [
        { apiGroups: [""], resources: ["secrets"], verbs: ["get", "create", "update", "delete"] },
        { apiGroups: [""], resources: ["secrets"], verbs: ["get", "list", "create", "delete"] },
      ],
    );
    // Tenant role binding remains an operator action; no Agent identity receives Secret access here.
    assert.ok(
      !objects.some(
        ({ kind, roleRef }) =>
          ["RoleBinding", "ClusterRoleBinding"].includes(kind) &&
          roleRef.name === tenantWorker.metadata.name,
      ),
    );
  },
);

test(
  "repository credential Helm packaging derives the broker origin from Service settings",
  tooling,
  async () => {
    for (const [namespace, serviceName, clusterDomain, expectedOrigin, hostname] of [
      ["tenant-control", undefined, undefined, "https://git.tenant-control.svc.cluster.local"],
      ["tenant-control", "git", undefined, "https://git.tenant-control.svc.cluster.local"],
      [
        "tenant-control",
        "git",
        undefined,
        "https://git.tenant-control.svc",
        "git.tenant-control.svc",
      ],
      [
        "tenant-control",
        "git",
        "cluster.internal",
        "https://git.tenant-control.svc.cluster.internal",
        "git.tenant-control.svc.cluster.internal",
      ],
      [
        "tenant-control",
        "git",
        "cluster.internal",
        "https://git.tenant-control.svc.cluster.internal",
      ],
      [
        "openclaw-system",
        "openclaw-enterprise-repository-credentials",
        undefined,
        "https://openclaw-enterprise-repository-credentials.openclaw-system.svc.cluster.local",
      ],
    ]) {
      const overrides = {
        ...repositoryCredentialValues,
        ...(hostname === undefined ? {} : { "repositoryCredentials.hostname": hostname }),
        ...(serviceName === undefined ? {} : { "repositoryCredentials.serviceName": serviceName }),
        ...(clusterDomain === undefined
          ? {}
          : { "repositoryCredentials.clusterDomain": clusterDomain }),
      };
      const objects = await resources(
        (await render(overrides, { namespace, isUpgrade: serviceName !== undefined })).stdout,
      );
      const endpointName = serviceName ?? "git";
      assert.ok(
        objects.some(
          (object) => object.kind === "Service" && object.metadata.name === endpointName,
        ),
      );
      const worker = objects.find(
        ({ kind, metadata }) =>
          kind === "Deployment" && metadata.name === "openclaw-enterprise-worker",
      );
      const broker = worker.spec.template.spec.containers.find(
        ({ name }) => name === "repository-credentials",
      );
      assert.deepEqual(broker.args, [
        "--public-origin",
        expectedOrigin,
        "--backend-id",
        "github-primary",
      ]);
    }
  },
);

test(
  "repository credential origin helper reports the rendered broker endpoint",
  tooling,
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "broker-origin-helper-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const valuesFile = join(directory, "values.json");
    await writeFile(
      valuesFile,
      JSON.stringify({
        images: { controller: values["images.controller"] },
        auth: {
          baseUrl: values["auth.baseUrl"],
          secretName: values["auth.secretName"],
          secretKey: values["auth.secretKey"],
        },
        bootstrap: {
          adminEmail: values["bootstrap.adminEmail"],
          password: { claimName: values["bootstrap.password.claimName"] },
        },
        api: {
          clients: [
            {
              namespace: values["api.clients[0].namespace"],
              podLabels: { app: values["api.clients[0].podLabels.app"] },
            },
          ],
        },
        database: { cidrs: [values["database.cidrs[0]"]] },
        cluster: { cidrs: [values["cluster.cidrs[0]"]] },
        repositoryCredentials: {
          enabled: true,
          image: repositoryCredentialValues["repositoryCredentials.image"],
          serviceName: "broker",
          hostname: "broker.openclaw-system.svc",
          backendId: "github-primary",
          registryConfigMapName: "repository-registry-v1",
          serviceConfigSecretName: "repository-config",
          appKeySecretName: "repository-app-key",
          tlsSecretName: "repository-tls",
          publicCaSecretName: "repository-public-ca",
          upstreamCidrs: ["198.51.100.0/24"],
        },
      }),
      { mode: 0o600 },
    );
    const rendered = JSON.parse(
      (
        await execute(
          "node",
          [
            "scripts/render-repository-credentials-origin.mjs",
            "--release",
            "oce",
            "--namespace",
            "openclaw-system",
            "--values",
            valuesFile,
          ],
          { cwd: repository, maxBuffer: 2_000_000 },
        )
      ).stdout,
    );
    assert.deepEqual(rendered, {
      origin: "https://broker.openclaw-system.svc",
      hostname: "broker.openclaw-system.svc",
      serviceName: "broker",
      namespace: "openclaw-system",
      release: "oce",
      backendId: "github-primary",
    });
  },
);

test(
  "image upgrade helper preserves the live broker endpoint before rendering Helm",
  tooling,
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "broker-upgrade-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const bin = join(directory, "bin");
    await mkdir(bin);
    const liveValues = join(directory, "live-values.yaml");
    // Use real Helm/yq; remote reads and image qualification are fixtures.
    const defaults = await readFile(
      new URL("../../deploy/helm/openclaw-enterprise/values.yaml", import.meta.url),
      "utf8",
    );
    await writeFile(liveValues, defaults, { mode: 0o600 });
    const initial = { ...values, ...repositoryCredentialValues };
    for (const [key, value] of Object.entries(initial)) {
      await execute(process.env.OCC_YQ_BIN ?? "yq", [
        "-i",
        `${key.startsWith(".") ? key : `.${key}`} = ${JSON.stringify(value)}`,
        liveValues,
      ]);
    }
    await execute(process.env.OCC_YQ_BIN ?? "yq", [
      "-i",
      ".repositoryCredentials.enabled = true | del(.repositoryCredentials.hostname, .repositoryCredentials.serviceName)",
      liveValues,
    ]);
    const installation = join(directory, "installation.json");
    const kubeconfig = join(directory, "kubeconfig");
    const key = join(directory, "key");
    // The upgrade helper compares the protected Installation with its live Secret.
    const installationDocument = loadYaml(
      await readFile(
        new URL("../../deploy/examples/production/installation.yaml", import.meta.url),
        "utf8",
      ),
    );
    installationDocument.backend = [
      {
        id: "github-primary",
        type: "github",
        configuration: { registryPath: "/etc/openclaw/repository-registry/registry.json" },
        drivers: { repo: "repository-credentials" },
      },
    ];
    installationDocument.drivers.repo = {
      id: "repository-credentials",
      configuration: {
        controlSocket: "/run/openclaw/repository-control/private/control.sock",
        sessionDurationSeconds: 86400,
        publicCaPath: "/etc/openclaw/repository-ca/ca.crt",
      },
    };
    installationDocument.drivers.compute.configuration.network.repositoryCredentials = {
      namespace: "openclaw-system",
      podLabels: {
        "app.kubernetes.io/name": "openclaw-enterprise",
        "app.kubernetes.io/instance": "oce",
        "app.kubernetes.io/component": "worker",
      },
      port: 8443,
    };
    await writeFile(installation, JSON.stringify(installationDocument), { mode: 0o600 });
    for (const path of [kubeconfig, key]) {
      await writeFile(path, "fixture", { mode: 0o600 });
    }
    const secret = join(directory, "secret.json");
    await writeFile(
      secret,
      JSON.stringify({
        metadata: {
          uid: "secret-uid",
          resourceVersion: "1",
          annotations: { "openclaw.dev/installation-id": "ins_test" },
        },
        data: {
          "installation.yaml": Buffer.from(JSON.stringify(installationDocument)).toString("base64"),
        },
      }),
      { mode: 0o600 },
    );
    const worker = join(directory, "worker.json");
    const nodes = join(directory, "nodes.json");
    const probeCalls = join(directory, "probe-calls.txt");
    const controllerImage = `registry.example.invalid/controller@sha256:${"c".repeat(64)}`;
    const brokerImage = `registry.example.invalid/repository-credentials@sha256:${"e".repeat(64)}`;
    await writeFile(
      nodes,
      JSON.stringify({
        items: [
          {
            metadata: {
              name: "fixture-node",
              uid: "fixture-node-uid",
              labels: { "kubernetes.io/os": "linux", "kubernetes.io/arch": "amd64" },
            },
            status: { nodeInfo: { operatingSystem: "linux", architecture: "amd64" } },
          },
        ],
      }),
    );
    const wrappers = {
      kubectl: `#!/usr/bin/env bash
case "$*" in
  *'get secret '*) cat "$TEST_SECRET" ;;
  *'get deployment openclaw-enterprise-worker '*) cat "$TEST_WORKER" ;;
  *'get nodes --output json'*) cat "$TEST_NODES" ;;
  *'get deployments,statefulsets,pods,persistentvolumeclaims '*) printf '{"items":[]}' ;;
  *'get --raw=/readyz'*) printf 'ok' ;;
  *) exit 90 ;;
esac
`,
      occ: `#!/usr/bin/env bash
printf '{"id":"ins_test"}'
`,
      // This test proves chart endpoint preservation, not image compatibility.
      node: `#!/usr/bin/env bash
if [[ "$1" == scripts/upgrade-repository-image-probe.mjs ]]; then
  [[ $# == 4 ]] || exit 92
  printf '%s|%s|%s\\n' "$2" "$3" "$4" >> "$TEST_PROBE_CALLS"
  printf '{"fixture":true}\\n'
else
  exec "$TEST_REAL_NODE" "$@"
fi
`,
      docker: `#!/usr/bin/env bash
exit 93
`,
      helm: `#!/usr/bin/env bash
case "$1 $2" in
  'get values') cat "$TEST_LIVE_VALUES" ;;
  'status oce') if [[ "$*" == *'--output json'* ]]; then printf '{"version":1,"info":{"status":"deployed"}}'; else printf 'deployed'; fi ;;
  'template oce') exec "$TEST_REAL_HELM" "$@" ;;
  'upgrade --install') exit 47 ;;
  *) exit 91 ;;
esac
`,
    };
    for (const [name, contents] of Object.entries(wrappers)) {
      await writeFile(join(bin, name), contents);
      await chmod(join(bin, name), 0o755);
    }
    const realHelm = (await execute("sh", ["-c", 'command -v "$1"', "sh", helm])).stdout.trim();
    for (const [name, hostname, configuredHostname, failure] of [
      ["short", "broker.openclaw-system.svc"],
      ["full", "broker.openclaw-system.svc.cluster.local"],
      [
        "conflicting",
        "broker.openclaw-system.svc",
        "broker.openclaw-system.svc.cluster.local",
        /live origin and Helm Service settings disagree/,
      ],
      [
        "foreign",
        "broker.other-namespace.svc",
        undefined,
        /live origin and Helm Service settings disagree/,
      ],
    ]) {
      await writeFile(
        worker,
        JSON.stringify({
          metadata: { labels: { "app.kubernetes.io/instance": "oce" } },
          spec: {
            template: {
              spec: {
                containers: [
                  {
                    name: "repository-credentials",
                    args: [
                      "--public-origin",
                      `https://${hostname}`,
                      "--backend-id",
                      "github-primary",
                    ],
                  },
                ],
              },
            },
          },
        }),
      );
      await execute(process.env.OCC_YQ_BIN ?? "yq", [
        "-i",
        configuredHostname
          ? `.repositoryCredentials.hostname = ${JSON.stringify(configuredHostname)}`
          : "del(.repositoryCredentials.hostname)",
        liveValues,
      ]);
      const evidence = join(directory, name);
      await writeFile(probeCalls, "", { mode: 0o600 });
      await assert.rejects(
        execute(
          new URL("../../scripts/upgrade-production-images", import.meta.url).pathname,
          [
            "--kubeconfig",
            kubeconfig,
            "--context",
            "fixture",
            "--namespace",
            "openclaw-system",
            "--release",
            "oce",
            "--values",
            liveValues,
            "--installation",
            installation,
            "--controller-image",
            controllerImage,
            "--broker-image",
            brokerImage,
            "--source-revision",
            "d".repeat(40),
            "--evidence-dir",
            evidence,
            "--occ",
            join(bin, "occ"),
          ],
          {
            cwd: repository,
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              OCC_URL: "https://occ.example.invalid",
              OCC_SERVICE_KEY_FILE: key,
              TEST_SECRET: secret,
              TEST_WORKER: worker,
              TEST_NODES: nodes,
              TEST_PROBE_CALLS: probeCalls,
              TEST_REAL_NODE: process.execPath,
              TEST_LIVE_VALUES: liveValues,
              TEST_REAL_HELM: realHelm,
            },
          },
        ),
        (error) => {
          if (failure) {
            assert.match(error.stderr, failure);
          } else {
            assert.equal(error.code, 47, error.stderr);
          }
          return true;
        },
      );
      assert.equal(
        await readFile(probeCalls, "utf8"),
        `${controllerImage}|${brokerImage}|linux/amd64\n`,
      );
      if (!failure) {
        const candidate = await resources(await readFile(join(evidence, "rendered.yaml"), "utf8"));
        const deployment = candidate.find(
          ({ kind, metadata }) =>
            kind === "Deployment" && metadata.name === "openclaw-enterprise-worker",
        );
        const broker = deployment.spec.template.spec.containers.find(
          ({ name }) => name === "repository-credentials",
        );
        assert.equal(broker.args[1], `https://${hostname}`);
        assert.ok(
          candidate.some(({ kind, metadata }) => kind === "Service" && metadata.name === "broker"),
        );
        const retained = loadYaml(await readFile(liveValues, "utf8"));
        assert.equal(
          retained.repositoryCredentials.serviceName,
          undefined,
          "dry-run must not mutate protected inputs",
        );
      }
    }
  },
);

test(
  "repository credential ingress admits embedded and dedicated execution Pods only",
  tooling,
  async () => {
    const objects = await resources((await render(repositoryCredentialValues)).stdout);
    const worker = objects.find(
      ({ kind, metadata }) =>
        kind === "Deployment" && metadata.name === "openclaw-enterprise-worker",
    );
    const destination = {
      namespace: "openclaw-system",
      labels: worker.spec.template.metadata.labels,
    };
    const source = {
      namespace: "oce-tenant",
      namespaceLabels: { "openclaw.dev/namespace": "tenant" },
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/workload-role": "agent",
        "openclaw.dev/agent": "agent-one",
        "openclaw.dev/revision": "revision-one",
        "openclaw.dev/network-profile": "broad-egress-v1",
      },
    };
    const allowed = (peer = source, port = 8443, protocol = "TCP", chart = objects) =>
      chartAllowsIngress(chart, destination, peer, port, protocol);

    // Compute emits these ownership labels plus the ordinary network profile on
    // every workload Pod template. The chart selector stays profile-agnostic: the
    // tenant-side Compute policies already gate egress on the profile.
    assert.equal(allowed(), true, "dedicated execution reaches the credential endpoint");
    const embedded = {
      ...source,
      labels: { ...source.labels, "openclaw.dev/workload-role": "gateway" },
    };
    delete embedded.labels["openclaw.dev/revision"];
    assert.equal(allowed(embedded), true, "embedded gateway access remains available");

    // Namespace and Pod selectors must match together; either alone is insufficient.
    for (const peer of [source, embedded]) {
      assert.equal(allowed({ ...peer, namespaceLabels: {} }), false, "unmanaged namespace");
      for (const key of ["app.kubernetes.io/managed-by", "openclaw.dev/agent"]) {
        const labels = { ...peer.labels };
        delete labels[key];
        assert.equal(allowed({ ...peer, labels }), false, `missing ${key}`);
      }
      assert.equal(
        allowed({ ...peer, labels: { ...peer.labels, "app.kubernetes.io/managed-by": "other" } }),
        false,
        "foreign workload manager",
      );
      assert.equal(allowed(peer, 443), false, "Service port is not the endpoint port");
      assert.equal(allowed(peer, 8444), false, "unrelated endpoint port");
      assert.equal(allowed(peer, 8443, "UDP"), false, "TCP only");
    }
    const noRevision = { ...source.labels };
    delete noRevision["openclaw.dev/revision"];
    assert.equal(allowed({ ...source, labels: noRevision }), false, "dedicated revision required");
    for (const role of [undefined, "worker", "api", "other"]) {
      const labels = { ...source.labels, "openclaw.dev/workload-role": role };
      assert.equal(allowed({ ...source, labels }), false, `unintended workload role ${role}`);
    }
    const disabled = await resources((await render()).stdout);
    assert.equal(
      allowed(source, 8443, "TCP", disabled),
      false,
      "disabled service grants no ingress",
    );
  },
);

test(
  "repository credential Helm packaging rejects incomplete or shared private inputs",
  tooling,
  async () => {
    for (const [overrides, message] of [
      [{ "repositoryCredentials.image": "repository-credentials:latest" }, /immutable SHA-256/],
      [
        { "repositoryCredentials.image": `repository-credentials@sha256:${"B".repeat(64)}` },
        /immutable SHA-256/,
      ],
      [{ "repositoryCredentials.backendId": "" }, /backendId is required/],
      [{ "repositoryCredentials.registryConfigMapName": "" }, /registryConfigMapName is required/],
      [{ "repositoryCredentials.publicCaSecretName": "repository-tls" }, /dedicated Secret/],
      [{ "repositoryCredentials.appKeySecretName": "occ-auth" }, /dedicated Secret/],
      [{ "repositoryCredentials.tlsSecretName": "repository-config" }, /dedicated Secret/],
      [{ "repositoryCredentials.upstreamCidrs[0]": "0.0.0.0/0" }, /explicit IPv4 CIDRs/],
      [{ "repositoryCredentials.upstreamCidrs[0]": "999.1.1.1/32" }, /invalid IPv4 address/],
      ...[
        "external.example.com",
        "git.other-namespace.svc",
        "other.openclaw-system.svc",
        "git.openclaw-system.svc.other-cluster",
        "https://git.openclaw-system.svc",
        "git.openclaw-system.svc:443",
        "git.openclaw-system.svc.",
      ].map((hostname) => [{ "repositoryCredentials.hostname": hostname }, /hostname must match/]),
      [{ "repositoryCredentials.hostname[0]": "git" }, /hostname must be a string/],
      [{ "repositoryCredentials.serviceName": "1git" }, /DNS-1035/],
      [{ "repositoryCredentials.serviceName": "git.openclaw-system.svc" }, /DNS-1035/],
      [{ "repositoryCredentials.serviceName": "a".repeat(64) }, /DNS-1035/],
      [{ "repositoryCredentials.clusterDomain": "cluster.local." }, /cluster DNS domain/],
      [{ "repositoryCredentials.clusterDomain": "Cluster.local" }, /cluster DNS domain/],
      [{ "repositoryCredentials.clusterDomain": `${"a".repeat(64)}.local` }, /cluster DNS domain/],
      [{ "repositoryCredentials.clusterDomain": "a".repeat(254) }, /cluster DNS domain/],
      [{ "repositoryCredentials.clusterDomain[0]": "cluster" }, /cluster DNS domain/],
      [
        {
          "repositoryCredentials.clusterDomain": `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(38)}`,
        },
        /broker hostname/,
      ],
    ]) {
      await assert.rejects(render({ ...repositoryCredentialValues, ...overrides }), message);
    }
    await assert.rejects(
      render(repositoryCredentialValues, { isUpgrade: true }),
      /repositoryCredentials.serviceName must be explicit during upgrades/,
    );
  },
);

test("the chart refuses repository backend IDs the controller refuses", tooling, async () => {
  const message =
    /repositoryCredentials\.backendId must follow the Backend ID rule: 1 to 200 characters, with no leading or trailing whitespace and no control characters or line or paragraph separators/;
  for (const backendId of [
    " github-primary",
    "github-primary ",
    "github-primary\nmore",
    "a".repeat(201),
    "\uFEFFgithub-primary",
    "github-primary\uFEFF",
  ]) {
    await assert.rejects(
      render(repositoryCredentialValues, {
        strings: { "repositoryCredentials.backendId": backendId },
      }),
      message,
      JSON.stringify(backendId),
    );
  }
  await assert.rejects(
    render(repositoryCredentialValues, {
      strings: { "repositoryCredentials.backendId": "😀".repeat(101) },
    }),
    /repositoryCredentials\.backendId must fit in 200 UTF-16 code units for a GitHub Backend, because repository bindings store it under that bound/,
    "101 emoji",
  );
  for (const backendId of ["github-primary", "😀".repeat(100)]) {
    const objects = await resources(
      (
        await render(repositoryCredentialValues, {
          strings: { "repositoryCredentials.backendId": backendId },
        })
      ).stdout,
    );
    const broker = objects
      .find(
        ({ kind, metadata }) =>
          kind === "Deployment" && metadata.labels["app.kubernetes.io/component"] === "worker",
      )
      .spec.template.spec.containers.find(({ name }) => name === "repository-credentials");
    assert.equal(broker.args[broker.args.indexOf("--backend-id") + 1], backendId, backendId);
  }
});

test("the chart refuses installation names the bootstrap Job refuses", tooling, async () => {
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
      ({ code, stderr }) => code !== 0 && message.test(stderr),
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
    const objects = await resources((await render({ "installation.name": name })).stdout);
    const bootstrap = objects.find(
      ({ kind, metadata }) => kind === "Job" && metadata.name.endsWith("-initialization"),
    );
    assert.ok(
      bootstrap.spec.template.spec.containers[0].env.some(
        ({ name: envName, value }) =>
          envName === "OCC_BOOTSTRAP_INSTALLATION_NAME" && value === name,
      ),
      JSON.stringify(name),
    );
  }
});

test(
  "the production Helm chart renders private least-privilege runtime and ordered bootstrap",
  tooling,
  async () => {
    const { stdout } = await render(controlPlaneSelectorValues);
    const objects = await resources(stdout);
    const selected = (kind, component) =>
      objects.find(
        (object) =>
          object.kind === kind &&
          object.metadata.labels?.["app.kubernetes.io/component"] === component,
      );

    // The chart exposes exactly one internal controller Service and no public ingress surface.
    const services = objects.filter(({ kind }) => kind === "Service");
    assert.equal(services.length, 1);
    assert.equal(services[0].spec.type, "ClusterIP");
    assert.ok(!objects.some(({ metadata }) => metadata.name.includes("repository-credentials")));
    for (const deployment of objects.filter(({ kind }) => kind === "Deployment")) {
      assert.equal(deployment.spec.template.spec.containers.length, 1);
      assert.ok(
        !deployment.spec.template.spec.volumes.some(({ name }) => name.startsWith("repository-")),
      );
    }
    const tenantWorker = objects.find(
      ({ kind, metadata }) =>
        kind === "ClusterRole" && metadata.name === "oce-openclaw-tenant-worker",
    );
    assert.deepEqual(
      tenantWorker.rules.filter(({ resources }) => resources.includes("secrets")),
      [{ apiGroups: [""], resources: ["secrets"], verbs: ["get", "create", "update", "delete"] }],
    );
    const gatewayObserver = objects.find(
      ({ kind, metadata }) =>
        kind === "ClusterRole" && metadata.name === "oce-openclaw-gateway-observer",
    );
    assert.deepEqual(gatewayObserver.rules, [
      { apiGroups: ["apps"], resources: ["deployments"], verbs: ["list"] },
      { apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] },
      { apiGroups: [""], resources: ["pods/proxy"], verbs: ["get"] },
      ...runtimeLogRules,
    ]);
    assert.equal(
      objects.some(
        ({ kind, roleRef }) =>
          ["RoleBinding", "ClusterRoleBinding"].includes(kind) &&
          roleRef?.name === gatewayObserver.metadata.name,
      ),
      false,
    );

    assert.ok(!objects.some(({ kind }) => ["Ingress", "Gateway"].includes(kind)));

    // Initialization, API, and worker use distinct identities; database credentials remain isolated.
    for (const component of ["initialization", "api", "worker"]) {
      assert.ok(selected("ServiceAccount", component));
    }
    const initialization = selected("Job", "initialization");
    assert.equal(initialization.spec.backoffLimit, 0);
    const pod = initialization.spec.template.spec;
    assert.equal(pod.automountServiceAccountToken, false);
    assert.deepEqual(pod.nodeSelector, { "oce-role": "control" });
    assert.equal(pod.securityContext.fsGroupChangePolicy, "OnRootMismatch");
    assert.equal(pod.initContainers[0].name, "migration");
    assert.deepEqual(pod.initContainers[0].args, ["scripts/migrate-production.mjs"]);
    assert.equal(pod.containers[0].name, "bootstrap");
    assert.deepEqual(pod.containers[0].args, ["scripts/bootstrap-installation.mjs"]);
    assert.ok(pod.initContainers[0].env.some(({ name }) => name === "OCC_MIGRATION_DATABASE_URL"));
    assert.ok(!pod.initContainers[0].env.some(({ name }) => name === "OCC_DATABASE_URL"));
    assert.ok(pod.containers[0].env.some(({ name }) => name === "OCC_DATABASE_URL"));
    assert.ok(!pod.containers[0].env.some(({ name }) => name === "OCC_MIGRATION_DATABASE_URL"));
    assert.ok(
      pod.containers[0].env.some(
        ({ name, valueFrom }) =>
          name === "OCC_AUTH_SECRET" &&
          valueFrom?.secretKeyRef?.name === "occ-auth" &&
          valueFrom.secretKeyRef.key === "secret",
      ),
    );
    assert.ok(
      pod.containers[0].env.some(
        ({ name, value }) =>
          name === "OCC_AUTH_BASE_URL" && value === "https://occ.example.invalid",
      ),
    );
    assert.ok(
      pod.containers[0].env.some(
        ({ name, value }) =>
          name === "OCC_BOOTSTRAP_ADMIN_EMAIL" && value === "admin@example.invalid",
      ),
    );
    assert.ok(
      pod.containers[0].env.some(
        ({ name, value }) =>
          name === "OCC_BOOTSTRAP_INSTALLATION_NAME" && value === "openclaw-enterprise",
      ),
    );
    assert.ok(
      pod.containers[0].env.some(
        ({ name, value }) =>
          name === "OCC_BOOTSTRAP_PASSWORD_FILE" &&
          value === "/var/lib/openclaw/bootstrap/initial-admin-password",
      ),
    );
    assert.ok(
      pod.containers[0].env.some(
        ({ name, value }) =>
          name === "OCC_BOOTSTRAP_SERVICE_KEY_FILE" &&
          value === "/var/lib/openclaw/bootstrap/initial-admin-service-key.json",
      ),
    );
    assert.ok(
      pod.volumes.some(
        ({ name, persistentVolumeClaim }) =>
          name === "bootstrap-password-output" &&
          persistentVolumeClaim?.claimName === "occ-bootstrap-admin-password",
      ),
    );
    assert.ok(
      pod.containers[0].volumeMounts.some(
        ({ name, mountPath, readOnly }) =>
          name === "bootstrap-password-output" &&
          mountPath === "/var/lib/openclaw/bootstrap" &&
          readOnly === undefined,
      ),
    );

    // The privileged initialization Pod is isolated before its pre-install hook starts.
    const bootstrapPolicies = objects.filter(
      ({ kind, metadata }) =>
        kind === "NetworkPolicy" && metadata.name.startsWith("oce-bootstrap-"),
    );
    assert.equal(bootstrapPolicies.length, 1);
    const isolation = bootstrapPolicies[0];
    assert.ok(
      Number(isolation.metadata.annotations["helm.sh/hook-weight"]) <
        Number(initialization.metadata.annotations["helm.sh/hook-weight"]),
    );
    assert.equal(
      isolation.spec.podSelector.matchLabels["app.kubernetes.io/component"],
      "initialization",
    );
    assert.deepEqual(isolation.spec.policyTypes, ["Ingress", "Egress"]);
    assert.equal(isolation.spec.ingress, undefined);
    assert.equal(isolation.spec.egress.length, 2);

    // Worker runtime authority includes scoped Secret delivery and remains unbound until operators authorize each tenant.
    const roles = objects.filter(({ kind }) => kind === "ClusterRole");
    const bindings = new Set(
      objects
        .filter(({ kind }) => kind === "ClusterRoleBinding")
        .map(({ roleRef }) => roleRef.name),
    );
    const tenant = roles.find(({ metadata }) => metadata.name.endsWith("-openclaw-tenant-worker"));
    const tenantApiRole = roles.find(({ metadata }) =>
      metadata.name.endsWith("-openclaw-tenant-api"),
    );
    const preflightRoles = roles.filter(({ metadata }) =>
      ["-openclaw-namespace-observer", "-openclaw-namespace-worker"].some((suffix) =>
        metadata.name.endsWith(suffix),
      ),
    );
    assert.ok(tenant);
    assert.ok(tenantApiRole);
    assert.equal(preflightRoles.length, 2);
    for (const role of preflightRoles) {
      assert.deepEqual(
        role.rules.filter(({ nonResourceURLs }) => nonResourceURLs !== undefined),
        [{ nonResourceURLs: ["/version"], verbs: ["get"] }],
      );
    }
    assert.ok(!bindings.has(tenant.metadata.name));
    assert.ok(!bindings.has(tenantApiRole.metadata.name));
    assert.ok(tenant.rules.some(({ resources }) => resources.includes("configmaps")));
    assert.deepEqual(tenantApiRole.rules, tenantApiRules());
    // Only the unbound tenant-worker role can reconcile and remove an Agent-owned claim.
    assert.deepEqual(
      tenant.rules.filter(({ resources }) => resources.includes("persistentvolumeclaims")),
      [
        {
          apiGroups: [""],
          resources: ["persistentvolumeclaims"],
          verbs: ["get", "create", "patch", "delete"],
        },
      ],
    );
    for (const role of roles.filter(({ metadata }) => metadata.name !== tenant.metadata.name)) {
      assert.ok(
        !role.rules.some(({ resources }) => resources?.includes("persistentvolumeclaims") === true),
      );
    }
    for (const role of roles.filter(
      ({ metadata }) =>
        metadata.name !== tenantApiRole.metadata.name &&
        !metadata.name.endsWith("-openclaw-tenant-worker"),
    )) {
      for (const rule of role.rules) {
        assert.ok(rule.resources?.includes("secrets") !== true);
        assert.ok(rule.resources?.includes("rolebindings") !== true);
        assert.ok(!rule.verbs.includes("*"));
      }
    }

    // Real rendered workloads retain restricted execution and mount credentials only by Secret reference.
    for (const component of ["api", "worker"]) {
      const pod = selected("Deployment", component).spec.template.spec;
      const container = pod.containers[0];
      assert.deepEqual(pod.nodeSelector, { "oce-role": "control" });
      assert.equal(pod.securityContext.runAsNonRoot, true);
      assert.equal(pod.securityContext.seccompProfile.type, "RuntimeDefault");
      assert.equal(container.securityContext.allowPrivilegeEscalation, false);
      assert.equal(container.securityContext.readOnlyRootFilesystem, true);
      assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
      assert.ok(
        container.env.some(
          ({ name, valueFrom }) => name === "OCC_DATABASE_URL" && valueFrom?.secretKeyRef,
        ),
      );
      if (component === "api") {
        assert.ok(
          container.env.some(
            ({ name, valueFrom }) =>
              name === "OCC_AUTH_SECRET" &&
              valueFrom?.secretKeyRef?.name === "occ-auth" &&
              valueFrom.secretKeyRef.key === "secret",
          ),
        );
        assert.ok(
          container.env.some(
            ({ name, value }) =>
              name === "OCC_AUTH_BASE_URL" && value === "https://occ.example.invalid",
          ),
        );
        assert.ok(!pod.volumes.some(({ name }) => name === "internal-admission"));
        assert.ok(!container.volumeMounts.some(({ name }) => name === "internal-admission"));
        assert.deepEqual(container.livenessProbe.httpGet, { path: "/healthz", port: "http" });
        assert.deepEqual(container.readinessProbe.httpGet, { path: "/readyz", port: "http" });
        // A slow boot must not trip liveness: the startup probe holds liveness off for 2 min.
        // Readiness waits for the first startup success, so a 1 s period lets the API take
        // traffic about when it listens instead of at a later probe tick.
        assert.deepEqual(container.startupProbe, {
          httpGet: { path: "/healthz", port: "http" },
          periodSeconds: 1,
          failureThreshold: 120,
        });
      } else {
        const readinessMount = container.volumeMounts.find(
          ({ name }) => name === "worker-readiness",
        );
        assert.equal(readinessMount.readOnly, undefined);
        assert.equal(
          container.env.find(({ name }) => name === "OCC_WORKER_READINESS_PATH").value,
          `${readinessMount.mountPath}/ready`,
        );
        // Liveness restarts a wedged run loop, so its progress marker must be writable too.
        assert.equal(
          container.env.find(({ name }) => name === "OCC_WORKER_LIVENESS_PATH").value,
          `${readinessMount.mountPath}/alive`,
        );
        assert.deepEqual(container.readinessProbe.exec.command, [
          "node",
          "scripts/production-healthcheck.mjs",
          "worker",
          "ready",
        ]);
        assert.deepEqual(container.livenessProbe.exec.command, [
          "node",
          "scripts/production-healthcheck.mjs",
          "worker",
        ]);
      }
    }
    assert.ok(!stdout.includes("OCC_INTERNAL_API_"));
    assert.ok(!stdout.includes("internal-admission"));
    assert.ok(!stdout.includes("bearer-token"));
    assert.equal(objects.filter(({ kind }) => kind === "Secret").length, 0);
    assert.ok(
      objects.some(
        ({ kind, metadata }) => kind === "NetworkPolicy" && metadata.name.endsWith("default-deny"),
      ),
    );
    const dependencyEgress = objects.find(
      ({ kind, metadata }) =>
        kind === "NetworkPolicy" && metadata.name === "openclaw-enterprise-dependency-egress",
    );
    // Shared grants belong only to control-plane workloads in this release.
    assert.deepEqual(dependencyEgress.spec.podSelector, {
      matchLabels: {
        "app.kubernetes.io/name": "openclaw-enterprise",
        "app.kubernetes.io/instance": "oce",
      },
      matchExpressions: [
        {
          key: "app.kubernetes.io/component",
          operator: "In",
          values: ["api", "worker", "initialization"],
        },
      ],
    });
    assert.deepEqual(
      dependencyEgress.spec.egress.find(({ ports }) => ports.some(({ port }) => port === 5432)).to,
      [{ ipBlock: { cidr: "10.45.0.12/32" } }, { ipBlock: { cidr: "10.45.0.13/32" } }],
    );
    assert.deepEqual(
      dependencyEgress.spec.egress.find(({ ports }) => ports.some(({ port }) => port === 443)).to,
      [{ ipBlock: { cidr: "10.43.0.1/32" } }, { ipBlock: { cidr: "10.43.0.2/32" } }],
    );
    assert.ok(!objects.some(({ metadata }) => metadata.name.endsWith("-api-chatgpt-egress")));
  },
);

test(
  "optional model discovery grants only API HTTPS egress to configured hosts",
  tooling,
  async () => {
    const name = "openclaw-enterprise-api-model-discovery-egress";
    const defaults = await resources((await render()).stdout);
    assert.ok(!defaults.some(({ metadata }) => metadata.name === name));
    const objects = await resources(
      (
        await render({
          "api.modelDiscoveryCidrs[0]": "198.51.100.25/32",
          "api.modelDiscoveryCidrs[1]": "198.51.100.26/32",
        })
      ).stdout,
    );
    const policy = objects.find(
      ({ kind, metadata }) => kind === "NetworkPolicy" && metadata.name === name,
    );
    assert.ok(policy, "configured discovery destinations must render an egress policy");
    assert.deepEqual(policy.spec, {
      podSelector: {
        matchLabels: {
          "app.kubernetes.io/name": "openclaw-enterprise",
          "app.kubernetes.io/instance": "oce",
          "app.kubernetes.io/component": "api",
        },
      },
      policyTypes: ["Egress"],
      egress: [
        {
          to: [
            { ipBlock: { cidr: "198.51.100.25/32" } },
            { ipBlock: { cidr: "198.51.100.26/32" } },
          ],
          ports: [{ protocol: "TCP", port: 443 }],
        },
      ],
    });
    for (const cidr of [
      "0.0.0.0/0",
      "198.51.100.0/24",
      "api.openai.com",
      "999.1.1.1/32",
      "01.2.3.4/32",
    ]) {
      await assert.rejects(
        render({ "api.modelDiscoveryCidrs[0]": cidr }),
        /api.modelDiscoveryCidrs/,
      );
    }
    await assert.rejects(
      render({ "api.modelDiscoveryCidrs": "198.51.100.25/32" }),
      /api.modelDiscoveryCidrs/,
    );
  },
);

test("Slack directory proxy grants only API egress to its exact endpoint", tooling, async () => {
  const name = "openclaw-enterprise-api-channel-directory-egress";
  const defaults = await resources((await render()).stdout);
  assert.ok(!defaults.some(({ metadata }) => metadata.name === name));
  const objects = await resources(
    (await render({ "api.channelDirectoryProxyUrl": "http://198.51.100.25:3128" })).stdout,
  );
  const policy = objects.find(
    ({ kind, metadata }) => kind === "NetworkPolicy" && metadata.name === name,
  );
  assert.ok(policy, "configured directory proxy must render API egress");
  assert.deepEqual(policy.spec, {
    podSelector: {
      matchLabels: {
        "app.kubernetes.io/name": "openclaw-enterprise",
        "app.kubernetes.io/instance": "oce",
        "app.kubernetes.io/component": "api",
      },
    },
    policyTypes: ["Egress"],
    egress: [
      {
        to: [{ ipBlock: { cidr: "198.51.100.25/32" } }],
        ports: [{ protocol: "TCP", port: 3128 }],
      },
    ],
  });
  const proxyEnvironment = (objects, component) =>
    objects
      .find(
        ({ kind, spec }) =>
          kind === "Deployment" &&
          spec.template.metadata.labels["app.kubernetes.io/component"] === component,
      )
      .spec.template.spec.containers[0].env.find(
        ({ name }) => name === "OCC_CHANNEL_DIRECTORY_PROXY_URL",
      );
  assert.deepEqual(proxyEnvironment(objects, "api"), {
    name: "OCC_CHANNEL_DIRECTORY_PROXY_URL",
    value: "http://198.51.100.25:3128",
  });
  assert.equal(proxyEnvironment(objects, "worker"), undefined);
  assert.equal(proxyEnvironment(defaults, "api"), undefined);
  for (const url of [
    "http://slack.com:3128",
    "http://198.51.100.25:65536",
    syntheticCredentialUrl({
      protocol: "http",
      username: "user",
      password: "pass",
      host: "198.51.100.25",
      port: 3128,
    }),
    "http://198.51.100.25:3128/path",
    "http://198.51.100.999:3128",
  ]) {
    await assert.rejects(
      render({ "api.channelDirectoryProxyUrl": url }),
      /api.channelDirectoryProxyUrl/,
    );
  }
});

test(
  "managed Slack proxy renders private Service DNS and restricted proxy policies",
  tooling,
  async () => {
    const objects = await resources((await render(slackProxyValues)).stdout);
    const named = (kind, name) =>
      objects.find((object) => object.kind === kind && object.metadata.name === name);
    const deployment = named("Deployment", "openclaw-enterprise-slack-proxy");
    const service = named("Service", "openclaw-enterprise-slack-proxy");
    const proxyPolicy = named("NetworkPolicy", "openclaw-enterprise-slack-proxy");
    const apiPolicy = named("NetworkPolicy", "openclaw-enterprise-api-managed-slack-proxy-egress");
    assert.ok(deployment);
    assert.ok(service);
    assert.ok(proxyPolicy);
    assert.ok(apiPolicy);
    assert.equal(
      deployment.spec.template.spec.serviceAccountName,
      "openclaw-enterprise-slack-proxy",
    );
    assert.equal(deployment.spec.template.spec.automountServiceAccountToken, false);
    assert.equal(deployment.spec.template.spec.enableServiceLinks, false);
    assert.deepEqual(
      deployment.spec.template.spec.containers[0].env.find(
        ({ name }) => name === "OCC_SLACK_PROXY_PORT",
      ),
      { name: "OCC_SLACK_PROXY_PORT", value: "3128" },
    );
    assert.deepEqual(service.spec.selector, {
      "app.kubernetes.io/name": "openclaw-enterprise",
      "app.kubernetes.io/instance": "oce",
      "app.kubernetes.io/component": "slack-proxy",
    });
    const api = named("Deployment", "openclaw-enterprise-api").spec.template.spec.containers[0];
    assert.deepEqual(
      api.env.find(({ name }) => name === "OCC_CHANNEL_DIRECTORY_PROXY_URL"),
      {
        name: "OCC_CHANNEL_DIRECTORY_PROXY_URL",
        value: "http://openclaw-enterprise-slack-proxy.openclaw-system.svc:3128",
      },
    );
    assert.deepEqual(
      api.env.find(({ name }) => name === "OCC_CHANNEL_DIRECTORY_MANAGED_PROXY_HOST"),
      {
        name: "OCC_CHANNEL_DIRECTORY_MANAGED_PROXY_HOST",
        value: "openclaw-enterprise-slack-proxy.openclaw-system.svc",
      },
    );
    assert.deepEqual(apiPolicy.spec.egress, [
      {
        to: [
          {
            namespaceSelector: {
              matchLabels: { "kubernetes.io/metadata.name": "openclaw-system" },
            },
            podSelector: {
              matchLabels: {
                "app.kubernetes.io/name": "openclaw-enterprise",
                "app.kubernetes.io/instance": "oce",
                "app.kubernetes.io/component": "slack-proxy",
              },
            },
          },
        ],
        ports: [{ protocol: "TCP", port: 3128 }],
      },
    ]);
    const apiProxyPeer = {
      namespaceSelector: {
        matchLabels: { "kubernetes.io/metadata.name": "openclaw-system" },
      },
      podSelector: {
        matchLabels: {
          "app.kubernetes.io/name": "openclaw-enterprise",
          "app.kubernetes.io/instance": "oce",
          "app.kubernetes.io/component": "api",
        },
      },
    };
    assert.deepEqual(proxyPolicy.spec.ingress, [
      {
        from: [apiProxyPeer],
        ports: [{ protocol: "TCP", port: 3128 }],
      },
    ]);
    const gatewayObjects = await resources(
      (await render({ ...slackProxyValues, ...gatewayRoutingValues })).stdout,
    );
    const gatewayProxyPolicy = gatewayObjects.find(
      (object) =>
        object.kind === "NetworkPolicy" &&
        object.metadata.name === "openclaw-enterprise-slack-proxy",
    );
    assert.deepEqual(gatewayProxyPolicy.spec.ingress, [
      {
        from: [
          apiProxyPeer,
          {
            namespaceSelector: {
              matchLabels: {
                "openclaw-enterprise.io/gateway": routeNamespaceLabel(
                  "openclaw-system",
                  "oce-agent-gateways",
                ),
              },
              matchExpressions: [{ key: "openclaw.dev/gateway-namespace", operator: "Exists" }],
            },
            podSelector: {
              matchLabels: {
                "app.kubernetes.io/managed-by": "openclaw-enterprise",
                "openclaw.dev/workload-role": "gateway",
              },
              matchExpressions: [{ key: "openclaw.dev/agent", operator: "Exists" }],
            },
          },
        ],
        ports: [{ protocol: "TCP", port: 3128 }],
      },
    ]);
    assert.deepEqual(proxyPolicy.spec.egress.at(-1), {
      // Preserve the original proxy's public HTTPS destinations as DNS rotates.
      to: [
        {
          ipBlock: {
            cidr: "0.0.0.0/0",
            except: [
              "0.0.0.0/8",
              "10.0.0.0/8",
              "100.64.0.0/10",
              "127.0.0.0/8",
              "169.254.0.0/16",
              "172.16.0.0/12",
              "192.0.0.0/24",
              "192.0.2.0/24",
              "192.168.0.0/16",
              "198.18.0.0/15",
              "198.51.100.0/24",
              "203.0.113.0/24",
              "224.0.0.0/4",
              "240.0.0.0/4",
            ],
          },
        },
      ],
      ports: [{ protocol: "TCP", port: 443 }],
    });
    assert.equal(
      named("ServiceAccount", "openclaw-enterprise-slack-proxy").automountServiceAccountToken,
      false,
    );
    await assert.rejects(
      render({ ...slackProxyValues, "api.channelDirectoryProxyUrl": "http://198.51.100.25:3128" }),
      /api.channelDirectoryProxyUrl/,
    );
    for (const override of [
      { "slackProxy.serviceName": "1proxy" },
      { "slackProxy.port": "65536" },
    ]) {
      await assert.rejects(render({ ...slackProxyValues, ...override }), /slackProxy/);
    }
    await assert.rejects(
      render(slackProxyValues, { strings: { "slackProxy.port": "010" } }),
      /slackProxy\.port must be an integer TCP port/,
    );
    await assert.rejects(
      render(slackProxyValues, { strings: { "slackProxy.port": "9223372036854775808" } }),
      /slackProxy\.port must be an integer TCP port/,
    );
  },
);

test("database CA mounts stay distinct from active production volume mounts", tooling, async () => {
  const optionalFeatures = {
    ...repositoryCredentialValues,
    ...gatewayRoutingValues,
    ...chatgptValues,
    "executionCluster.enabled": "true",
    "executionCluster.apiKubeconfigSecretName": "execution-api",
    "executionCluster.workerKubeconfigSecretName": "execution-worker",
    "executionCluster.apiCidrs[0]": "10.44.0.2/32",
  };
  for (const features of [
    {},
    optionalFeatures,
    { "bootstrap.password.mountPath": "/custom/bootstrap" },
  ]) {
    const objects = await resources((await render(features)).stdout);
    // Derive the existing mounts from shipped workloads, independently of the validation list.
    const paths = new Set(
      objects
        .filter(
          (object) =>
            ["Deployment", "Job"].includes(object.kind) &&
            ["api", "worker", "initialization"].includes(
              object.metadata.labels["app.kubernetes.io/component"],
            ),
        )
        .flatMap((object) => [
          ...(object.spec.template.spec.initContainers ?? []),
          ...object.spec.template.spec.containers,
        ])
        .filter((container) => ["api", "worker", "migration", "bootstrap"].includes(container.name))
        .flatMap((container) => (container.volumeMounts ?? []).map((mount) => mount.mountPath)),
    );
    assert.ok(paths.size > 0);
    for (const mountPath of paths) {
      await assert.rejects(
        render({ ...features, ...databaseCaValues, "database.caMountPath": mountPath }),
        /database.caMountPath.*distinct/,
        mountPath,
      );
    }
  }
  // Paths reserved by optional features remain available when those features are disabled.
  for (const mountPath of [
    "/etc/openclaw/execution",
    "/etc/openclaw/repository-registry",
    "/etc/openclaw/repository-ca",
    "/var/run/secrets/kubernetes.io/serviceaccount",
    "/run/openclaw/repository-control",
    "/etc/openclaw/gateway-api-key",
    "/etc/openclaw/gateway-ca",
    "/etc/openclaw/chatgpt",
    "/custom/database-ca",
  ]) {
    await render({ ...databaseCaValues, "database.caMountPath": mountPath });
  }
  const ordinary = (await render()).stdout;
  await render({
    ...externalGatewayRoutingValues,
    ...databaseCaValues,
    "database.caMountPath": "/etc/openclaw/gateway-ca",
  });
  // The repository sidecar's private mounts do not occur in a database client.
  for (const mountPath of ["/etc/openclaw/repository-inputs", "/run/openclaw/repository-private"]) {
    await render({ ...optionalFeatures, ...databaseCaValues, "database.caMountPath": mountPath });
  }
  for (const mountPath of ["/etc/openclaw/installation", "/var/lib/openclaw/bootstrap"]) {
    assert.equal((await render({ "database.caMountPath": mountPath })).stdout, ordinary);
  }
});

test(
  "optional database CA Secret mounts into every production database client",
  tooling,
  async () => {
    const { stdout } = await render(databaseCaValues);
    const objects = await resources(stdout);
    const selected = (kind, component) =>
      objects.find(
        (object) =>
          object.kind === kind &&
          object.metadata.labels?.["app.kubernetes.io/component"] === component,
      );

    const initializationPod = selected("Job", "initialization").spec.template.spec;
    assert.deepEqual(initializationPod.volumes.find(({ name }) => name === "database-ca")?.secret, {
      secretName: "occ-rds-ca",
      items: [{ key: "ca.pem", path: "ca.pem" }],
    });
    assert.deepEqual(
      initializationPod.initContainers[0].volumeMounts.find(({ name }) => name === "database-ca"),
      { name: "database-ca", mountPath: "/etc/openclaw/database-ca", readOnly: true },
    );
    assert.deepEqual(
      initializationPod.containers[0].volumeMounts.find(({ name }) => name === "database-ca"),
      { name: "database-ca", mountPath: "/etc/openclaw/database-ca", readOnly: true },
    );

    for (const component of ["api", "worker"]) {
      const pod = selected("Deployment", component).spec.template.spec;
      assert.deepEqual(pod.volumes.find(({ name }) => name === "database-ca")?.secret, {
        secretName: "occ-rds-ca",
        items: [{ key: "ca.pem", path: "ca.pem" }],
      });
      assert.deepEqual(
        pod.containers[0].volumeMounts.find(({ name }) => name === "database-ca"),
        {
          name: "database-ca",
          mountPath: "/etc/openclaw/database-ca",
          readOnly: true,
        },
      );
    }
  },
);

test(
  "the optional ChatGPT Backend isolates admin credentials, tenant Secrets, and provider egress to the API",
  tooling,
  async () => {
    const { stdout } = await render(chatgptValues);
    const objects = await resources(stdout);
    const deployment = (component) =>
      objects.find(
        ({ kind, metadata }) =>
          kind === "Deployment" && metadata.labels?.["app.kubernetes.io/component"] === component,
      );

    // The operator-owned admin Secret is available only to the API through its fixed file path.
    const apiPod = deployment("api").spec.template.spec;
    const adminVolume = apiPod.volumes.find(({ name }) => name === "chatgpt-admin");
    assert.deepEqual(adminVolume.secret, {
      secretName: "occ-chatgpt-admin",
      items: [{ key: "admin-key", path: "admin-key" }],
    });
    assert.deepEqual(
      apiPod.containers[0].volumeMounts.find(({ name }) => name === "chatgpt-admin"),
      { name: "chatgpt-admin", mountPath: "/etc/openclaw/chatgpt", readOnly: true },
    );
    const workerPod = deployment("worker").spec.template.spec;
    assert.ok(!workerPod.volumes.some(({ name }) => name === "chatgpt-admin"));
    assert.ok(!workerPod.containers[0].volumeMounts.some(({ name }) => name === "chatgpt-admin"));
    assert.equal(objects.filter(({ kind }) => kind === "Secret").length, 0);

    // Operators bind the limited API role inside individual tenants; no cluster-wide binding is emitted.
    const roles = objects.filter(({ kind }) => kind === "ClusterRole");
    const tenantApiRole = roles.find(({ metadata }) =>
      metadata.name.endsWith("-openclaw-tenant-api"),
    );
    assert.ok(tenantApiRole);
    assert.deepEqual(tenantApiRole.rules, tenantApiRules());
    assert.ok(
      !objects.some(
        ({ kind, roleRef }) =>
          kind === "ClusterRoleBinding" && roleRef.name === tenantApiRole.metadata.name,
      ),
    );
    for (const role of roles.filter(
      ({ metadata }) =>
        metadata.name !== tenantApiRole.metadata.name &&
        !metadata.name.endsWith("-openclaw-tenant-worker"),
    )) {
      for (const rule of role.rules) {
        assert.ok(rule.resources?.includes("secrets") !== true);
      }
    }

    // Only API Pods may reach the single approved provider/proxy host, exclusively over HTTPS.
    const providerPolicy = objects.find(
      ({ kind, metadata }) =>
        kind === "NetworkPolicy" && metadata.name === "openclaw-enterprise-api-chatgpt-egress",
    );
    assert.ok(providerPolicy);
    assert.equal(providerPolicy.spec.podSelector.matchLabels["app.kubernetes.io/component"], "api");
    assert.deepEqual(providerPolicy.spec.policyTypes, ["Egress"]);
    assert.deepEqual(providerPolicy.spec.egress, [
      {
        to: [{ ipBlock: { cidr: "198.51.100.25/32" } }],
        ports: [{ protocol: "TCP", port: 443 }],
      },
    ]);
  },
);

const signInEnv = /^OCC_AUTH_(GITHUB_|GOOGLE_|TRUSTED_PROXY_CIDRS|CLIENT_IP_HEADER)/;

async function signInObjects(overrides) {
  const objects = await resources((await render(overrides)).stdout);
  const selected = (kind, component) =>
    objects.find(
      (object) =>
        object.kind === kind &&
        object.metadata.labels?.["app.kubernetes.io/component"] === component,
    );
  const apiEnv = Object.fromEntries(
    selected("Deployment", "api").spec.template.spec.containers[0].env.map(({ name, ...value }) => [
      name,
      value,
    ]),
  );
  const egress = objects.find(
    ({ kind, metadata }) =>
      kind === "NetworkPolicy" && metadata.name === "openclaw-enterprise-api-github-login-egress",
  );
  return { objects, selected, apiEnv, egress };
}

test(
  "optional GitHub sign-in reaches only the API through a dedicated Secret and GitHub egress",
  tooling,
  async () => {
    const { objects, selected, apiEnv, egress } = await signInObjects({
      ...githubLoginValues,
      ...githubEgressValues,
      ...trustedProxyValues,
    });
    assert.deepEqual(selected("Deployment", "api").spec.strategy, { type: "Recreate" });
    assert.deepEqual(apiEnv.OCC_AUTH_GITHUB_CLIENT_ID, {
      valueFrom: { secretKeyRef: { name: "occ-github-login", key: "client-id" } },
    });
    assert.deepEqual(apiEnv.OCC_AUTH_GITHUB_CLIENT_SECRET, {
      valueFrom: { secretKeyRef: { name: "occ-github-login", key: "client-secret" } },
    });
    assert.deepEqual(apiEnv.OCC_AUTH_GITHUB_RECOVERY_USER_ID, { value: "Xk3u9pQ2rT7vW1yZ" });
    assert.deepEqual(apiEnv.OCC_AUTH_TRUSTED_PROXY_CIDRS, { value: "10.42.0.0/16" });
    assert.deepEqual(apiEnv.OCC_AUTH_TRUSTED_PROXY_PRESET, { value: "ingress-nginx" });
    assert.equal(apiEnv.OCC_AUTH_CLIENT_IP_HEADER, undefined);
    // Bootstrap never activates the profile and the worker never signs anyone in.
    const jobs = objects.filter(({ kind }) => kind === "Job");
    assert.ok(jobs.length > 0);
    for (const pod of [
      selected("Deployment", "worker").spec.template.spec,
      ...jobs.map((job) => job.spec.template.spec),
    ]) {
      for (const container of [...(pod.initContainers ?? []), ...pod.containers]) {
        assert.ok(!(container.env ?? []).some(({ name }) => signInEnv.test(name)));
      }
    }
    assert.deepEqual(egress.spec.podSelector.matchLabels, {
      "app.kubernetes.io/name": "openclaw-enterprise",
      "app.kubernetes.io/instance": "oce",
      "app.kubernetes.io/component": "api",
    });
    assert.deepEqual(egress.spec.policyTypes, ["Egress"]);
    assert.deepEqual(egress.spec.egress, [
      {
        to: [{ ipBlock: { cidr: "140.82.112.0/20" } }, { ipBlock: { cidr: "192.30.252.0/22" } }],
        ports: [{ protocol: "TCP", port: 443 }],
      },
    ]);
    assert.equal(objects.filter(({ kind }) => kind === "Secret").length, 0);
  },
);

test("GitHub sign-in egress defaults to HTTPS except link-local", tooling, async () => {
  const { apiEnv, egress } = await signInObjects(githubLoginValues);
  assert.equal(apiEnv.OCC_AUTH_TRUSTED_PROXY_CIDRS, undefined);
  assert.equal(apiEnv.OCC_AUTH_TRUSTED_PROXY_PRESET, undefined);
  assert.equal(apiEnv.OCC_AUTH_CLIENT_IP_HEADER, undefined);
  assert.deepEqual(egress.spec.egress, [
    {
      to: [{ ipBlock: { cidr: "0.0.0.0/0", except: ["169.254.0.0/16"] } }],
      ports: [{ protocol: "TCP", port: 443 }],
    },
  ]);
});

test(
  "trusted proxy presets render the client-address header for the API only",
  tooling,
  async () => {
    // Named presets fix x-forwarded-for in the controller; only generic renders a header.
    for (const [overrides, preset, cidrs, header] of [
      [trustedProxyValues, "ingress-nginx", "10.42.0.0/16", undefined],
      [
        { ...trustedProxyValues, "api.trustedProxy.clientAddressHeader": "X-Forwarded-For" },
        "ingress-nginx",
        "10.42.0.0/16",
        undefined,
      ],
      [
        {
          "api.trustedProxy.preset": "aws",
          "api.trustedProxy.cidrs[0]": "10.0.0.0/20",
          "api.trustedProxy.cidrs[1]": "10.0.16.0/20",
        },
        "aws",
        "10.0.0.0/20,10.0.16.0/20",
        undefined,
      ],
      [
        {
          "api.trustedProxy.preset": "generic",
          "api.trustedProxy.cidrs[0]": "fd00:10::/64",
          "api.trustedProxy.clientAddressHeader": "X-Client-Address",
        },
        "generic",
        "fd00:10::/64",
        { value: "x-client-address" },
      ],
      [
        // The controller's header token allows at most 64 characters.
        {
          "api.trustedProxy.preset": "generic",
          "api.trustedProxy.cidrs[0]": "10.42.0.0/16",
          "api.trustedProxy.clientAddressHeader": `x-${"a".repeat(62)}`,
        },
        "generic",
        "10.42.0.0/16",
        { value: `x-${"a".repeat(62)}` },
      ],
      [
        // ::ffff:d.d.d.d is an IPv4 address after the API rewrites it, so /32 stays valid.
        {
          "api.trustedProxy.preset": "generic",
          "api.trustedProxy.cidrs[0]": "::ffff:192.0.2.1/32",
          "api.trustedProxy.clientAddressHeader": "X-Client-Address",
        },
        "generic",
        "::ffff:192.0.2.1/32",
        { value: "x-client-address" },
      ],
    ]) {
      const { selected, apiEnv, egress } = await signInObjects(overrides);
      assert.deepEqual(apiEnv.OCC_AUTH_TRUSTED_PROXY_CIDRS, { value: cidrs });
      assert.deepEqual(apiEnv.OCC_AUTH_TRUSTED_PROXY_PRESET, { value: preset });
      assert.deepEqual(apiEnv.OCC_AUTH_CLIENT_IP_HEADER, header);
      assert.ok(!Object.keys(apiEnv).some((name) => name.startsWith("OCC_AUTH_GITHUB_")));
      assert.equal(egress, undefined);
      const worker = selected("Deployment", "worker").spec.template.spec.containers[0];
      assert.ok(!worker.env.some(({ name }) => signInEnv.test(name)));
    }
  },
);

test(
  "the real Helm renderer rejects sign-in and trusted proxy misconfigurations",
  tooling,
  async () => {
    for (const [description, override, message] of [
      [
        "GitHub sign-in without a recovery user",
        { "auth.github.enabled": "true" },
        /auth\.github\.enabled requires auth\.recoveryUserId/,
      ],
      [
        "a recovery user without GitHub, Google or OIDC sign-in",
        { "auth.recoveryUserId": "Xk3u9pQ2rT7vW1yZ" },
        /auth\.recoveryUserId requires auth\.github\.enabled, auth\.google\.enabled or auth\.oidc\.enabled/,
      ],
      [
        "GitHub sign-in with an invalid recovery user",
        { ...githubLoginValues, "auth.recoveryUserId": "admin@example.invalid" },
        /auth\.recoveryUserId must be/,
      ],
      [
        "GitHub sign-in with the retired nested recovery user",
        { ...githubLoginValues, "auth.github.recoveryUserId": "Xk3u9pQ2rT7vW1yZ" },
        /set auth\.recoveryUserId/,
      ],
      [
        "GitHub sign-in with a hostname egress",
        { ...githubLoginValues, "auth.github.egressCidrs[0]": "github.com" },
        /auth\.github\.egressCidrs requires explicit IPv4 CIDRs/,
      ],
      [
        "GitHub sign-in with an invalid egress address",
        { ...githubLoginValues, "auth.github.egressCidrs[0]": "140.82.312.0/20" },
        /invalid IPv4 address/,
      ],
      [
        "GitHub sign-in with a /0 egress entry",
        { ...githubLoginValues, "auth.github.egressCidrs[0]": "0.0.0.0/0" },
        /prefixes 1 through 32/,
      ],
      [
        "GitHub sign-in with an empty-string egress list",
        { ...githubLoginValues, "auth.github.egressCidrs": "" },
        /auth\.github\.egressCidrs must be a list of IPv4 CIDRs; leave it unset, or set \[\] in a values file or with --set-json,/,
      ],
      [
        "GitHub sign-in with an empty-string organization allowlist",
        { ...githubLoginValues, "auth.github.allowedOrgs": "" },
        /auth\.github\.allowedOrgs must be a list of GitHub organization logins/,
      ],
      [
        "GitHub sign-in with an empty-string team allowlist",
        { ...githubLoginValues, "auth.github.allowedTeams": "" },
        /auth\.github\.allowedTeams must be a list of org\/team-slug entries/,
      ],
      [
        "GitHub sign-in sharing the Better Auth Secret",
        { ...githubLoginValues, "auth.github.secretName": "occ-auth" },
        /dedicated Secret/,
      ],
      [
        "GitHub sign-in sharing the database Secret",
        { ...githubLoginValues, "auth.github.secretName": "occ-database" },
        /dedicated Secret/,
      ],
      [
        "GitHub sign-in sharing the installation Secret",
        { ...githubLoginValues, "auth.github.secretName": "occ-installation-startup" },
        /dedicated Secret/,
      ],
      [
        "GitHub sign-in reusing one Secret key",
        { ...githubLoginValues, "auth.github.clientSecretKey": "client-id" },
        /different Secret keys/,
      ],
      [
        "GitHub sign-in without a client ID key",
        { ...githubLoginValues, "auth.github.clientIdKey": "" },
        /client ID key/,
      ],
      [
        "GitHub sign-in over HTTP",
        { ...githubLoginValues, "auth.baseUrl": "http://occ.example.invalid" },
        /HTTPS auth\.baseUrl/,
      ],
      [
        "GitHub sign-in with shared native admin cookies",
        { ...githubLoginValues, ...agentNativeAdminValues },
        /agentNativeAdmin\.enabled: false/,
      ],
      [
        "an unknown trusted proxy preset",
        { ...trustedProxyValues, "api.trustedProxy.preset": "haproxy" },
        /ingress-nginx, aws, or generic/,
      ],
      [
        "a trusted proxy preset without CIDRs",
        { "api.trustedProxy.preset": "ingress-nginx" },
        /requires api\.trustedProxy\.cidrs/,
      ],
      [
        "trusted proxy CIDRs without a preset",
        { "api.trustedProxy.cidrs[0]": "10.42.0.0/16" },
        /require api\.trustedProxy\.preset/,
      ],
      [
        "a client-address header without a preset",
        { "api.trustedProxy.clientAddressHeader": "x-real-ip" },
        /require api\.trustedProxy\.preset/,
      ],
      [
        "a generic trusted proxy without a header",
        { ...trustedProxyValues, "api.trustedProxy.preset": "generic" },
        /generic requires api\.trustedProxy\.clientAddressHeader/,
      ],
      [
        "a trusted proxy for every IPv4 peer",
        { ...trustedProxyValues, "api.trustedProxy.cidrs[0]": "0.0.0.0/0" },
        /nonzero prefix/,
      ],
      [
        "a trusted proxy for every IPv6 peer",
        { ...trustedProxyValues, "api.trustedProxy.cidrs[0]": "::/0" },
        /nonzero prefix/,
      ],
      [
        "a trusted proxy hostname",
        { ...trustedProxyValues, "api.trustedProxy.cidrs[0]": "ingress.example.invalid" },
        /nonzero prefix/,
      ],
      [
        "a trusted proxy with an invalid IPv4 address",
        { ...trustedProxyValues, "api.trustedProxy.cidrs[0]": "10.420.0.0/16" },
        /invalid IPv4 address/,
      ],
      [
        "a trusted proxy with a leading-zero IPv4 address",
        { ...trustedProxyValues, "api.trustedProxy.cidrs[0]": "01.2.3.4/32" },
        /invalid IPv4 address/,
      ],
      [
        "a trusted proxy with a malformed IPv6 address",
        { ...trustedProxyValues, "api.trustedProxy.cidrs[0]": "a:/64" },
        /invalid IPv6 address/,
      ],
      [
        "a trusted proxy with more than one IPv6 compression",
        { ...trustedProxyValues, "api.trustedProxy.cidrs[0]": ":::/64" },
        /invalid IPv6 address/,
      ],
      [
        "a trusted proxy with too many IPv6 groups",
        { ...trustedProxyValues, "api.trustedProxy.cidrs[0]": "1:2:3:4:5:6:7:8:9/64" },
        /invalid IPv6 address/,
      ],
      [
        "a trusted proxy with a dotted tail before compression",
        { ...trustedProxyValues, "api.trustedProxy.cidrs[0]": "1.2.3.4::/96" },
        /invalid IPv6 address/,
      ],
      [
        "an IPv4-mapped trusted proxy with an IPv6 prefix",
        { ...trustedProxyValues, "api.trustedProxy.cidrs[0]": "::ffff:192.0.2.1/128" },
        /prefix must be 1 through 32/,
      ],
      [
        "the internal client-address header",
        { ...trustedProxyValues, "api.trustedProxy.clientAddressHeader": "X-OCC-Client-IP" },
        /cannot be x-occ-client-ip/,
      ],
      [
        "the cookie header as a client address",
        { ...trustedProxyValues, "api.trustedProxy.clientAddressHeader": "cookie" },
        /cannot be cookie/,
      ],
      [
        "a structured Forwarded header as a client address",
        { ...trustedProxyValues, "api.trustedProxy.clientAddressHeader": "Forwarded" },
        /cannot be forwarded/,
      ],
      [
        "a client-address header list",
        {
          ...trustedProxyValues,
          "api.trustedProxy.clientAddressHeader": "x-real-ip x-forwarded-for",
        },
        /single HTTP header name/,
      ],
      [
        "a client-address header longer than the controller accepts",
        {
          "api.trustedProxy.preset": "generic",
          "api.trustedProxy.cidrs[0]": "10.42.0.0/16",
          "api.trustedProxy.clientAddressHeader": `x-${"a".repeat(63)}`,
        },
        /single HTTP header name of at most 64 characters/,
      ],
      [
        "an API key header as a client address",
        {
          "api.trustedProxy.preset": "generic",
          "api.trustedProxy.cidrs[0]": "10.42.0.0/16",
          "api.trustedProxy.clientAddressHeader": "X-API-Key",
        },
        /cannot be x-api-key/,
      ],
      [
        "a named preset with another client-address header",
        { ...trustedProxyValues, "api.trustedProxy.clientAddressHeader": "X-Real-IP" },
        /ingress-nginx reads x-forwarded-for; use the generic preset for x-real-ip/,
      ],
    ]) {
      await assert.rejects(
        render(override),
        ({ code, stderr }) => code !== 0 && message.test(stderr),
        description,
      );
    }
  },
);

test("the chart refuses administrator emails the bootstrap Job refuses", tooling, async () => {
  const message = /bootstrap\.adminEmail must contain a valid administrator email/;
  for (const email of [
    "",
    " ",
    "not-an-email",
    "a@b",
    "a@b.",
    "a@.com",
    "a@b c.com",
    "a@b\u00A0c.com",
    "a@b\u000Bc.com",
  ]) {
    await assert.rejects(
      render({}, { strings: { "bootstrap.adminEmail": email } }),
      ({ code, stderr }) => code !== 0 && message.test(stderr),
      JSON.stringify(email),
    );
  }
  for (const email of [
    "admin@example.invalid",
    " Admin@Example.COM ",
    "a@b.com ",
    "\nadmin@example.com",
    "\uFEFFadmin@example.com",
    "\u0085a@b.com",
  ]) {
    const { stdout } = await render({}, { strings: { "bootstrap.adminEmail": email } });
    const objects = await resources(stdout);
    const job = objects.find(
      (object) =>
        object.kind === "Job" &&
        object.metadata.labels?.["app.kubernetes.io/component"] === "initialization",
    );
    const value = job.spec.template.spec.containers
      .find((container) => container.name === "bootstrap")
      .env.find((entry) => entry.name === "OCC_BOOTSTRAP_ADMIN_EMAIL").value;
    assert.equal(value, email);
  }
});

test("the chart refuses bootstrap claim names the volume helper refuses", tooling, async () => {
  const message =
    /bootstrap\.password\.claimName must be a DNS subdomain of at most 253 characters/;
  // This is Kubernetes' 253-character object-name limit, not a DNS hostname limit.
  const longest = "a".repeat(253);
  for (const claimName of ["Bootstrap", "claim_name", "claim-", `.claim`, `${"a".repeat(254)}`]) {
    await assert.rejects(
      render({}, { strings: { "bootstrap.password.claimName": claimName } }),
      ({ code, stderr }) => code !== 0 && message.test(stderr),
      JSON.stringify(claimName),
    );
  }
  const { stdout } = await render({}, { strings: { "bootstrap.password.claimName": longest } });
  const objects = await resources(stdout);
  const job = objects.find(
    (object) =>
      object.kind === "Job" &&
      object.metadata.labels?.["app.kubernetes.io/component"] === "initialization",
  );
  const claim = job.spec.template.spec.volumes.find(
    (volume) => volume.name === "bootstrap-password-output",
  ).persistentVolumeClaim.claimName;
  assert.equal(claim, longest);
  assert.equal(longest.length, 253);
});

test(
  "the chart refuses a gateway API key Secret that holds other credentials",
  tooling,
  async () => {
    // Envoy Gateway's apiKeyAuth accepts every entry of the gateway API key Secret as a
    // client key, so a shared Secret would make the ChatGPT admin key, a CA certificate or a
    // TLS key a valid x-api-key.
    for (const [values, shared, refusal] of [
      [
        chatgptValues,
        { "gatewayRouting.apiKeySecretName": "occ-chatgpt-admin" },
        /gatewayRouting\.apiKeySecretName must name a dedicated Secret; occ-chatgpt-admin is also backend\.chatgpt\.secretName/,
      ],
      [
        chatgptValues,
        { "backend.chatgpt.secretName": "occ-gateway-api-key" },
        /gatewayRouting\.apiKeySecretName must name a dedicated Secret; occ-gateway-api-key is also backend\.chatgpt\.secretName/,
      ],
      [
        databaseCaValues,
        { "database.caSecretName": "occ-gateway-api-key" },
        /gatewayRouting\.apiKeySecretName must name a dedicated Secret; occ-gateway-api-key is also database\.caSecretName/,
      ],
      [
        sandboxValues,
        { "gatewayRouting.sandbox.tlsSecretName": "occ-gateway-api-key" },
        /gatewayRouting\.apiKeySecretName must name a dedicated Secret; occ-gateway-api-key is also gatewayRouting\.sandbox\.tlsSecretName/,
      ],
    ]) {
      await assert.rejects(
        render({ ...gatewayRoutingValues, ...values, ...shared }),
        ({ code, stderr }) => code !== 0 && refusal.test(stderr),
        JSON.stringify(shared),
      );
      // The same values with distinct names render.
      await render({ ...gatewayRoutingValues, ...values });
    }
    // Without the ChatGPT Backend the chart does not reserve that name.
    await render({
      ...gatewayRoutingValues,
      "gatewayRouting.apiKeySecretName": "occ-chatgpt-admin",
    });
  },
);

test(
  "the chart refuses sign-in Secrets that share a Gateway certificate Secret",
  tooling,
  async () => {
    // cert-manager writes the generated Gateway TLS and root CA Secrets and would overwrite a
    // sign-in Secret sharing either name (finding 1046).
    const gatewayRoot = `occ-gateway-${createHash("sha256").update("openclaw-system/oce-agent-gateways").digest("hex").slice(0, 12)}-root`;
    const externalCa = {
      ...externalGatewayRoutingValues,
      "gatewayRouting.issuerRef.kind": "ClusterIssuer",
      "gatewayRouting.issuerRef.group": "cert-manager.io",
      "gatewayRouting.caSecretName": "occ-private-ca",
      "gatewayRouting.caSecretKey": "ca.crt",
    };
    for (const [routing, secret, role] of [
      [gatewayRoutingValues, "oce-agent-gateways-tls", "gatewayRouting.tlsSecretName"],
      [gatewayRoutingValues, gatewayRoot, "the generated Gateway root CA"],
      [externalCa, "occ-private-ca", "gatewayRouting.caSecretName"],
    ]) {
      await assert.rejects(
        render({ ...routing, ...githubLoginValues, "auth.github.secretName": secret }),
        ({ code, stderr }) =>
          code !== 0 &&
          stderr.includes(
            `auth.github.secretName must name a dedicated Secret; ${secret} is also ${role}`,
          ),
        secret,
      );
      // Without gateway routing those names are free.
      await render({ ...githubLoginValues, "auth.github.secretName": secret });
    }
    await render({ ...externalCa, ...githubLoginValues });
  },
);

test(
  "the chart refuses credential Secrets shared with the database CA or sandbox TLS Secret",
  tooling,
  async () => {
    // Finding 1048: the dedicated-Secret rule covers every Secret an enabled feature reads.
    const sandbox = {
      ...gatewayRoutingValues,
      ...Object.fromEntries(
        Object.entries(sandboxValues).filter(([key]) => key.startsWith("gatewayRouting.sandbox.")),
      ),
    };
    for (const [base, setting, secret, other] of [
      [
        { ...databaseCaValues, ...githubLoginValues },
        "auth.github.secretName",
        "occ-rds-ca",
        "database.caSecretName",
      ],
      [
        { ...databaseCaValues, ...repositoryCredentialValues },
        "repositoryCredentials.appKeySecretName",
        "occ-rds-ca",
        "database.caSecretName",
      ],
      [databaseCaValues, "database.caSecretName", "occ-database", "database.secretName"],
      [
        { ...sandbox, ...githubLoginValues },
        "auth.github.secretName",
        "preview-wildcard",
        "gatewayRouting.sandbox.tlsSecretName",
      ],
      [
        { ...sandbox, ...repositoryCredentialValues },
        "repositoryCredentials.tlsSecretName",
        "preview-wildcard",
        "gatewayRouting.sandbox.tlsSecretName",
      ],
      [
        sandbox,
        "gatewayRouting.sandbox.tlsSecretName",
        "oce-agent-gateways-tls",
        "gatewayRouting.tlsSecretName",
      ],
    ]) {
      await assert.rejects(
        render({ ...base, [setting]: secret }),
        ({ code, stderr }) =>
          code !== 0 &&
          stderr.includes(`${setting} must name a dedicated Secret; ${secret} is also ${other}`),
        `${setting} = ${secret}`,
      );
      // The same values with distinct names render.
      await render(base);
    }
  },
);

test(
  "the real Helm renderer rejects mutable images, broad dependencies, and shared credentials",
  tooling,
  async () => {
    // Helm accepts dotted and overlong --namespace values, but Kubernetes
    // Namespace admission requires a single DNS-1123 label of at most 63.
    for (const namespace of ["openclaw.system", "a".repeat(64), "a".repeat(253)]) {
      await assert.rejects(
        render({}, { namespace }),
        /Helm release namespace must be a DNS-1123 label of at most 63 characters/,
      );
    }
    for (const namespace of ["1system", "0", "a".repeat(63)]) {
      const objects = await resources(
        (await render(externalGatewayRoutingValues, { namespace })).stdout,
      );
      const gateway = objects.find((object) => object.kind === "Gateway");
      assert.equal(gateway.metadata.namespace, namespace);
    }
    for (const [description, override] of [
      ["mutable controller", { "images.controller": "registry.example/controller:latest" }],
      ["missing Better Auth secret", { "auth.secretName": "" }],
      ["missing bootstrap admin email", { "bootstrap.adminEmail": "" }],
      ["missing bootstrap password claim", { "bootstrap.password.claimName": "" }],
      ["nested bootstrap password file", { "bootstrap.password.fileName": "nested/password" }],
      ["missing bootstrap service key file", { "bootstrap.serviceKey.fileName": "" }],
      ["nested bootstrap service key file", { "bootstrap.serviceKey.fileName": "nested/key.json" }],
      [
        "shared bootstrap output file",
        { "bootstrap.serviceKey.fileName": "initial-admin-password" },
      ],
      ["unrestricted client namespace", { "api.clients[0].namespace": "" }],
      ["retired database egress key", { "database.cidr": "10.45.0.12/32" }],
      ["retired Kubernetes API egress key", { "cluster.cidr": "10.43.0.1/32" }],
      ["missing database egress list", { "database.cidrs": "" }],
      ["missing Kubernetes API egress list", { "cluster.cidrs": "" }],
      ["broad database egress", { "database.cidrs[0]": "0.0.0.0/0" }],
      ["database egress that is not an IPv4 host", { "database.cidrs[0]": "999.1.2.3/32" }],
      ["database egress with a leading-zero octet", { "database.cidrs[0]": "01.2.3.4/32" }],
      ["broad Kubernetes API egress", { "cluster.cidrs[0]": "10.43.0.0/16" }],
      ["Kubernetes API egress that is not an IPv4 host", { "cluster.cidrs[0]": "256.0.0.1/32" }],
      ["Kubernetes API egress with a leading-zero octet", { "cluster.cidrs[0]": "01.2.3.4/32" }],
      ["invalid control-plane node selector", { "controlPlane.nodeSelector": "control" }],
      ["false control-plane node selector", { "controlPlane.nodeSelector": false }],
      [
        "invalid database CA key",
        { "database.caSecretName": "occ-rds-ca", "database.caKey": "../ca.pem" },
      ],
      ["shared migration database credentials", { "database.migrationUrlKey": "application-url" }],
      [
        "retired ChatGPT integration key",
        {
          "integrations.chatgpt.enabled": "true",
          "integrations.chatgpt.providerCidr": "198.51.100.25/32",
        },
      ],
      [
        "unrestricted ChatGPT provider egress",
        { ...chatgptValues, "backend.chatgpt.providerCidr": "0.0.0.0/0" },
      ],
      [
        "ChatGPT provider host that is not an IPv4 address",
        { ...chatgptValues, "backend.chatgpt.providerCidr": "999.1.2.3/32" },
      ],
      [
        "ChatGPT provider host with a leading-zero octet",
        { ...chatgptValues, "backend.chatgpt.providerCidr": "01.2.3.4/32" },
      ],
      [
        "ChatGPT Backend without an approved provider host",
        { ...chatgptValues, "backend.chatgpt.providerCidr": "" },
      ],
      [
        "ChatGPT admin key shared with installation configuration",
        { ...chatgptValues, "backend.chatgpt.secretName": "occ-installation-startup" },
      ],
      [
        "ChatGPT Backend without an admin Secret key",
        { ...chatgptValues, "backend.chatgpt.key": "" },
      ],
      [
        "Agent native admin enabled without a public DNS suffix",
        { "agentNativeAdmin.enabled": "true" },
      ],
      [
        "Agent native admin configured with a wildcard DNS suffix",
        { ...agentNativeAdminValues, "agentNativeAdmin.domain": "*.example.invalid" },
      ],
      [
        "Agent native admin configured with a URL",
        { ...agentNativeAdminValues, "agentNativeAdmin.domain": "https://agents.example.invalid" },
      ],
      [
        "Agent native admin enabled without private Gateway routing",
        {
          "agentNativeAdmin.enabled": "true",
          "agentNativeAdmin.domain": "agents.example.invalid",
        },
      ],
      [
        "retired workspace-files endpoint ConfigMap",
        { "workspaceFiles.configMapName": "operator-agent-endpoints" },
      ],
      [
        "private Envoy Gateway without an existing GatewayClass",
        {
          "gatewayRouting.enabled": "true",
          "gatewayRouting.apiKeySecretName": "occ-gateway-api-key",
        },
      ],
      [
        "private Envoy Gateway without an Envoy namespace",
        { ...gatewayRoutingValues, "gatewayRouting.envoyNamespace": "" },
      ],
      [
        "private Envoy Gateway without an operator-created API-key Secret",
        { ...gatewayRoutingValues, "gatewayRouting.apiKeySecretName": "" },
      ],
      [
        "private Envoy Gateway sharing the Better Auth Secret",
        { ...gatewayRoutingValues, "gatewayRouting.apiKeySecretName": "occ-auth" },
      ],
      [
        "private Envoy Gateway with manual CA trust but generated issuer",
        {
          ...gatewayRoutingValues,
          "gatewayRouting.caSecretName": "occ-private-ca",
          "gatewayRouting.caSecretKey": "ca.crt",
        },
      ],
      [
        "private Envoy Gateway with an incomplete private CA Secret",
        { ...externalGatewayRoutingValues, "gatewayRouting.caSecretName": "occ-private-ca" },
      ],
      [
        "private Envoy Gateway with leaf TLS colliding with installation Secret",
        { ...gatewayRoutingValues, "gatewayRouting.tlsSecretName": "occ-installation-startup" },
      ],
      [
        "private Envoy Gateway with leaf TLS colliding with database Secret",
        { ...gatewayRoutingValues, "gatewayRouting.tlsSecretName": "occ-database" },
      ],
      [
        "private Envoy Gateway with leaf TLS colliding with Better Auth Secret",
        { ...gatewayRoutingValues, "gatewayRouting.tlsSecretName": "occ-auth" },
      ],
      [
        "private Envoy Gateway with leaf TLS colliding with ChatGPT provider Secret",
        {
          ...gatewayRoutingValues,
          ...chatgptValues,
          "gatewayRouting.tlsSecretName": "occ-chatgpt-admin",
        },
      ],
      [
        "private Envoy Gateway with external CA trust colliding with leaf TLS Secret",
        {
          ...externalGatewayRoutingValues,
          "gatewayRouting.caSecretName": "oce-agent-gateways-tls",
          "gatewayRouting.caSecretKey": "ca.crt",
        },
      ],
      [
        "private Envoy Gateway with generated root CA colliding with leaf TLS Secret",
        {
          ...gatewayRoutingValues,
          "gatewayRouting.tlsSecretName": rootSecretName("openclaw-system", "oce-agent-gateways"),
        },
      ],
      [
        "private Envoy Gateway with an invalid tenant gateway port",
        { ...gatewayRoutingValues, "gatewayRouting.tenantGatewayPort": "0" },
      ],
      [
        "private Envoy Gateway with an invalid Envoy HTTPS target port",
        { ...gatewayRoutingValues, "gatewayRouting.envoyHttpsTargetPort": "0" },
      ],
    ]) {
      // Rejection comes from the actual Helm templates, not a reimplemented test validator.
      await assert.rejects(
        render(override),
        ({ code, stderr }) => code !== 0 && stderr.length > 0,
        description,
      );
    }
    // OCI SHA-256 digests are `sha256` and lowercase hex; containerd refuses other
    // spellings at pull time. The uppercase algorithm was already refused; uppercase hex
    // was not.
    for (const image of [
      `registry.example/controller@sha256:${"A".repeat(64)}`,
      `registry.example/controller@SHA256:${"a".repeat(64)}`,
      `registry.example.invalid/foo+bar@sha256:${"a".repeat(64)}`,
    ]) {
      await assert.rejects(
        render({ "images.controller": image }),
        ({ code, stderr }) =>
          code !== 0 &&
          stderr.includes(
            "images.controller must be an approved immutable SHA-256 image reference",
          ),
        image,
      );
    }
    const underscored = `registry.example.invalid/foo_bar@sha256:${"a".repeat(64)}`;
    assert.match((await render({ "images.controller": underscored })).stdout, /foo_bar@sha256:/);
  },
);

test("the chart refuses a relative bootstrap mount path the Job refuses", tooling, async () => {
  const message = /bootstrap\.password\.mountPath must be an absolute path/;
  for (const mountPath of ["bootstrap", "./bootstrap", " bootstrap"]) {
    await assert.rejects(
      render({}, { strings: { "bootstrap.password.mountPath": mountPath } }),
      ({ code, stderr }) => code !== 0 && message.test(stderr),
      JSON.stringify(mountPath),
    );
  }
  const { stdout } = await render();
  assert.match(stdout, /value: "\/var\/lib\/openclaw\/bootstrap\/initial-admin-password"/);
});

test(
  "Gateway membership selectors keep a numeric-looking route label a string",
  tooling,
  async () => {
    // sha256("tenant-407/oce-agent-gateways") starts with 8006922111e0, which YAML
    // reads as a float unless the template quotes it; the API rejects a non-string label.
    const namespace = "tenant-407";
    const label = routeNamespaceLabel(namespace, "oce-agent-gateways");
    assert.match(label, /^[0-9]+e[0-9]+$/);
    const objects = await resources(
      (await render({ ...gatewayRoutingValues, ...slackProxyValues }, { namespace })).stdout,
    );
    const values = [];
    const collect = (value) => {
      if (Array.isArray(value)) {
        value.forEach(collect);
      } else if (value !== null && typeof value === "object") {
        for (const [key, nested] of Object.entries(value)) {
          if (key === "openclaw-enterprise.io/gateway") {
            values.push(nested);
          } else {
            collect(nested);
          }
        }
      }
    };
    collect(objects);
    assert.ok(values.length >= 5);
    assert.deepEqual(new Set(values), new Set([label]));
  },
);

// Kubernetes names, namespaces, Secret keys and label values are strings. Collect every
// one that a numeric- or boolean-looking value could reach so a missing quote fails here.
function nonStringIdentifiers(objects) {
  const identifierKeys = new Set(["name", "namespace", "secretName", "key", "claimName"]);
  const labelMaps = new Set(["labels", "matchLabels", "selector"]);
  const found = [];
  const visit = (value, path, parentKey) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`, parentKey));
    } else if (value !== null && typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) {
        const nestedPath = `${path}.${key}`;
        if (
          (identifierKeys.has(key) || labelMaps.has(parentKey)) &&
          (nested === null || typeof nested !== "object") &&
          typeof nested !== "string"
        ) {
          found.push(`${nestedPath}=${JSON.stringify(nested)}`);
        }
        visit(nested, nestedPath, key);
      }
    }
  };
  for (const object of objects) {
    visit(object, `${object.kind}/${object.metadata.name}`, undefined);
  }
  return found;
}

test(
  "numeric- and boolean-looking names, keys and namespaces render as strings",
  tooling,
  async () => {
    const features = {
      ...productionCollectorValues,
      ...slackProxyValues,
      ...chatgptValues,
      ...repositoryCredentialValues,
      ...gatewayRoutingValues,
      ...databaseCaValues,
      "gatewayRouting.sandbox.enabled": "true",
      "gatewayRouting.sandbox.domain": "previews.example.test",
      "gatewayRouting.sandbox.ingressPeers[0].ipBlock.cidr": "0.0.0.0/0",
      "agentNativeAdmin.enabled": "true",
      "agentNativeAdmin.domain": "agents.example.invalid",
      "agentNativeAdmin.sharedCookieDomain": "example.invalid",
      "executionCluster.enabled": "true",
      "executionCluster.apiCidrs[0]": "10.44.0.2/32",
    };
    // Every value is a valid Kubernetes name or Secret key that plain YAML reads as a
    // number, boolean or null.
    const strings = {
      "installation.secretName": "407",
      "installation.key": "true",
      "auth.secretName": "1e3",
      "auth.secretKey": "1",
      "database.secretName": "null",
      "database.appUrlKey": "2",
      "database.migrationUrlKey": "3",
      "database.caSecretName": "on",
      "database.caKey": "4",
      "backend.chatgpt.secretName": "1.5",
      "backend.chatgpt.key": "off",
      "bootstrap.password.claimName": "408",
      "api.clients[0].namespace": "2024",
      "dns.namespace": "true",
      "gatewayRouting.gatewayName": "409",
      "gatewayRouting.envoyNamespace": "1e4",
      "gatewayRouting.apiKeySecretName": "false",
      "gatewayRouting.tlsSecretName": "1e5",
      "gatewayRouting.sandbox.tlsSecretName": "yes",
      "repositoryCredentials.serviceName": "no",
      "repositoryCredentials.serviceConfigSecretName": "11",
      "repositoryCredentials.serviceConfigKey": "true",
      "repositoryCredentials.appKeySecretName": "12",
      "repositoryCredentials.appKeyKey": "5",
      "repositoryCredentials.tlsSecretName": "13",
      "repositoryCredentials.publicCaSecretName": "14",
      "repositoryCredentials.publicCaKey": "6",
      "repositoryCredentials.registryConfigMapName": "15",
      "repositoryCredentials.registryKey": "7",
      "slackProxy.serviceName": "y",
      "executionCluster.apiKubeconfigSecretName": "21",
      "executionCluster.workerKubeconfigSecretName": "22",
      "executionCluster.kubeconfigKey": "true",
      "logging.collector.configSecretName": "31",
      "logging.collector.envSecretName": "32",
    };
    for (const [release, namespace] of [
      ["407", "1e3"],
      ["true", "null"],
    ]) {
      const objects = await resources(
        (await render(features, { release, namespace, strings })).stdout,
      );
      assert.ok(objects.length > 40);
      assert.deepEqual(nonStringIdentifiers(objects), [], `${release}/${namespace}`);
    }

    const execution = await resources(
      (
        await execute(
          helm,
          [
            "template",
            "407",
            "deploy/helm/openclaw-execution",
            "--namespace",
            "1e3",
            "--set",
            "routing.hostname=agents.example.invalid",
            "--set",
            "routing.gatewayClassName=private-envoy-gateway",
            "--set",
            "routing.tlsSecretName=agents-tls",
            "--set",
            "routing.controlPlaneCidrs[0]=198.51.100.0/24",
            "--set-string",
            "routing.gatewayName=409",
            "--set-string",
            "routing.envoyNamespace=1e4",
            "--set-string",
            "dns.namespace=true",
          ],
          { cwd: repository, maxBuffer: 2_000_000 },
        )
      ).stdout,
    );
    assert.deepEqual(nonStringIdentifiers(execution), []);
  },
);

test(
  "private Envoy Gateway routing renders automatic CA and deterministic default hostnames",
  tooling,
  async () => {
    const gatewayName = "oce-agent-gateways";
    const gatewayNamespace = "openclaw-system";
    const envoyNamespace = "envoy-gateway-system";
    const label = routeNamespaceLabel(gatewayNamespace, gatewayName);
    const serviceName = gatewayServiceName(gatewayNamespace, gatewayName);
    const hostname = defaultGatewayHostname(gatewayNamespace, gatewayName, envoyNamespace);
    const rootSecret = rootSecretName(gatewayNamespace, gatewayName);
    const configured = await resources(
      (await render({ ...gatewayRoutingValues, ...controlPlaneSelectorValues })).stdout,
    );
    const alternateNamespace = "openclaw-alt";
    const alternateObjects = await resources(
      (await render(gatewayRoutingValues, { namespace: alternateNamespace })).stdout,
    );
    const envoyPolicyName = envoyNetworkPolicyName("oce", gatewayNamespace, gatewayName);
    const alternateEnvoyPolicyName = envoyNetworkPolicyName("oce", alternateNamespace, gatewayName);
    assert.notEqual(envoyPolicyName, alternateEnvoyPolicyName);
    assert.match(envoyPolicyName, /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    assert.ok(envoyPolicyName.length <= 63);
    assert.ok(
      alternateObjects.some(
        ({ kind, metadata }) =>
          kind === "NetworkPolicy" &&
          metadata.namespace === envoyNamespace &&
          metadata.name === alternateEnvoyPolicyName,
      ),
    );

    const deployment = (component) =>
      configured.find(
        ({ kind, metadata }) =>
          kind === "Deployment" && metadata.labels["app.kubernetes.io/component"] === component,
      );

    for (const component of ["api", "worker"]) {
      const pod = deployment(component).spec.template.spec;
      const apiKeyVolume = pod.volumes.find(({ name }) => name === "gateway-api-key");
      const caVolume = pod.volumes.find(({ name }) => name === "gateway-ca");
      const apiKeyMount = pod.containers[0].volumeMounts.find(
        ({ name }) => name === "gateway-api-key",
      );
      const caMount = pod.containers[0].volumeMounts.find(({ name }) => name === "gateway-ca");
      const apiKeyPath = pod.containers[0].env.find(
        ({ name }) => name === "OCC_GATEWAY_API_KEY_PATH",
      );
      const caPath = pod.containers[0].env.find(({ name }) => name === "NODE_EXTRA_CA_CERTS");
      assert.deepEqual(apiKeyVolume.secret, {
        secretName: "occ-gateway-api-key",
        items: [{ key: "occ", path: "key" }],
      });
      assert.deepEqual(caVolume.secret, {
        secretName: rootSecret,
        items: [{ key: "tls.crt", path: "ca.crt" }],
      });
      assert.deepEqual(apiKeyMount, {
        name: "gateway-api-key",
        mountPath: "/etc/openclaw/gateway-api-key",
        readOnly: true,
      });
      assert.deepEqual(caMount, {
        name: "gateway-ca",
        mountPath: "/etc/openclaw/gateway-ca",
        readOnly: true,
      });
      assert.equal(apiKeyPath.value, "/etc/openclaw/gateway-api-key/key");
      assert.equal(caPath.value, "/etc/openclaw/gateway-ca/ca.crt");
    }

    const envoyProxy = configured.find(({ kind }) => kind === "EnvoyProxy");
    assert.equal(envoyProxy.metadata.name, gatewayName);
    assert.equal(envoyProxy.metadata.namespace, gatewayNamespace);
    // The credential-checking proxy must stay on the trusted control-plane pool.
    assert.deepEqual(envoyProxy.spec.provider.kubernetes.envoyDeployment?.pod?.nodeSelector, {
      "oce-role": "control",
    });
    assert.deepEqual(envoyProxy.spec.provider.kubernetes.envoyService, {
      name: serviceName,
      type: "ClusterIP",
    });

    const gateway = configured.find(({ kind }) => kind === "Gateway");
    assert.equal(gateway.metadata.name, gatewayName);
    assert.equal(gateway.metadata.namespace, gatewayNamespace);
    assert.equal(gateway.spec.gatewayClassName, "private-envoy-gateway");
    assert.equal(gateway.spec.listeners[0].hostname, hostname);
    assert.deepEqual(gateway.spec.listeners[0].allowedRoutes, {
      namespaces: {
        from: "Selector",
        selector: { matchLabels: { "openclaw-enterprise.io/gateway": label } },
      },
      kinds: [{ group: "gateway.networking.k8s.io", kind: "HTTPRoute" }],
    });

    const bootstrapIssuer = configured.find(
      ({ kind, metadata }) => kind === "Issuer" && metadata.name === `${serviceName}-bootstrap`,
    );
    assert.deepEqual(bootstrapIssuer.spec, { selfSigned: {} });
    const caIssuer = configured.find(
      ({ kind, metadata }) => kind === "Issuer" && metadata.name === `${serviceName}-ca`,
    );
    assert.deepEqual(caIssuer.spec, { ca: { secretName: rootSecret } });

    const rootCertificate = configured.find(
      ({ kind, metadata }) => kind === "Certificate" && metadata.name === rootSecret,
    );
    assert.deepEqual(rootCertificate.spec, {
      isCA: true,
      commonName: rootSecret,
      secretName: rootSecret,
      duration: "87600h",
      renewBefore: "720h",
      privateKey: { algorithm: "ECDSA", size: 256, rotationPolicy: "Never" },
      issuerRef: { name: `${serviceName}-bootstrap`, kind: "Issuer", group: "cert-manager.io" },
    });

    const leafCertificate = configured.find(
      ({ kind, metadata }) => kind === "Certificate" && metadata.name === `${gatewayName}-tls`,
    );
    assert.deepEqual(leafCertificate.spec, {
      secretName: `${gatewayName}-tls`,
      duration: "2160h",
      renewBefore: "720h",
      dnsNames: [hostname],
      issuerRef: { name: `${serviceName}-ca`, kind: "Issuer", group: "cert-manager.io" },
    });

    const securityPolicy = configured.find(({ kind }) => kind === "SecurityPolicy");
    assert.deepEqual(securityPolicy.spec, {
      targetRefs: [{ group: "gateway.networking.k8s.io", kind: "Gateway", name: gatewayName }],
      apiKeyAuth: {
        credentialRefs: [{ group: "", kind: "Secret", name: "occ-gateway-api-key" }],
        extractFrom: [{ headers: ["x-api-key"] }],
        sanitize: true,
      },
    });

    const dataplaneLabels = {
      "app.kubernetes.io/component": "proxy",
      "app.kubernetes.io/managed-by": "envoy-gateway",
      "app.kubernetes.io/name": "envoy",
      "gateway.envoyproxy.io/owning-gateway-namespace": gatewayNamespace,
      "gateway.envoyproxy.io/owning-gateway-name": gatewayName,
    };
    const apiEnvoyEgress = configured.find(
      ({ kind, metadata }) =>
        kind === "NetworkPolicy" && metadata.name === "openclaw-enterprise-controller-envoy-egress",
    );
    assert.equal(apiEnvoyEgress.metadata.namespace, gatewayNamespace);
    assert.deepEqual(apiEnvoyEgress.spec.podSelector.matchLabels, {
      "app.kubernetes.io/name": "openclaw-enterprise",
      "app.kubernetes.io/instance": "oce",
    });
    assert.deepEqual(apiEnvoyEgress.spec.podSelector.matchExpressions, [
      { key: "app.kubernetes.io/component", operator: "In", values: ["api", "worker"] },
    ]);
    assert.deepEqual(apiEnvoyEgress.spec.egress, [
      {
        to: [
          {
            namespaceSelector: {
              matchLabels: { "kubernetes.io/metadata.name": envoyNamespace },
            },
            podSelector: { matchLabels: dataplaneLabels },
          },
        ],
        ports: [{ protocol: "TCP", port: 10443 }],
      },
    ]);

    const envoyPolicy = configured.find(
      ({ kind, metadata }) => kind === "NetworkPolicy" && metadata.name === envoyPolicyName,
    );
    assert.equal(envoyPolicy.metadata.namespace, envoyNamespace);
    assert.deepEqual(envoyPolicy.spec.podSelector.matchLabels, dataplaneLabels);
    assert.deepEqual(envoyPolicy.spec.ingress, [
      {
        from: [
          {
            namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": gatewayNamespace } },
            podSelector: {
              matchLabels: {
                "app.kubernetes.io/name": "openclaw-enterprise",
                "app.kubernetes.io/instance": "oce",
              },
              matchExpressions: [
                { key: "app.kubernetes.io/component", operator: "In", values: ["api", "worker"] },
              ],
            },
          },
          {
            namespaceSelector: { matchLabels: { "openclaw-enterprise.io/gateway": label } },
            podSelector: { matchLabels: { "openclaw.dev/workload-role": "agent" } },
          },
          {
            namespaceSelector: { matchLabels: { "openclaw-enterprise.io/gateway": label } },
            podSelector: { matchLabels: { "openshell.ai/boundary-role": "supervisor" } },
          },
        ],
        ports: [{ protocol: "TCP", port: 10443 }],
      },
    ]);
    assert.deepEqual(envoyPolicy.spec.egress, [
      {
        to: [
          {
            namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
            podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
          },
        ],
        ports: [
          { protocol: "UDP", port: 53 },
          { protocol: "TCP", port: 53 },
          { protocol: "UDP", port: 5353 },
          { protocol: "TCP", port: 5353 },
        ],
      },
      {
        to: [
          {
            namespaceSelector: { matchLabels: { "openclaw-enterprise.io/gateway": label } },
            podSelector: { matchLabels: { "openclaw.dev/workload-role": "gateway" } },
          },
        ],
        ports: [{ protocol: "TCP", port: 8080 }],
      },
      {
        to: [
          {
            namespaceSelector: {
              matchLabels: { "kubernetes.io/metadata.name": envoyNamespace },
            },
            podSelector: {
              matchLabels: {
                "control-plane": "envoy-gateway",
                "app.kubernetes.io/name": "gateway-helm",
              },
            },
          },
        ],
        ports: [{ protocol: "TCP", port: 18000 }],
      },
    ]);

    const roles = configured.filter(({ kind }) => kind === "ClusterRole");
    const tenantWorker = roles.find(({ metadata }) =>
      metadata.name.endsWith("-openclaw-tenant-worker"),
    );
    const tenantApi = roles.find(({ metadata }) => metadata.name.endsWith("-openclaw-tenant-api"));
    assert.deepEqual(
      tenantWorker.rules.find(({ resources }) => resources.includes("secrets")),
      { apiGroups: [""], resources: ["secrets"], verbs: ["get", "create", "update", "delete"] },
    );
    assert.ok(
      !configured.some(
        ({ kind, roleRef }) =>
          kind === "ClusterRoleBinding" && roleRef.name === tenantWorker.metadata.name,
      ),
    );
    assert.deepEqual(
      tenantWorker.rules.find(({ resources }) => resources.includes("httproutes")),
      {
        apiGroups: ["gateway.networking.k8s.io"],
        resources: ["httproutes"],
        verbs: ["get", "create", "patch", "delete"],
      },
    );
    assert.ok(!tenantApi.rules.some(({ resources }) => resources.includes("httproutes")));
    assert.equal(
      configured.some(({ kind }) => kind === "ConfigMap"),
      false,
    );
    assert.equal(
      configured.some(({ kind }) => kind === "Secret"),
      false,
    );
  },
);

test(
  "private Envoy Gateway routing preserves explicit hostnames and external CA trust",
  tooling,
  async () => {
    const configured = await resources(
      (
        await render({
          ...externalGatewayRoutingValues,
          "gatewayRouting.caSecretName": "occ-private-ca",
          "gatewayRouting.caSecretKey": "ca.crt",
        })
      ).stdout,
    );
    const gatewayName = "oce-agent-gateways";
    const gatewayNamespace = "openclaw-system";
    const serviceName = gatewayServiceName(gatewayNamespace, gatewayName);
    const apiPod = configured.find(
      ({ kind, metadata }) =>
        kind === "Deployment" && metadata.labels["app.kubernetes.io/component"] === "api",
    ).spec.template.spec;
    const workerPod = configured.find(
      ({ kind, metadata }) =>
        kind === "Deployment" && metadata.labels["app.kubernetes.io/component"] === "worker",
    ).spec.template.spec;

    assert.deepEqual(apiPod.volumes.find(({ name }) => name === "gateway-ca").secret, {
      secretName: "occ-private-ca",
      items: [{ key: "ca.crt", path: "ca.crt" }],
    });
    assert.equal(
      apiPod.containers[0].env.find(({ name }) => name === "NODE_EXTRA_CA_CERTS").value,
      "/etc/openclaw/gateway-ca/ca.crt",
    );
    assert.deepEqual(
      workerPod.volumes.find(({ name }) => name === "gateway-ca").secret,
      apiPod.volumes.find(({ name }) => name === "gateway-ca").secret,
    );
    assert.equal(
      workerPod.containers[0].env.find(({ name }) => name === "NODE_EXTRA_CA_CERTS").value,
      "/etc/openclaw/gateway-ca/ca.crt",
    );
    assert.equal(
      configured.some(
        ({ kind, metadata }) =>
          kind === "Certificate" && metadata.name === rootSecretName(gatewayNamespace, gatewayName),
      ),
      false,
    );
    assert.equal(
      configured.some(
        ({ kind, metadata }) => kind === "Issuer" && metadata.name === `${serviceName}-ca`,
      ),
      false,
    );

    const gateway = configured.find(({ kind }) => kind === "Gateway");
    assert.equal(gateway.spec.listeners[0].hostname, "agents.example.internal");
    const leafCertificate = configured.find(
      ({ kind, metadata }) => kind === "Certificate" && metadata.name === `${gatewayName}-tls`,
    );
    assert.deepEqual(leafCertificate.spec, {
      secretName: `${gatewayName}-tls`,
      duration: "2160h",
      renewBefore: "720h",
      dnsNames: ["agents.example.internal"],
      issuerRef: {
        name: "occ-private-issuer",
        kind: "ClusterIssuer",
        group: "cert-manager.io",
      },
    });
    const envoyProxy = configured.find(({ kind }) => kind === "EnvoyProxy");
    assert.equal(envoyProxy.spec.provider.kubernetes.envoyDeployment, undefined);
    assert.deepEqual(envoyProxy.spec.provider.kubernetes.envoyService, {
      name: serviceName,
      type: "ClusterIP",
    });
  },
);

test("Helm rejects worker timings the worker process rejects", tooling, async () => {
  for (const [key, value] of [
    ["worker.pollIntervalMs", "0"],
    ["worker.pollIntervalMs", "abc"],
    ["worker.leaseDurationMs", "1.5"],
    ["worker.maxAttempts", "-1"],
    ["worker.convergenceTimeoutMs", "9007199254740993"],
  ]) {
    await assert.rejects(render({ [key]: value }), /must be a positive safe integer/);
  }
  const rendered = await render({ "worker.pollIntervalMs": "010" });
  assert.match(rendered.stdout, /name: OCC_WORKER_POLL_INTERVAL_MS\n\s+value: "010"/);
});

test("Helm renders a values-file worker timeout of 1800000 as digits", tooling, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "occ-worker-timing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const valuesFile = join(directory, "worker.yaml");
  await writeFile(valuesFile, "worker:\n  convergenceTimeoutMs: 1800000\n", { mode: 0o600 });
  const rendered = await render({}, { valuesFiles: [valuesFile] });
  assert.match(rendered.stdout, /name: OCC_WORKER_CONVERGENCE_TIMEOUT_MS\n\s+value: "1800000"/);
  assert.doesNotMatch(rendered.stdout, /OCC_WORKER_CONVERGENCE_TIMEOUT_MS\n\s+value: "1\.8e\+06"/);
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
    ...gatewayRoutingValues,
    "gatewayRouting.sandbox.enabled": "true",
    "gatewayRouting.sandbox.domain": "sandbox.example.test",
    "gatewayRouting.sandbox.tlsSecretName": "sandbox-tls",
    "gatewayRouting.sandbox.ingressPeers[0].namespaceSelector.matchLabels.team": "public",
    "gatewayRouting.sandbox.ingressPeers[0].podSelector.matchLabels.app": "edge",
  };
  const callers = [
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
      ({ stderr }) => stderr.includes(field),
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
  ]) {
    const objects = await resources(
      (
        await render(
          {},
          { strings: { [`api.clients[0].podLabels.${key.replaceAll(".", "\\.")}`]: value } },
        )
      ).stdout,
    );
    const policy = objects.find(
      ({ metadata }) => metadata.name === "openclaw-enterprise-api-ingress",
    );
    assert.equal(policy.spec.ingress[0].from[0].podSelector.matchLabels[key], value);
  }
  await render({ "api.clients[0].podLabels.empty": "null" });
  await render({ "metrics.scraperNamespaceLabels": "false", "metrics.scraperPodLabels": "false" });
  const directory = await mkdtemp(join(tmpdir(), "occ-peer-labels-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "values.json");
  const sandboxOptions = Object.fromEntries(
    Object.entries(sandbox).filter(([key]) => !key.includes("ingressPeers")),
  );
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
    await render(sandboxOptions, { valuesFiles: [path] });
  }
});

test("Collector exporter ports preserve decimal meaning in Kubernetes YAML", tooling, async () => {
  const field = "logging.collector.exporter.port";
  for (const value of ["03100", "0443", "010", "00080", "0", "65536", "18446744073709551617"]) {
    await assert.rejects(
      render(productionCollectorValues, { strings: { [field]: value } }),
      /logging\.collector\.exporter\.port must be an integer TCP port from 1 to 65535/,
      `Must refuse noncanonical or out-of-range exporter port: ${value}`,
    );
  }
  for (const value of ["1", "3100", "65535"]) {
    const objects = await resources(
      (await render(productionCollectorValues, { strings: { [field]: value } })).stdout,
    );
    const policy = objects.find(
      ({ kind, metadata }) =>
        kind === "NetworkPolicy" && metadata.name === "openclaw-enterprise-collector-egress",
    );
    assert.deepEqual(policy.spec.egress.at(-1).ports, [{ protocol: "TCP", port: Number(value) }]);
  }
  const numeric = await resources(
    (await render({ ...productionCollectorValues, [field]: 3100 })).stdout,
  );
  assert.deepEqual(
    numeric
      .find(({ metadata }) => metadata.name === "openclaw-enterprise-collector-egress")
      .spec.egress.at(-1).ports,
    [{ protocol: "TCP", port: 3100 }],
  );
});

test("Helm rejects obvious malformed quantity syntax", tooling, async () => {
  const collector = {
    "logging.collector.enabled": "true",
    "logging.collector.image":
      "docker.io/otel/opentelemetry-collector-contrib:0.159.0@sha256:1f2c54a30e713fac6b3ae77a1ec84010c2007e29ced8ec666214fc2f6739c1cc",
    "logging.collector.configSecretName": "occ-otel-collector-config",
    "logging.collector.envSecretName": "occ-otel-collector-exporter",
    "logging.collector.exporter.cidr": "203.0.113.10/32",
  };
  for (const isUpgrade of [false, true]) {
    const options = { isUpgrade };
    for (const [field, value] of [
      ["logging.collector.state.sizeLimit", "foo"],
      ["logging.collector.tmp.sizeLimit", "10MiB"],
      ["resources.requests.cpu", "foo"],
      ["logging.collector.resources.limits.memory", "10MiB"],
    ]) {
      await assert.rejects(render({ ...collector, [field]: value }, options), (error) => {
        assert.ok(error.stderr.includes(`${field} must be a Kubernetes quantity`));
        return true;
      });
    }
    const rendered = await render(collector, options);
    assert.match(rendered.stdout, /sizeLimit: "128Mi"/);
    assert.match(rendered.stdout, /sizeLimit: "64Mi"/);

    // Numeric YAML quantities must not be mistaken for missing or non-string values.
    const numeric = await resources(
      (
        await render(
          { ...collector, "resources.requests.cpu": 0, "resources.limits.cpu": 1 },
          options,
        )
      ).stdout,
    );
    const api = numeric.find(
      (object) =>
        object.kind === "Deployment" &&
        object.metadata?.labels?.["app.kubernetes.io/component"] === "api",
    );
    assert.equal(api.spec.template.spec.containers[0].resources.requests.cpu, 0);
    assert.equal(api.spec.template.spec.containers[0].resources.limits.cpu, 1);

    // Decimal E is exa; uppercase K is not a suffix. Exponent and binary forms stay.
    await assert.rejects(
      render({ "resources.requests.memory": "1K" }, options),
      /resources\.requests\.memory must be a Kubernetes quantity/,
    );
    await assert.rejects(
      render({ ...collector, "logging.collector.resources.requests.memory": "1K" }, options),
      /logging\.collector\.resources\.requests\.memory must be a Kubernetes quantity/,
    );
    await assert.rejects(
      render({ ...collector, "logging.collector.state.sizeLimit": "1K" }, options),
      /logging\.collector\.state\.sizeLimit must be a Kubernetes quantity/,
    );
    await assert.rejects(
      render({ "resources.requests.memory": "1KI" }, options),
      /resources\.requests\.memory must be a Kubernetes quantity/,
    );
    const accepted = await render(
      {
        ...collector,
        "resources.requests.memory": "1E",
        "logging.collector.resources.requests.memory": "1E",
        "logging.collector.state.sizeLimit": "1E",
      },
      options,
    );
    assert.match(accepted.stdout, /memory: 1E/);
    assert.match(accepted.stdout, /sizeLimit: "1E"/);
    const preserved = await render(
      {
        "resources.requests.memory": "1e3",
        "resources.limits.memory": "1E3",
        "resources.requests.cpu": "1k",
        "resources.limits.cpu": "1Ki",
      },
      options,
    );
    assert.match(preserved.stdout, /memory: "1e3"/);
    assert.match(preserved.stdout, /memory: "1E3"/);
    assert.match(preserved.stdout, /cpu: 1k/);
    assert.match(preserved.stdout, /cpu: 1Ki/);

    // UnmarshalJSON trims spaces on the raw JSON text. Escaped tabs stay rejected.
    await assert.rejects(
      render({}, { ...options, strings: { "resources.requests.cpu": "  foo " } }),
      /resources\.requests\.cpu must be a Kubernetes quantity/,
    );
    await assert.rejects(
      render({}, { ...options, strings: { "resources.requests.memory": " 1K " } }),
      /resources\.requests\.memory must be a Kubernetes quantity/,
    );
    await assert.rejects(
      render({}, { ...options, strings: { "resources.requests.memory": "\t64Mi" } }),
      /resources\.requests\.memory must be a Kubernetes quantity/,
    );
    const padded = await render(collector, {
      ...options,
      strings: {
        "resources.requests.cpu": " 100m ",
        "resources.limits.memory": " 1E ",
        "logging.collector.resources.requests.memory": " 64Mi ",
        "logging.collector.state.sizeLimit": " 128Mi ",
        "logging.collector.tmp.sizeLimit": " 32Mi ",
      },
    });
    assert.match(padded.stdout, /cpu: ["'] 100m ["']/);
    assert.match(padded.stdout, /memory: ["'] 1E ["']/);
    assert.match(padded.stdout, /memory: ["'] 64Mi ["']/);
    assert.match(padded.stdout, /sizeLimit: " 128Mi "/);
    assert.match(padded.stdout, /sizeLimit: " 32Mi "/);

    // ParseQuantity treats a missing numerator as zero. Bare Pi has an empty numeric token.
    const zeros = await render(collector, {
      ...options,
      strings: {
        "resources.requests.cpu": "m",
        "resources.limits.cpu": "+",
        "resources.requests.memory": ".",
        "logging.collector.state.sizeLimit": "m",
      },
    });
    assert.match(zeros.stdout, /cpu: m$/m);
    assert.match(zeros.stdout, /cpu: \+$/m);
    assert.match(zeros.stdout, /memory: \.$/m);
    assert.match(zeros.stdout, /sizeLimit: "m"/);
    await assert.rejects(
      render({}, { ...options, strings: { "resources.requests.memory": "Pi" } }),
      /resources\.requests\.memory must be a Kubernetes quantity/,
    );
    const withDigit = await render(
      {},
      { ...options, strings: { "resources.requests.memory": "1Pi" } },
    );
    assert.match(withDigit.stdout, /memory: 1Pi/);

    // sizeLimit is optional. Null clears the chart default and must stay YAML null on install and upgrade.
    const clearedLimits = await render(
      {
        ...collector,
        "logging.collector.state.sizeLimit": "null",
        "logging.collector.tmp.sizeLimit": "null",
      },
      options,
    );
    const clearedVolumes = (await resources(clearedLimits.stdout)).find(
      (object) =>
        object.kind === "DaemonSet" && object.metadata?.name === "openclaw-enterprise-collector",
    ).spec.template.spec.volumes;
    assert.equal(
      clearedVolumes.find((volume) => volume.name === "collector-state").emptyDir.sizeLimit,
      null,
    );
    assert.equal(
      clearedVolumes.find((volume) => volume.name === "collector-tmp").emptyDir.sizeLimit,
      null,
    );
    const stateCleared = await resources(
      (await render({ ...collector, "logging.collector.state.sizeLimit": "null" }, options)).stdout,
    );
    const stateVolumes = stateCleared.find((object) => object.kind === "DaemonSet").spec.template
      .spec.volumes;
    assert.equal(
      stateVolumes.find((volume) => volume.name === "collector-state").emptyDir.sizeLimit,
      null,
    );
    assert.equal(
      stateVolumes.find((volume) => volume.name === "collector-tmp").emptyDir.sizeLimit,
      "64Mi",
    );
    const tmpCleared = await resources(
      (await render({ ...collector, "logging.collector.tmp.sizeLimit": "null" }, options)).stdout,
    );
    const tmpVolumes = tmpCleared.find((object) => object.kind === "DaemonSet").spec.template.spec
      .volumes;
    assert.equal(
      tmpVolumes.find((volume) => volume.name === "collector-state").emptyDir.sizeLimit,
      "128Mi",
    );
    assert.equal(
      tmpVolumes.find((volume) => volume.name === "collector-tmp").emptyDir.sizeLimit,
      null,
    );
    await assert.rejects(
      render(
        {
          ...collector,
          "logging.collector.state.sizeLimit": "null",
          "logging.collector.tmp.sizeLimit": "10MiB",
        },
        options,
      ),
      /logging\.collector\.tmp\.sizeLimit must be a Kubernetes quantity/,
    );
    await assert.rejects(
      render(
        {
          ...collector,
          "logging.collector.state.sizeLimit": "foo",
          "logging.collector.tmp.sizeLimit": "null",
        },
        options,
      ),
      /logging\.collector\.state\.sizeLimit must be a Kubernetes quantity/,
    );

    // resources: null clears defaults. Indexing that absent map used to abort the render.
    const cleared = await render(
      {
        ...collector,
        resources: "null",
        "logging.collector.resources": "null",
      },
      options,
    );
    assert.match(cleared.stdout, /sizeLimit: "128Mi"/);
    assert.doesNotMatch(cleared.stdout, /cpu: 100m/);
    assert.doesNotMatch(cleared.stdout, /memory: 128Mi/);
    await assert.rejects(
      render(
        { ...collector, resources: "null" },
        { ...options, strings: { "logging.collector.resources.requests.memory": "foo" } },
      ),
      /logging\.collector\.resources\.requests\.memory must be a Kubernetes quantity/,
    );
  }
});

test(
  "the chart refuses control-plane node selectors the volume helper refuses",
  tooling,
  async () => {
    const valueMessage = /controlPlane\.nodeSelector values must be Kubernetes label values/;
    const keyMessage = /controlPlane\.nodeSelector keys must be Kubernetes label keys/;
    for (const [key, value, message] of [
      ["oce-role", "not valid", valueMessage],
      ["oce-role", "-control", valueMessage],
      ["oce-role", "control.", valueMessage],
      ["oce-role", "a".repeat(64), valueMessage],
      ["a-", "control", keyMessage],
      ["bad key", "control", keyMessage],
    ]) {
      await assert.rejects(
        render({}, { strings: { [`controlPlane.nodeSelector.${key}`]: value } }),
        ({ code, stderr }) => code !== 0 && message.test(stderr),
        `${key}=${value}`,
      );
    }
    const directory = await mkdtemp(join(tmpdir(), "openclaw-node-selector-"));
    const selectorValues = join(directory, "selector.yaml");
    await writeFile(
      selectorValues,
      "controlPlane:\n  nodeSelector:\n    Example.com/role: control\n",
    );
    await assert.rejects(
      render({}, { valuesFiles: [selectorValues] }),
      ({ code, stderr }) => code !== 0 && keyMessage.test(stderr),
    );
    await rm(directory, { recursive: true, force: true });
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
    const objects = await resources(stdout);
    const api = objects.find(
      (object) =>
        object.kind === "Deployment" &&
        object.metadata.labels?.["app.kubernetes.io/component"] === "api",
    );
    assert.equal(api.spec.template.spec.nodeSelector[`${"a".repeat(253)}/pool`], "control");
  },
);

test("execution chart refuses a harness hostname Compute refuses", tooling, async () => {
  const template = (...values) =>
    execute(
      helm,
      [
        "template",
        "oce",
        "deploy/helm/openclaw-execution",
        "--set",
        "routing.gatewayClassName=private-envoy-gateway",
        "--set",
        "routing.tlsSecretName=agents-tls",
        "--set-json",
        'routing.controlPlaneCidrs=["198.51.100.0/24"]',
        ...values,
      ],
      { cwd: repository, maxBuffer: 2_000_000 },
    );
  await assert.rejects(
    template("--set", "routing.hostname=Bad_Host"),
    /routing\.hostname must be a DNS hostname without a port or path/,
  );
  // --set reads these as a number and a boolean; the chart names the field instead of failing in len.
  for (const hostname of ["123", "true"]) {
    await assert.rejects(
      template("--set", `routing.hostname=${hostname}`),
      /routing\.hostname must be a string: quote a hostname YAML reads as a number or boolean, or pass it with --set-string/,
      hostname,
    );
  }
  for (const hostname of ["123", "agents.example.invalid"]) {
    const { stdout } = await template("--set-string", `routing.hostname=${hostname}`);
    const gateway = (await resources(stdout)).find((object) => object.kind === "Gateway");
    assert.equal(gateway?.spec.listeners[0].hostname, hostname);
  }
});

test(
  "execution chart refuses an Envoy HTTPS port or DNS namespace the cluster refuses",
  tooling,
  async () => {
    const template = (...values) =>
      execute(
        helm,
        [
          "template",
          "oce",
          "deploy/helm/openclaw-execution",
          "--set",
          "routing.hostname=agents.example.invalid",
          "--set",
          "routing.gatewayClassName=private-envoy-gateway",
          "--set",
          "routing.tlsSecretName=agents-tls",
          "--set-json",
          'routing.controlPlaneCidrs=["198.51.100.0/24"]',
          ...values,
        ],
        { cwd: repository, maxBuffer: 2_000_000 },
      );
    const proxyPolicy = async (stdout) =>
      (await resources(stdout)).find(
        (object) => object.kind === "NetworkPolicy" && object.metadata.name === "oce-harness-proxy",
      );
    // Compute validatePort takes integers from 1 to 65535; Sprig int would truncate 10443.5.
    // Sprig int turns a value too big for 64 bits into 0, which the lower bound catches.
    for (const port of ["0", "65536", "10443.5", "-1", "true", "99999999999999999999"]) {
      await assert.rejects(
        template("--set", `routing.envoyHttpsTargetPort=${port}`),
        /routing\.envoyHttpsTargetPort must be an integer TCP port from 1 to 65535/,
        port,
      );
    }
    for (const port of [1, 65535]) {
      const policy = await proxyPolicy(
        (await template("--set", `routing.envoyHttpsTargetPort=${port}`)).stdout,
      );
      assert.equal(policy?.spec.ingress[0].ports[0].port, port);
    }
    // The DNS egress rule selects kubernetes.io/metadata.name, which holds a Namespace name.
    for (const namespace of ["Kube-System", "kube.system", "-dns", "a".repeat(64)]) {
      await assert.rejects(
        template("--set-string", `dns.namespace=${namespace}`),
        /dns\.namespace must be a Kubernetes namespace name \(a DNS label of at most 63 characters\)/,
        namespace,
      );
    }
    const namespace = "a".repeat(63);
    const policy = await proxyPolicy(
      (await template("--set-string", `dns.namespace=${namespace}`)).stdout,
    );
    assert.equal(
      policy?.spec.egress[0].to[0].namespaceSelector.matchLabels["kubernetes.io/metadata.name"],
      namespace,
    );
  },
);
