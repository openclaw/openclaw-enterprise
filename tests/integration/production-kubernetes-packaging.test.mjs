import assert from "node:assert/strict";
import { ConfigurationValidationError } from "../../packages/contracts/src/index.ts";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
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
  goToolEnvironment,
  renderExecutionChart,
} from "../helpers/production-chart.mjs";
import { productionChartRendererRefusalCases } from "../helpers/production-chart-renderer-refusal-cases.ts";
import {
  gatewayRoutingValues,
  gatewaySandboxValues,
  protectedRepositoryValues,
  render,
  repositoryCredentialValues,
  stringNameMessage,
  tooling,
} from "../helpers/production-chart-network-fixture.ts";
import { findResource } from "../helpers/production-chart-resource.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

import { createEnvoyWorkspaceGatewayPlan } from "../helpers/envoy-workspace-gateway.mjs";
import { selfSigned } from "../helpers/certificates.mjs";
import { RecordingContext } from "../conformance/kubernetes-teardown-cases.ts";
import { withBoundedTeardown } from "../helpers/bounded-teardown.ts";
import { withEnvironment } from "../helpers/environment.ts";

const execute = promisify(execFile);

test("console themes mount only on the API and restart it when the checksum changes", async () => {
  const defaults = await resources((await renderProductionChart()).stdout);
  const themed = await resources(
    (
      await renderProductionChart({
        "api.consoleTheme.configMapName": "console-branding",
        "api.consoleTheme.checksum": "revision-two",
      })
    ).stdout,
  );
  for (const objects of [defaults, themed]) {
    for (const component of ["api", "worker"]) {
      const deployment = findResource(objects, "Deployment", `openclaw-enterprise-${component}`);
      const enabled = objects === themed && component === "api";
      const pod = deployment.spec.template;
      const container = [...(pod.spec.initContainers ?? []), ...pod.spec.containers].find(
        (item) => item.name === component,
      );
      assert.equal(
        container.env.some((item) => item.name === "OCC_CONSOLE_THEME_DIR"),
        enabled,
      );
      assert.equal(
        pod.spec.volumes.some((item) => item.name === "console-theme"),
        enabled,
      );
      assert.equal(
        pod.metadata.annotations?.["openclaw.dev/console-theme-checksum"],
        enabled ? "revision-two" : undefined,
      );
      if (enabled) {
        assert.deepEqual(pod.spec.volumes.find((item) => item.name === "console-theme").configMap, {
          name: "console-branding",
        });
        assert.deepEqual(
          container.volumeMounts.find((item) => item.name === "console-theme"),
          { name: "console-theme", mountPath: "/etc/openclaw/console-theme", readOnly: true },
        );
      }
    }
  }
});
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
const externalGatewayRoutingValues = {
  ...gatewayRoutingValues,
  "gatewayRouting.hostname": "agents.example.internal",
  "gatewayRouting.issuerRef.name": "occ-private-issuer",
};
const agentNativeAdminValues = {
  ...gatewayRoutingValues,
  "agentNativeAdmin.enabled": "true",
  "agentNativeAdmin.domain": "agents.example.invalid",
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
const googleLoginValues = {
  "auth.google.enabled": "true",
  "auth.recoveryUserId": "Xk3u9pQ2rT7vW1yZ",
};
const googleEgressValues = {
  "auth.google.egressCidrs[0]": "140.82.112.0/20",
  "auth.google.egressCidrs[1]": "192.30.252.0/22",
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

async function renderObjects(overrides = {}, options = {}) {
  return resources((await render(overrides, options)).stdout);
}

function findResourceByComponent(objects, kind, component) {
  return objects.find(
    (object) =>
      object.kind === kind && object.metadata.labels?.["app.kubernetes.io/component"] === component,
  );
}

test(
  "console theme settings reject YAML booleans and invalid ConfigMap names",
  tooling,
  async (t) => {
    const directory = await temporaryDirectory(t, "oce-console-theme-");
    const writeValues = async (name, body) => {
      const path = join(directory, name);
      await writeFile(path, body);
      return path;
    };
    for (const [name, body, refusal] of [
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
    ]) {
      const path = await writeValues(name, body);
      await assert.rejects(render({}, { valuesFiles: [path] }), refusal);
    }
    const quoted = await writeValues(
      "quoted.yaml",
      'api:\n  consoleTheme:\n    configMapName: "no"\n    checksum: "rev"\n',
    );
    const objects = await renderObjects({}, { valuesFiles: [quoted] });
    const api = findResource(objects, "Deployment", "openclaw-enterprise-api");
    assert.equal(
      api.spec.template.spec.volumes.find((item) => item.name === "console-theme").configMap.name,
      "no",
    );
    assert.equal(
      api.spec.template.metadata.annotations["openclaw.dev/console-theme-checksum"],
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
    const deployment = findResource(named, "Deployment", "openclaw-enterprise-api");
    assert.equal(
      deployment.spec.template.spec.volumes.find((item) => item.name === "console-theme").configMap
        .name,
      "false",
    );
  },
);

const stringNameDatabaseCa = {
  "database.caSecretName": "occ-database-ca-test",
  "database.caKey": "ca.pem",
  "database.caMountPath": "/etc/openclaw/database-ca",
};
const stringNameCaValues = {
  database: stringNameDatabaseCa,
  oidc: {
    ...stringNameDatabaseCa,
    "auth.oidc.enabled": "true",
    "auth.recoveryUserId": "recovery-admin_1",
    "auth.oidc.issuer": "https://tenant.idp.example.test/",
    "auth.oidc.authorizationUrl": "https://tenant.idp.example.test/authorize",
    "auth.oidc.tokenUrl": "https://tenant.idp.example.test/oauth/token",
    "auth.oidc.jwksUrl": "https://tenant.idp.example.test/.well-known/jwks.json",
    "auth.oidc.secretName": "oidc-client",
    "auth.oidc.clientIdKey": "client-id",
    "auth.oidc.clientSecretKey": "client-secret",
    "auth.oidc.caSecretName": "oidc-ca",
    "auth.oidc.caSecretKey": "ca.crt",
  },
  execution: {
    "executionCluster.enabled": "true",
    "executionCluster.apiKubeconfigSecretName": "execution-api",
    "executionCluster.workerKubeconfigSecretName": "execution-worker",
    "executionCluster.apiCidrs[0]": "10.44.0.2/32",
  },
};

test(
  "operator-named Secrets, keys and namespaces reject YAML booleans and numbers",
  tooling,
  async () => {
    // --set reads true or 1 as a boolean or number, as YAML does for yes/on/1. Rendered as "true"
    // or "1", the name would pass the name pattern and the Pod would wait for a Secret, key or
    // Namespace that does not exist.
    for (const [field, value, enabled = {}] of [
      ["installation.secretName", "true"],
      ["installation.key", "true"],
      ["database.secretName", "123"],
      ["database.caSecretName", "true"],
      ["auth.secretKey", "true"],
      ["dns.namespace", "true"],
      ["api.clients[0].namespace", "1"],
      ["database.appUrlKey", "2"],
      ["bootstrap.password.claimName", "true"],
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
      ["bootstrap.password.fileName", "2024"],
      ["bootstrap.serviceKey.fileName", "true"],
      ["database.caSecretName", "2024", stringNameCaValues.oidc],
      ["auth.oidc.caSecretName", "2024", stringNameCaValues.oidc],
      ["executionCluster.apiKubeconfigSecretName", "2024", stringNameCaValues.execution],
      ["executionCluster.workerKubeconfigSecretName", "true", stringNameCaValues.execution],
    ]) {
      await assert.rejects(
        render({ ...enabled, [field]: value }),
        (error) => error.message.includes(`${field} ${stringNameMessage}`),
        field,
      );
    }
    // An optional name that reads as false or 0 is still unset, as the notice says.
    for (const [value, mounted] of [
      ["occ-database-ca-test", true],
      ["false", false],
      ["0", false],
    ]) {
      const { stdout } = await render({
        ...stringNameCaValues.database,
        "database.caSecretName": value,
      });
      assert.equal(stdout.includes("/etc/openclaw/database-ca"), mounted, value);
    }
  },
);

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
        objects: await renderObjects({
          ...dnsValues,
          ...productionCollectorValues,
          ...slackProxyValues,
          ...gatewayRoutingValues,
        }),
        policies: [
          "openclaw-enterprise-dependency-egress",
          "oce-bootstrap-isolation",
          "openclaw-enterprise-collector-egress",
          "openclaw-enterprise-slack-proxy",
          `oce-${routeNamespaceLabel("openclaw-system", "oce-agent-gateways")}-envoy-dataplane`,
        ],
      },
      {
        objects: await resources((await renderExecutionChart(...dnsArguments)).stdout),
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
              { cwd: repository, env: goToolEnvironment(), maxBuffer: 2_000_000 },
            )
          ).stdout,
        ),
        policies: ["demo-dns"],
      },
    ];
    for (const { objects, policies } of charts) {
      for (const name of policies) {
        const policy = findResource(objects, "NetworkPolicy", name);
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
  const rendered = await renderObjects(sandboxValues);
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
  await assert.rejects(
    render({ ...sandboxValues, "gatewayRouting.sandbox.domain": "127.1" }),
    /gatewayRouting\.sandbox\.domain must be a DNS hostname usable after an Agent label/,
  );
  await assert.rejects(
    render({ ...sandboxValues, "gatewayRouting.sandbox.domain": "api.0x10" }),
    /gatewayRouting\.sandbox\.domain must be a DNS hostname usable after an Agent label/,
  );
  await assert.rejects(
    render({ ...sandboxValues, "gatewayRouting.sandbox.domain": "api.123" }),
    /gatewayRouting\.sandbox\.domain must be .*Agent label; use a DNS suffix/,
  );
  await assert.rejects(
    render({ ...sandboxValues, "gatewayRouting.sandbox.domain": "999.1.2.3" }),
    /gatewayRouting\.sandbox\.domain must be a DNS hostname usable after an Agent label/,
  );
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
  // The public listener binds in the unprivileged Envoy container.
  await assert.rejects(
    render({ ...sandboxValues, "gatewayRouting.sandbox.listenerPort": "1023" }),
    /gatewayRouting\.sandbox\.listenerPort must be an integer unprivileged port/,
  );
  const lowestListener = await renderObjects({
    ...sandboxValues,
    "gatewayRouting.sandbox.listenerPort": "1024",
  });
  assert.equal(
    lowestListener
      .find((item) => item.kind === "Gateway")
      .spec.listeners.find((item) => item.name === "sandbox").port,
    1024,
  );
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
  const hostnameLimitDomain = [longestLabel, longestLabel, longestLabel, "a".repeat(61)].join(".");
  assert.equal(longestDomain.length, 214);
  assert.equal(overlongDomain.length, 215);
  assert.equal(hostnameLimitDomain.length, 253);
  assert.equal(`agent-${"0".repeat(32)}.${longestDomain}`.length, 253);
  const longest = await renderObjects({
    ...sandboxValues,
    "gatewayRouting.sandbox.domain": longestDomain,
  });
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
    for (const [gatewayPort, sandbox, refused, message] of [
      [
        PLUGIN_RUNTIME_STATUS_PORT,
        false,
        true,
        `Gateway port cannot use the reserved runtime status port ${PLUGIN_RUNTIME_STATUS_PORT}.`,
      ],
      [
        PLUGIN_RUNTIME_STATUS_PORT,
        true,
        true,
        `Gateway port cannot use the reserved runtime status port ${PLUGIN_RUNTIME_STATUS_PORT}.`,
      ],
      [
        PLUGIN_RUNTIME_STATUS_PORT - 1,
        true,
        true,
        `Gateway sandbox port cannot use the reserved runtime status port ${PLUGIN_RUNTIME_STATUS_PORT}.`,
      ],
      [PLUGIN_RUNTIME_STATUS_PORT - 1, false, false],
      [PLUGIN_RUNTIME_STATUS_PORT + 1, true, false],
      [8080, true, false],
    ]) {
      const row = JSON.stringify({ gatewayPort, sandbox });
      const chartValues = {
        ...(sandbox ? gatewaySandboxValues : gatewayRoutingValues),
        "gatewayRouting.tenantGatewayPort": String(gatewayPort),
      };
      if (refused) {
        assert.throws(
          () => compute(gatewayPort, sandbox),
          (error) => {
            assert.ok(error instanceof ConfigurationValidationError);
            assert.deepEqual(error.error.details, [
              { path: "/network/gatewayPort", code: "INVALID_VALUE", message },
            ]);
            return true;
          },
          row,
        );
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
    for (const cidr of [
      "not-a-cidr",
      "10.1.1.1/33",
      "0.0.0.0/0",
      "12345::/64",
      "::ffff:999.1.2.3/64",
    ]) {
      await assert.rejects(
        render({ ...execution, "executionCluster.apiCidrs[0]": cidr }),
        /executionCluster\.apiCidrs/,
        cidr,
      );
    }
    await render({ ...execution, "executionCluster.apiCidrs[0]": "10.1.1.0/28" });
    await render({ ...execution, "executionCluster.apiCidrs[0]": "2001:db8::/64" });
    // Optional credential Secrets count once enabled (findings 1046, 1048): the ChatGPT admin,
    // sign-in, database CA and sandbox TLS Secrets, and the Gateway Secrets cert-manager writes.
    const gatewayRoot = `occ-gateway-${createHash("sha256").update("openclaw-system/oce-agent-gateways").digest("hex").slice(0, 12)}-root`;
    for (const [values, secret, role] of [
      [chatgptValues, "occ-chatgpt-admin", "backend.chatgpt.secretName"],
      [googleLoginValues, "occ-google-login", "auth.google.secretName"],
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
    const objects = await renderObjects(execution);
    for (const component of ["api", "worker"]) {
      const pod = findResource(objects, "Deployment", `openclaw-enterprise-${component}`).spec
        .template.spec;
      assert.equal(
        pod.volumes.find((volume) => volume.name === "execution-kubeconfig").secret.secretName,
        `execution-${component}`,
      );
    }
  },
);

test(
  "the chart refuses cluster and execution API ports NetworkPolicy cannot use",
  tooling,
  async () => {
    for (const port of ["0", "010", "65536", "9.5"]) {
      await assert.rejects(
        render({ "cluster.port": port }),
        /cluster\.port must be an integer TCP port/,
      );
    }
    const executionValues = {
      "executionCluster.enabled": "true",
      "executionCluster.apiKubeconfigSecretName": "execution-api",
      "executionCluster.workerKubeconfigSecretName": "execution-worker",
      "executionCluster.apiCidrs[0]": "10.44.0.2/32",
    };
    for (const port of ["0", "010", "65536", "9.5"]) {
      await assert.rejects(
        render({ ...executionValues, "executionCluster.apiPort": port }),
        /executionCluster\.apiPort must be an integer TCP port/,
      );
    }
    await assert.rejects(
      render({}, { strings: { "cluster.port": "9223372036854775808" } }),
      /cluster\.port must be an integer TCP port/,
    );
    await assert.rejects(
      render(
        { ...executionValues },
        { strings: { "executionCluster.apiPort": "99999999999999999999" } },
      ),
      /executionCluster\.apiPort must be an integer TCP port/,
    );
    const objects = await renderObjects({ ...executionValues, "executionCluster.apiPort": "6443" });
    const policy = findResource(
      objects,
      "NetworkPolicy",
      "openclaw-enterprise-execution-api-egress",
    );
    assert.equal(policy.spec.egress[0].ports[0].port, 6443);
  },
);

function routeNamespaceLabel(namespace, gatewayName) {
  return createHash("sha256").update(`${namespace}/${gatewayName}`).digest("hex").slice(0, 12);
}

function envoyNetworkPolicyName(releaseName, namespace, gatewayName) {
  return `${releaseName.slice(0, 34).replace(/[-.]+$/, "")}-${routeNamespaceLabel(
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
  const directory = await temporaryDirectory(t, "occ-production-example-");
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
  assert.equal(drivers.pluginDrivers[0].id, "codex-plugin");
  assert.equal(drivers.pluginDrivers[0].discoveryCredential, "none");
  const catalog = await drivers.pluginDrivers[0].discoverCatalog({ q: "Linear" });
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
  impossible.drivers.compute.configuration.resources.gateway.requests.cpu = "5";
  const impossiblePath = join(directory, "request-over-limit.yaml");
  await writeFile(impossiblePath, JSON.stringify(impossible));
  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: impossiblePath },
    }),
    (error) => {
      assert.ok(error instanceof ConfigurationValidationError);
      assert.equal(error.error.details[0].path, "/resources/gateway/requests/cpu");
      assert.equal(error.error.details[0].code, "INVALID_RANGE");
      assert.match(
        error.error.details[0].message,
        /Gateway CPU request .* cannot exceed its limit/,
      );
      return true;
    },
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
    const directory = await temporaryDirectory(t, "occ-control-hostname-");
    const example = loadYaml(
      (await readFile(new URL("installation.yaml", productionExamples), "utf8")).replace(
        "<actual-proxy-source-cidr>",
        "192.0.2.10/32",
      ),
    );
    const installationPath = join(directory, "installation.yaml");
    const load = () =>
      loadInstallationConfiguration({
        mode: "production",
        environment: { OCC_CONFIG_PATH: installationPath },
      });
    const invalid = [
      "192.168.1",
      "2130706433",
      "127.1",
      "0177.0.0.1",
      "0x7f000001",
      "0x7f.0.0.1",
      "0x",
      "0x.0.0.1",
      "1.2.3.4.5",
      "0.0.0.08",
      "api.0x10",
      "api.123",
      "999.1.2.3",
      "example.0x10",
      "Bad_Host",
      "proxy.example.test:443",
      "https://proxy.example.test",
      "proxy..example.test",
      `${"a".repeat(64)}.test`,
      `${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(62)}`,
    ];
    const valid = [
      "192.168.1.1",
      "192.0.2.1",
      "0.0.0.0",
      "255.255.255.255",
      "0xdead.gateway.example.test",
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
      // Helm --set reads a bare integer or 0x hex as a number. Pass those spellings
      // with --set-string so the chart sees the hostname the Installation stores.
      const numericHostname =
        typeof hostname === "string" && /^(?:0x[0-9a-f]*|\d+)$/.test(hostname);
      const helmValues =
        hostname === undefined || numericHostname
          ? gatewayRoutingValues
          : { ...gatewayRoutingValues, "gatewayRouting.hostname": hostname };
      const renderHostname = () =>
        numericHostname
          ? render(helmValues, { strings: { "gatewayRouting.hostname": hostname } })
          : render(helmValues);
      if (invalid.includes(hostname)) {
        await assert.rejects(load(), (error) => {
          assert.ok(error instanceof ConfigurationValidationError);
          assert.equal(error.error.details[0].path, "/gatewayRouting/hostname");
          assert.equal(error.error.details[0].code, "INVALID_FORMAT");
          assert.match(
            error.error.details[0].message,
            hostname === "api.123"
              ? /Gateway routing hostname must be .*numeric or 0x last label parses as IPv4; use a DNS name resolving to the gateway that its TLS certificate covers/
              : /Gateway routing hostname must be a DNS hostname without a port or path/,
          );
          assert.doesNotMatch(JSON.stringify(error.error.details), /Bad_Host/);
          return true;
        });
        await assert.rejects(
          renderHostname(),
          ({ stderr }) =>
            stderr.includes(
              hostname === "api.123"
                ? "gatewayRouting.hostname must be a DNS hostname without a port or path. A numeric or 0x last label parses as IPv4; use a DNS name resolving to the gateway that its TLS certificate covers"
                : "gatewayRouting.hostname must be a DNS hostname without a port or path",
            ),
          hostname,
        );
        continue;
      }
      const loaded = await load();
      const objects = await resources((await renderHostname()).stdout);
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
      // Admission preserves canonical IPv4 syntax, but the standard chart requests
      // DNS SANs, not IP SANs. A rendered address is not a usable TLS endpoint.
      const identityError = checkServerIdentity(expected, {
        subjectaltname: certificate.spec.dnsNames.map((name) => `DNS:${name}`).join(", "),
      });
      if (isIP(expected) === 4) {
        assert.equal(identityError?.code, "ERR_TLS_CERT_ALTNAME_INVALID");
      } else {
        assert.equal(identityError, undefined);
      }
      assert.equal(routing.hostname, hostname);
    }
    // Direct IPv4 passes address admission only; an Agent-prefixed suffix cannot be a URL host.
    for (const domain of ["192.0.2.1", "previews.example.test", "0xdead.previews.example.test"]) {
      const configuration = structuredClone(example);
      configuration.drivers.compute.configuration.gatewayRouting.sandbox = { domain };
      await writeFile(installationPath, JSON.stringify(configuration));
      const rendered = () => render({ ...sandboxValues, "gatewayRouting.sandbox.domain": domain });
      if (domain === "192.0.2.1") {
        await assert.rejects(load(), (error) => {
          assert.ok(error instanceof ConfigurationValidationError);
          assert.equal(error.error.details[0].path, "/gatewayRouting/sandbox/domain");
          assert.equal(error.error.details[0].code, "INVALID_FORMAT");
          assert.match(
            error.error.details[0].message,
            /Sandbox domain must be a DNS hostname.*Agent label/,
          );
          return true;
        });
        await assert.rejects(
          rendered(),
          /gatewayRouting\.sandbox\.domain must be a DNS hostname.*Agent label/,
        );
      } else {
        await load();
        await rendered();
      }
    }
  },
);

function renderProductionValuesExample(extraArgs, options = {}) {
  return execute(
    helm,
    [
      "template",
      "oce",
      "deploy/helm/openclaw-enterprise",
      "--namespace",
      "openclaw-system",
      "--values",
      "deploy/examples/production/values.yaml",
      ...extraArgs,
    ],
    { cwd: repository, env: goToolEnvironment(), ...options },
  );
}

test("Helm refuses a Gateway name Compute refuses", tooling, async () => {
  for (const [flag, gatewayName] of [
    ["--set", "Bad_Name"],
    ["--set-string", " oce-agent-gateways "],
    ["--set-string", "a".repeat(64)],
  ]) {
    await assert.rejects(
      renderProductionValuesExample([flag, `gatewayRouting.gatewayName=${gatewayName}`]),
      /gatewayRouting\.gatewayName must be a DNS-safe Kubernetes resource name/,
    );
  }
  const sixtyThree = "a".repeat(63);
  const { stdout } = await renderProductionValuesExample(
    ["--set-string", `gatewayRouting.gatewayName=${sixtyThree}`],
    { maxBuffer: 2_000_000 },
  );
  const gateway = (await resources(stdout)).find((object) => object.kind === "Gateway");
  assert.equal(gateway?.metadata.name, sixtyThree);
});

test(
  "the execution chart refuses a harness Gateway name or Envoy namespace Compute refuses",
  tooling,
  async () => {
    const template = (field, value) =>
      renderExecutionChart("--set-string", `routing.${field}=${value}`);
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
  const { stdout } = await renderProductionValuesExample([], { maxBuffer: 2_000_000 });
  const objects = await resources(stdout);
  assert.ok(
    objects.some(
      ({ kind, metadata }) =>
        kind === "Job" && metadata.labels?.["app.kubernetes.io/component"] === "initialization",
    ),
  );
  const initialization = findResourceByComponent(objects, "Job", "initialization");
  assert.deepEqual(initialization.spec.template.spec.nodeSelector, { "oce-role": "control" });
  for (const component of ["api", "worker"]) {
    assert.deepEqual(
      findResourceByComponent(objects, "Deployment", component).spec.template.spec.nodeSelector,
      {
        "oce-role": "control",
      },
    );
  }
  assert.deepEqual(findResourceByComponent(objects, "Deployment", "worker").spec.strategy, {
    type: "RollingUpdate",
    rollingUpdate: { maxSurge: "25%", maxUnavailable: "25%" },
  });
  // Session admission and sign-in limits are process-local: never overlap two API Pods.
  assert.deepEqual(findResourceByComponent(objects, "Deployment", "api").spec.strategy, {
    type: "Recreate",
  });
  for (const component of ["api", "worker"]) {
    const env = findResourceByComponent(objects, "Deployment", component).spec.template.spec
      .containers[0].env;
    assert.ok(!env.some(({ name }) => /^OCC_AUTH_(GITHUB|GOOGLE)_/.test(name)));
  }
  assert.ok(
    !objects.some(({ metadata }) => /-api-(google|oidc)-login-egress$/.test(metadata.name)),
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
          const objects = await renderObjects({}, { release, isUpgrade });
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
    "installation.attemptId": "eac2f079-cff2-4488-8e2e-3322df9b0bd6",
    "installation.upgradeAttemptId": "df44c039-3515-4d0e-b2eb-759e177f1ff5",
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
    const objects = await renderObjects(
      { ...settings, "images.controller": controllerImage },
      { isUpgrade },
    );
    // Recovery joins the submitted attempt to all live hooks and its owned Pod;
    // install-only attribution remains separate when both values are retained.
    for (const hook of objects.filter((object) => object.metadata.annotations?.["helm.sh/hook"])) {
      assert.equal(
        hook.metadata.annotations["openclaw.dev/upgrade-attempt"],
        isUpgrade ? settings["installation.upgradeAttemptId"] : undefined,
      );
    }
    const initializer = objects.find(({ kind }) => kind === "Job");
    assert.equal(
      initializer.metadata.annotations["openclaw.dev/installation-attempt"],
      isUpgrade ? undefined : settings["installation.attemptId"],
    );
    assert.equal(
      initializer.spec.template.metadata.annotations?.["openclaw.dev/upgrade-attempt"],
      isUpgrade ? settings["installation.upgradeAttemptId"] : undefined,
    );
    const api = deploymentPodSpec(objects, "api").containers[0];
    assert.equal(api.image, controllerImage);
    assert.deepEqual(
      api.env.find(({ name }) => name === "OCC_CHANNEL_DIRECTORY_PROXY_URL"),
      { name: "OCC_CHANNEL_DIRECTORY_PROXY_URL", value: "http://198.51.100.25:3128" },
    );
    assert.deepEqual(
      api.env.find(({ name }) => name === "OCC_AGENT_NATIVE_ADMIN_ENABLED"),
      { name: "OCC_AGENT_NATIVE_ADMIN_ENABLED", value: "true" },
    );
    const broker = deploymentPodSpec(objects, "worker").containers.find(
      ({ name }) => name === "repository-credentials",
    );
    assert.deepEqual(broker.args, [
      "--public-origin",
      "https://git.openclaw-system.svc.cluster.local",
      "--backend-id",
      "github-primary",
      "--authority",
      "prepared-git",
    ]);
    const proxyPolicy = findResource(
      objects,
      "NetworkPolicy",
      "openclaw-enterprise-api-channel-directory-egress",
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
          env: goToolEnvironment(),
        },
      );
      const { stdout: metadata } = await execute(helm, ["show", "chart", archive], {
        cwd: repository,
        env: goToolEnvironment(),
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
        { cwd: repository, env: goToolEnvironment(), maxBuffer: 2_000_000 },
      );
      const packaged = await execute(helm, ["template", "oce", archive, ...args], {
        cwd: repository,
        env: goToolEnvironment(),
        maxBuffer: 2_000_000,
      });
      assert.equal(packaged.stdout, source.stdout);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("control-plane node selectors are optional unless configured", tooling, async () => {
  const objects = await renderObjects();
  assert.equal(
    findResourceByComponent(objects, "Job", "initialization").spec.template.spec.nodeSelector,
    undefined,
  );
  for (const component of ["api", "worker"]) {
    assert.equal(
      findResourceByComponent(objects, "Deployment", component).spec.template.spec.nodeSelector,
      undefined,
    );
  }
});

test("Installation checksum rolls only its consumers", tooling, async () => {
  const checksum = "c".repeat(64);
  const before = await renderObjects(slackProxyValues);
  const after = await renderObjects({
    ...slackProxyValues,
    "controlPlane.installationChecksum": checksum,
  });
  for (const component of ["api", "worker"]) {
    const deployment = findResource(after, "Deployment", `openclaw-enterprise-${component}`);
    assert.equal(
      deployment.spec.template.metadata.annotations["openclaw.dev/installation-checksum"],
      checksum,
    );
  }
  const proxyName = "openclaw-enterprise-slack-proxy";
  assert.deepEqual(
    findResource(after, "Deployment", proxyName).spec.template,
    findResource(before, "Deployment", proxyName).spec.template,
  );
  for (const invalid of ["not-a-checksum", "c".repeat(63), "c".repeat(65), "C".repeat(64)]) {
    await assert.rejects(
      render({ "controlPlane.installationChecksum": invalid }),
      /must be an empty string or a lowercase SHA-256 digest/,
      invalid,
    );
  }
});

test(
  "Agent native admin pilot renders public host settings with private gateway routing",
  tooling,
  async () => {
    const objects = await renderObjects(agentNativeAdminValues);

    const apiEnvironment = deploymentPodSpec(objects, "api").containers[0].env;
    const workerEnvironment = deploymentPodSpec(objects, "worker").containers[0].env;
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
    assert.ok(apiEnvironment.some(({ name }) => name === "OCC_GATEWAY_API_KEY_PATH"));
    assert.ok(objects.some(({ kind }) => kind === "Gateway"));
    assert.ok(objects.some(({ kind }) => kind === "EnvoyProxy"));

    const longest = `${"a.".repeat(99)}example.invalid`;
    // Keep the whole suffix at 214 while preserving the fixture cookie parent.
    const boundary = `a${longest}`;
    assert.equal(boundary.length, 214);
    assert.match(
      (await render({ ...agentNativeAdminValues, "agentNativeAdmin.domain": boundary })).stdout,
      new RegExp(`value: "${boundary.replaceAll(".", "\\.")}"`),
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
    const disabledApiEnvironment = deploymentPodSpec(disabledObjects, "api").containers[0].env;
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
    const role = (objects, suffix) =>
      objects.find(
        ({ kind, metadata }) => kind === "ClusterRole" && metadata.name.endsWith(suffix),
      );
    const apiEnvironment = (objects) => deploymentPodSpec(objects, "api").containers[0].env;
    const hasLogRules = (rules) =>
      rules.some(({ resources = [] }) => resources.includes("pods/log")) ||
      rules.some(({ resources = [] }) => resources.includes("events"));

    const enabled = await renderObjects();
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

    const disabled = await renderObjects({ "agentRuntimeLogs.enabled": "false" });
    assert.deepEqual(
      apiEnvironment(disabled).filter(({ name }) => name === "OCC_AGENT_RUNTIME_LOGS_ENABLED"),
      [{ name: "OCC_AGENT_RUNTIME_LOGS_ENABLED", value: "false" }],
    );
    for (const suffix of ["-openclaw-tenant-api", "-openclaw-gateway-observer"]) {
      assert.equal(hasLogRules(role(disabled, suffix).rules), false, suffix);
    }

    // The execution chart grants its tenant API role the observer's Pod and proxy reads
    // (runtime diagnostics) and the same log reads.
    const execution = await resources((await renderExecutionChart()).stdout);
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
    // Bootstrap Jobs need worker-only creation and retirement, not mutation or TTL authority.
    for (const workerRole of [
      role(enabled, "-openclaw-tenant-worker"),
      role(execution, "-execution-tenant-worker"),
    ]) {
      assert.deepEqual(
        workerRole.rules.filter(({ resources = [] }) => resources.includes("jobs")),
        [{ apiGroups: ["batch"], resources: ["jobs"], verbs: ["get", "create", "delete"] }],
      );
    }
    for (const apiRole of [
      role(enabled, "-openclaw-tenant-api"),
      role(execution, "-execution-tenant-api"),
    ]) {
      assert.equal(
        apiRole.rules.some(({ resources = [] }) => resources.includes("jobs")),
        false,
      );
    }
    const executionDisabled = await resources(
      (await renderExecutionChart("--set", "agentRuntimeLogs.enabled=false")).stdout,
    );
    assert.deepEqual(role(executionDisabled, "-execution-tenant-api").rules, executionPodReads);
  },
);

test(
  "repository credential Helm packaging keeps App keys in the worker and TLS in the sender",
  tooling,
  async () => {
    const { stdout } = await render(repositoryCredentialValues);
    const objects = await resources(stdout);
    const named = (kind, name) => findResource(objects, kind, name);
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
      "--authority",
      "prepared-git",
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
    const ingress = named("NetworkPolicy", "openclaw-enterprise-prepared-repository-ingress");
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
  "prepared Git broker Helm selection omits App credentials and preserves TLS/control",
  tooling,
  async () => {
    const { stdout } = await render({
      ...repositoryCredentialValues,
      "repositoryCredentials.authority": "prepared-git",
      "repositoryCredentials.clusterDomain": "cluster.internal",
      "repositoryCredentials.preparedCustodySecretName": "test-git-custody",
      "repositoryCredentials.preparedProviderCaConfigMapName": "test-git-provider-ca",
    });
    const objects = await resources(stdout);
    assert.equal(
      objects.some(
        ({ kind, metadata }) =>
          kind === "NetworkPolicy" &&
          metadata.name === "openclaw-enterprise-repository-credentials-ingress",
      ),
      false,
      "ordinary repository ingress would add its broad peer grant to the prepared broker",
    );
    const preparedIngress = findResource(
      objects,
      "NetworkPolicy",
      "openclaw-enterprise-prepared-repository-ingress",
    );
    assert.deepEqual(preparedIngress.spec.ingress, []);
    const pod = findResource(objects, "Deployment", "openclaw-enterprise-worker").spec.template
      .spec;
    const broker = pod.containers.find(({ name }) => name === "repository-credentials");
    assert.deepEqual(broker.args.slice(-2), ["--authority", "prepared-git"]);
    const service = findResource(objects, "Service", "git");
    const hostname = "git.openclaw-system.svc.cluster.internal";
    assert.equal(
      service.metadata.annotations["openclaw.dev/repository-credentials-hostname"],
      hostname,
    );
    assert.equal(broker.args[broker.args.indexOf("--public-origin") + 1], `https://${hostname}`);
    assert.deepEqual(service.spec.ports, [
      { name: "https", port: 443, targetPort: 8443, protocol: "TCP" },
    ]);
    const owner = "prepared-repository-owner";
    assert.deepEqual(
      [...pod.containers, ...(pod.initContainers ?? [])]
        .filter(({ volumeMounts }) => volumeMounts?.some(({ name }) => name === owner))
        .map(({ name }) => name),
      ["worker"],
    );
    assert.deepEqual(
      pod.volumes
        .find(({ name }) => name === owner)
        .projected.sources.map(({ secret }) => secret.name),
      [repositoryCredentialValues["repositoryCredentials.appKeySecretName"], "test-git-custody"],
    );
    assert.ok(broker.volumeMounts.some(({ name }) => name === "prepared-repository-ca"));
    const inputs = pod.volumes.find(({ name }) => name === "repository-inputs");
    assert.deepEqual(
      inputs.projected.sources.map(({ secret }) => secret.name),
      ["repository-config", "repository-tls"],
    );
    assert.ok(broker.volumeMounts.some(({ name }) => name === "repository-control"));
    assert.ok(broker.volumeMounts.some(({ name }) => name === "repository-registry"));
    assert.equal(
      broker.volumeMounts.some(({ name }) => /issuer|app-key|custody/.test(name)),
      false,
    );
    await assert.rejects(
      render({ ...repositoryCredentialValues, "repositoryCredentials.authority": "unknown" }),
      /signing gateway retired/,
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
      const objects = await renderObjects(overrides, {
        namespace,
        isUpgrade: serviceName !== undefined,
      });
      const endpointName = serviceName ?? "git";
      assert.ok(
        objects.some(
          (object) => object.kind === "Service" && object.metadata.name === endpointName,
        ),
      );
      const worker = findResource(objects, "Deployment", "openclaw-enterprise-worker");
      const broker = worker.spec.template.spec.containers.find(
        ({ name }) => name === "repository-credentials",
      );
      assert.deepEqual(broker.args, [
        "--public-origin",
        expectedOrigin,
        "--backend-id",
        "github-primary",
        "--authority",
        "prepared-git",
      ]);
    }
  },
);

test(
  "repository credential origin helper reports the rendered broker endpoint",
  tooling,
  async (t) => {
    const directory = await temporaryDirectory(t, "broker-origin-helper-");
    const valuesFile = join(directory, "values.json");
    await writeFile(
      valuesFile,
      JSON.stringify({
        images: { controller: values["images.controller"] },
        gatewayRouting: { enabled: false },
        agentNativeAdmin: { domain: values["agentNativeAdmin.domain"] },
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
          authority: "prepared-git",
          preparedCustodySecretName: "repository-custody",
          image: repositoryCredentialValues["repositoryCredentials.image"],
          serviceName: "broker",
          hostname: "broker.openclaw-system.svc",
          backendId: "github-$$(BACKEND)",
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
            "scripts/render-repository-credentials-origin.ts",
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
      backendId: "github-$$(BACKEND)",
    });
  },
);

test(
  "image upgrade helper preserves the live broker endpoint before rendering Helm",
  tooling,
  async (t) => {
    const directory = await temporaryDirectory(t, "broker-upgrade-");
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
      ".gatewayRouting.enabled = false | .repositoryCredentials.enabled = true | del(.repositoryCredentials.hostname, .repositoryCredentials.serviceName)",
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
    installationDocument.repository = {
      id: "repository-credentials",
      configuration: { sessionDurationSeconds: 86400 },
      nativeSender: {
        controlSocket: "/run/openclaw/repository-control/private/control.sock",
        publicCaPath: "/etc/openclaw/repository-ca/ca.crt",
      },
      preparedGitHub: {
        custodyKeyPath: "/etc/openclaw/prepared-repository/custody.key",
        privateKeyPath: "/etc/openclaw/prepared-repository/private-key.pem",
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
[[ $# == 4 && "$1" == --output && "$2" == json && "$3" == installation ]] || exit 94
case "$4" in
  get) printf '{"id":"ins_test"}' ;;
  deployment-inventory) printf '{"installationId":"ins_test","namespaces":[]}' ;;
  *) exit 94 ;;
esac
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
  'status oce') if [[ "$*" == *'--output json'* ]]; then printf '{"name":"oce","namespace":"openclaw-system","version":1,"info":{"status":"deployed"}}'; else printf 'deployed'; fi ;;
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
    const { stdout: sourceRevision } = await execute("git", ["rev-parse", "HEAD"], {
      cwd: repository,
    });
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
                      "--authority",
                      "prepared-git",
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
            sourceRevision.trim(),
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
        // A failed dry-run has a render but no successful-preparation pointer.
        const attempts = await readdir(join(evidence, "helm-attempts"));
        assert.equal(attempts.length, 1);
        const candidate = await resources(
          await readFile(join(evidence, "helm-attempts", attempts[0], "rendered.yaml"), "utf8"),
        );
        const deployment = findResource(candidate, "Deployment", "openclaw-enterprise-worker");
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
  "repository credential ingress stays closed until Compute admits a prepared Harness revision",
  tooling,
  async () => {
    const objects = await renderObjects(repositoryCredentialValues);
    const worker = findResource(objects, "Deployment", "openclaw-enterprise-worker");
    const destination = {
      namespace: "openclaw-system",
      labels: worker.spec.template.metadata.labels,
    };
    const source = {
      namespace: "oce-tenant",
      namespaceLabels: {
        "kubernetes.io/metadata.name": "oce-tenant",
        "openclaw.dev/namespace": "tenant",
      },
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/workload-role": "agent",
        "openclaw.dev/namespace": "tenant",
        "openclaw.dev/agent": "agent-one",
        "openclaw.dev/revision": "revision-one",
        "openclaw.dev/service-principal": "principal-one",
        "openclaw.dev/network-profile": "broad-egress-v1",
      },
    };
    const allowed = (peer = source, port = 8443, protocol = "TCP", chart = objects) =>
      chartAllowsIngress(chart, destination, peer, port, protocol);

    // Helm has no admitted revisions. Check all additive policies, since a broad
    // grant elsewhere would bypass Compute's later admission of exact Harness peers.
    assert.equal(allowed(), false, "dedicated revision has not been admitted by Compute");
    const embedded = {
      ...source,
      labels: { ...source.labels, "openclaw.dev/workload-role": "gateway" },
    };
    delete embedded.labels["openclaw.dev/revision"];
    assert.equal(allowed(embedded), false, "embedded gateways cannot use prepared native Git");

    // Tenant ownership and workload labels alone must never grant broker access.
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
    const disabled = await renderObjects();
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
      [
        {
          "repositoryCredentials.image": `registry.example.invalid/foo\u00a0bar@sha256:${"c".repeat(64)}`,
        },
        /immutable SHA-256/,
      ],
      [{ "repositoryCredentials.backendId": "" }, /backendId is required/],
      [{ "repositoryCredentials.registryConfigMapName": "" }, /registryConfigMapName is required/],
      [
        { "repositoryCredentials.registryKey": "bad/key" },
        /registryKey must be a Kubernetes Secret key/,
      ],
      [
        { "repositoryCredentials.serviceConfigKey": "." },
        /serviceConfigKey must be a Kubernetes Secret key/,
      ],
      [
        { "repositoryCredentials.appKeyKey": "bad/key" },
        /appKeyKey must be a Kubernetes Secret key/,
      ],
      [
        { "repositoryCredentials.publicCaKey": "..ca" },
        /publicCaKey must be a Kubernetes Secret key/,
      ],
      [{ "repositoryCredentials.publicCaSecretName": "repository-tls" }, /dedicated Secret/],
      [{ "repositoryCredentials.appKeySecretName": "occ-auth" }, /dedicated Secret/],
      [{ "repositoryCredentials.tlsSecretName": "repository-config" }, /dedicated Secret/],
      [{ "repositoryCredentials.upstreamCidrs[0]": "0.0.0.0/0" }, /explicit IPv4 CIDRs/],
      [{ "repositoryCredentials.upstreamCidrs[0]": "999.1.1.1/32" }, /invalid IPv4 address/],
      [{ "repositoryCredentials.upstreamCidrs[0]": "192.168.001.10/32" }, /explicit IPv4 CIDRs/],
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

test("the chart validates scalar and literal repository backend IDs", tooling, async () => {
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
  for (const [backendId, argument] of [
    [123, "123"],
    [true, "true"],
    ["123", "123"],
    ["true", "true"],
    ["github-primary", "github-primary"],
    ["😀".repeat(100), "😀".repeat(100)],
    ["github-$", "github-$$"],
    ["github-$$", "github-$$$$"],
    ["github-$(BACKEND)", "github-$$(BACKEND)"],
    ["github-$$(BACKEND)", "github-$$$$(BACKEND)"],
  ]) {
    // Scalars use normal --set typing; strings retain the explicit string override.
    const objects = await renderObjects(
      { ...repositoryCredentialValues, "repositoryCredentials.backendId": backendId },
      typeof backendId === "string"
        ? { strings: { "repositoryCredentials.backendId": backendId } }
        : {},
    );
    const broker = deploymentPodSpec(objects, "worker").containers.find(
      ({ name }) => name === "repository-credentials",
    );
    assert.equal(
      broker.args[broker.args.indexOf("--backend-id") + 1],
      argument,
      JSON.stringify(backendId),
    );
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
    const objects = await renderObjects({ "installation.name": name });
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
  "the production Helm chart supports explicit routing opt-out with ordered bootstrap",
  tooling,
  async () => {
    const { stdout } = await render(controlPlaneSelectorValues);
    const objects = await resources(stdout);
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
    const tenantWorker = findResource(objects, "ClusterRole", "oce-openclaw-tenant-worker");
    assert.deepEqual(
      tenantWorker.rules.filter(({ resources }) => resources.includes("secrets")),
      [{ apiGroups: [""], resources: ["secrets"], verbs: ["get", "create", "update", "delete"] }],
    );
    const gatewayObserver = findResource(objects, "ClusterRole", "oce-openclaw-gateway-observer");
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

    assert.ok(
      !objects.some(({ kind }) =>
        ["Ingress", "Gateway", "EnvoyProxy", "SecurityPolicy", "Certificate", "Issuer"].includes(
          kind,
        ),
      ),
    );
    for (const deployment of objects.filter(({ kind }) => kind === "Deployment")) {
      for (const container of deployment.spec.template.spec.containers) {
        assert.ok(!container.env.some(({ name }) => name === "OCC_GATEWAY_API_KEY_PATH"));
      }
    }

    // Initialization, API, and worker use distinct identities; database credentials remain isolated.
    for (const component of ["initialization", "api", "worker"]) {
      assert.ok(findResourceByComponent(objects, "ServiceAccount", component));
    }
    const initialization = findResourceByComponent(objects, "Job", "initialization");
    assert.equal(initialization.spec.backoffLimit, 0);
    const pod = initialization.spec.template.spec;
    assert.equal(pod.automountServiceAccountToken, false);
    assert.deepEqual(pod.nodeSelector, { "oce-role": "control" });
    assert.equal(pod.securityContext.fsGroupChangePolicy, "OnRootMismatch");
    const [check, migration] = pod.initContainers;
    assert.equal(check.name, "installation-check");
    assert.equal(migration.name, "migration");
    assert.deepEqual(migration.args, ["scripts/migrate-production.mjs", "--expect-empty"]);
    assert.equal(pod.containers[0].name, "bootstrap");
    assert.deepEqual(pod.containers[0].args, ["scripts/bootstrap-installation.mjs"]);
    assert.ok(migration.env.some(({ name }) => name === "OCC_MIGRATION_DATABASE_URL"));
    assert.ok(!migration.env.some(({ name }) => name === "OCC_DATABASE_URL"));
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
    // Only the unbound tenant-worker role can list owned gateway claims and reconcile claims.
    assert.deepEqual(
      tenant.rules.filter(({ resources }) => resources.includes("persistentvolumeclaims")),
      [
        {
          apiGroups: [""],
          resources: ["persistentvolumeclaims"],
          verbs: ["get", "list", "create", "patch", "delete"],
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
      const pod = findResourceByComponent(objects, "Deployment", component).spec.template.spec;
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
        // Each probe starts Node inside the worker's CPU limit: a 1 s timeout restarted
        // healthy workers on a busy node (finding 2789), and a slow boot gets the API's
        // 2 min before liveness starts.
        assert.equal(container.readinessProbe.timeoutSeconds, 5);
        assert.equal(container.livenessProbe.timeoutSeconds, 5);
        assert.deepEqual(container.startupProbe, {
          exec: container.livenessProbe.exec,
          timeoutSeconds: 5,
          periodSeconds: 5,
          failureThreshold: 24,
        });
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
    const dependencyEgress = findResource(
      objects,
      "NetworkPolicy",
      "openclaw-enterprise-dependency-egress",
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

function assertApiEgressPolicy(objects, name, cidrs, port, message) {
  const policy = findResource(objects, "NetworkPolicy", name);
  assert.ok(policy, message);
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
        to: cidrs.map((cidr) => ({ ipBlock: { cidr } })),
        ports: [{ protocol: "TCP", port }],
      },
    ],
  });
  return policy;
}

test(
  "optional model discovery grants only API HTTPS egress to configured hosts",
  tooling,
  async () => {
    const name = "openclaw-enterprise-api-model-discovery-egress";
    const defaults = await renderObjects();
    assert.ok(!defaults.some(({ metadata }) => metadata.name === name));
    const objects = await renderObjects({
      "api.modelDiscoveryCidrs[0]": "198.51.100.25/32",
      "api.modelDiscoveryCidrs[1]": "198.51.100.26/32",
    });
    assertApiEgressPolicy(
      objects,
      name,
      ["198.51.100.25/32", "198.51.100.26/32"],
      443,
      "configured discovery destinations must render an egress policy",
    );
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

test("MCP plugin discovery has independent API HTTPS egress", tooling, async () => {
  const name = "openclaw-enterprise-api-plugin-discovery-egress";
  const modelName = "openclaw-enterprise-api-model-discovery-egress";
  const defaults = await renderObjects();
  assert.ok(!defaults.some(({ metadata }) => metadata.name === name));

  const pluginValues = {
    "api.pluginDiscoveryCidrs[0]": "203.0.113.15/32",
    "api.pluginDiscoveryCidrs[1]": "203.0.113.16/32",
  };
  const pluginOnly = await renderObjects(pluginValues);
  assert.ok(!pluginOnly.some(({ metadata }) => metadata.name === modelName));
  const pluginPolicy = assertApiEgressPolicy(
    pluginOnly,
    name,
    ["203.0.113.15/32", "203.0.113.16/32"],
    443,
    "configured MCP hosts must render their own API egress policy",
  );

  // Configuring both lists retains their distinct policies and destinations.
  const modelValues = { "api.modelDiscoveryCidrs[0]": "198.51.100.25/32" };
  const modelOnly = await renderObjects(modelValues);
  assert.ok(!modelOnly.some(({ metadata }) => metadata.name === name));
  const modelPolicy = assertApiEgressPolicy(
    modelOnly,
    modelName,
    ["198.51.100.25/32"],
    443,
    "configured model host must render its own API egress policy",
  );
  const combined = await renderObjects({ ...pluginValues, ...modelValues });
  assert.deepEqual(findResource(combined, "NetworkPolicy", name), pluginPolicy);
  assert.deepEqual(findResource(combined, "NetworkPolicy", modelName), modelPolicy);

  for (const cidr of ["0.0.0.0/0", "203.0.113.0/24", "mcp.example.invalid"]) {
    await assert.rejects(
      render({ "api.pluginDiscoveryCidrs[0]": cidr }),
      /api.pluginDiscoveryCidrs/,
    );
  }
  await assert.rejects(
    render({ "api.pluginDiscoveryCidrs": "203.0.113.15/32" }),
    /api.pluginDiscoveryCidrs/,
  );
});

test("Slack directory proxy grants only API egress to its exact endpoint", tooling, async () => {
  const name = "openclaw-enterprise-api-channel-directory-egress";
  const defaults = await renderObjects();
  assert.ok(!defaults.some(({ metadata }) => metadata.name === name));
  const objects = await renderObjects({
    "api.channelDirectoryProxyUrl": "http://198.51.100.25:3128",
  });
  assertApiEgressPolicy(
    objects,
    name,
    ["198.51.100.25/32"],
    3128,
    "configured directory proxy must render API egress",
  );
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
  await assert.rejects(
    render({ "api.channelDirectoryProxyUrl": "http://0.0.0.0:3128" }),
    /api\.channelDirectoryProxyUrl must not use host 0\.0\.0\.0, which names no proxy address/,
  );
});

test(
  "managed Slack proxy renders private Service DNS and restricted proxy policies",
  tooling,
  async () => {
    const objects = await renderObjects(slackProxyValues);
    const named = (kind, name) => findResource(objects, kind, name);
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
    const gatewayObjects = await renderObjects({ ...slackProxyValues, ...gatewayRoutingValues });
    const gatewayProxyPolicy = findResource(
      gatewayObjects,
      "NetworkPolicy",
      "openclaw-enterprise-slack-proxy",
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
      // The proxy runs as UID 1000 without capabilities: a port below 1024 cannot bind.
      { "slackProxy.port": "1023" },
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
    await assert.rejects(
      render({ ...slackProxyValues, "slackProxy.resources.requests.memory": "10MiB" }),
      /slackProxy\.resources\.requests\.memory must be a Kubernetes quantity/,
    );
  },
);

test(
  "gatewayRouting.remoteNodeCidrs rejects invalid and every-address ranges",
  tooling,
  async () => {
    for (const override of [
      { "gatewayRouting.remoteNodeCidrs[0]": "not-a-cidr" },
      { "gatewayRouting.remoteNodeCidrs[0]": "010.0.0.1/32" },
      { "gatewayRouting.remoteNodeCidrs[0]": "12345::/64" },
      { "gatewayRouting.remoteNodeCidrs[0]": "::ffff:999.1.2.3/32" },
    ]) {
      await assert.rejects(
        render({ ...gatewayRoutingValues, ...override }),
        /gatewayRouting\.remoteNodeCidrs/,
      );
    }
    for (const cidr of ["10.0.0.1/32", "0.0.0.0/0", "::/64", "::ffff:10.0.0.0/120"]) {
      await render({ ...gatewayRoutingValues, "gatewayRouting.remoteNodeCidrs[0]": cidr });
    }
  },
);

test("database CA mounts stay distinct from active production volume mounts", tooling, async () => {
  const authorityValues = {
    "egressAuthority.enabled": "true",
    "egressAuthority.tlsSecretName": "authority-server-tls",
    "egressAuthority.issuerSecretName": "gateway-jwt-keys",
    "egressAuthority.clients[0].namespaceSelector.matchLabels.kubernetes\\.io/metadata\\.name":
      "openshell-system",
    "egressAuthority.clients[0].podSelector.matchLabels.app": "openshell-gateway",
  };
  const custodyValues = {
    ...authorityValues,
    "preparedGitHub.custodySecretName": "prepared-github-custody",
    "preparedGitHub.issuerCidrs[0]": "192.0.2.3/32",
  };
  const issuerCaValues = {
    ...custodyValues,
    "preparedGitHub.issuerCaConfigMapName": "prepared-github-issuer-ca",
  };
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
    { ...issuerCaValues, "backend.openshell.clientSecretName": "dedicated-openshell-admin" },
    { "bootstrap.password.mountPath": "/custom/bootstrap" },
  ]) {
    const objects = await renderObjects(features);
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
      // Linux kubelet/runtime destinations alias these spellings. The CA must not
      // hide an active volume after admission accepts the distinct raw strings.
      for (const alias of [
        mountPath,
        mountPath.slice(1),
        `${mountPath}/`,
        `${mountPath}/.`,
        `${mountPath}/../${mountPath.split("/").at(-1)}`,
        // The controller image links /var/run to /run, and the runtime follows it.
        ...(mountPath.startsWith("/run/") ? [`/var${mountPath}`] : []),
        ...(mountPath.startsWith("/var/run/") ? [mountPath.slice("/var".length)] : []),
        // It links /var/lock to /run/lock too, so ".." from /var/lock lands in /run, not /var.
        ...(mountPath.startsWith("/run/")
          ? [
              `/var/lock/..${mountPath.slice("/run".length)}`,
              `/run/lock/..${mountPath.slice("/run".length)}`,
            ]
          : []),
      ]) {
        await assert.rejects(
          render({ ...features, ...databaseCaValues, "database.caMountPath": alias }),
          /database.caMountPath.*distinct/,
          alias,
        );
      }
    }
  }
  // Paths reserved by optional features remain available when those features are disabled.
  for (const mountPath of [
    "/etc/openclaw/openshell",
    "/etc/openclaw/egress/tls",
    "/etc/openclaw/egress/issuer",
    "/etc/openclaw/prepared-github",
    "/etc/openclaw/prepared-github-issuer",
    "/etc/openclaw/execution",
    "/etc/openclaw/repository-registry",
    "/etc/openclaw/repository-ca",
    "/var/run/secrets/kubernetes.io/serviceaccount",
    "/run/secrets/kubernetes.io/serviceaccount",
    "/run/openclaw/repository-control",
    "/var/run/openclaw/repository-control",
    "/etc/openclaw/gateway-api-key",
    "/etc/openclaw/gateway-ca",
    "/etc/openclaw/chatgpt",
    "/custom/database-ca",
    "custom/database-ca",
    "/custom/./database-ca",
  ]) {
    await render({ ...databaseCaValues, "database.caMountPath": mountPath });
  }
  // Custody does not reserve an issuer CA directory unless the issuer CA is mounted.
  await render({
    ...custodyValues,
    ...databaseCaValues,
    "database.caMountPath": "/etc/openclaw/prepared-github-issuer",
  });
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
    const objects = await renderObjects(databaseCaValues);
    const initializationPod = findResourceByComponent(objects, "Job", "initialization").spec
      .template.spec;
    assert.deepEqual(initializationPod.volumes.find(({ name }) => name === "database-ca")?.secret, {
      secretName: "occ-rds-ca",
      items: [{ key: "ca.pem", path: "ca.pem" }],
    });
    assert.deepEqual(
      initializationPod.initContainers
        .find(({ name }) => name === "migration")
        .volumeMounts.find(({ name }) => name === "database-ca"),
      { name: "database-ca", mountPath: "/etc/openclaw/database-ca", readOnly: true },
    );
    assert.deepEqual(
      initializationPod.containers[0].volumeMounts.find(({ name }) => name === "database-ca"),
      { name: "database-ca", mountPath: "/etc/openclaw/database-ca", readOnly: true },
    );

    for (const component of ["api", "worker"]) {
      const pod = findResourceByComponent(objects, "Deployment", component).spec.template.spec;
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
  "OCC can manage private OAuth client Secrets without access to Secrets in the release namespace",
  tooling,
  async () => {
    const releaseNamespace = "oauth-control-plane";
    const objects = await renderObjects({}, { namespace: releaseNamespace });
    const privateNamespaces = new Set();
    for (const [component, verbs] of [
      ["api", ["get", "create", "update", "delete"]],
      ["worker", ["get", "delete"]],
    ]) {
      const pod = findResourceByComponent(objects, "Deployment", component).spec.template.spec;
      const namespace = pod.containers[0].env.find(
        ({ name }) => name === "OCC_INSTALLATION_SECRET_NAMESPACE",
      ).value;
      privateNamespaces.add(namespace);
      // Check the effective RoleBinding for the ServiceAccount the chart actually deploys.
      const binding = objects.find(
        ({ kind, metadata, subjects }) =>
          kind === "RoleBinding" &&
          metadata.namespace === namespace &&
          subjects?.some((subject) => subject.name === pod.serviceAccountName),
      );
      assert.notEqual(namespace, releaseNamespace);
      assert.deepEqual(binding.subjects, [
        {
          kind: "ServiceAccount",
          name: pod.serviceAccountName,
          namespace: releaseNamespace,
        },
      ]);
      const role = objects.find(
        ({ kind, metadata }) =>
          kind === binding.roleRef.kind &&
          metadata.namespace === namespace &&
          metadata.name === binding.roleRef.name,
      );
      assert.deepEqual(role.rules, [{ apiGroups: [""], resources: ["secrets"], verbs }]);
      assert.ok(
        objects.some(({ kind, metadata }) => kind === "Namespace" && metadata.name === namespace),
      );
    }
    assert.equal(privateNamespaces.size, 1);
  },
);

test(
  "the optional ChatGPT Backend isolates admin credentials, tenant Secrets, and provider egress to the API",
  tooling,
  async () => {
    const { stdout } = await render(chatgptValues);
    const objects = await resources(stdout);
    // The operator-owned admin Secret is available only to the API through its fixed file path.
    const apiPod = findResourceByComponent(objects, "Deployment", "api").spec.template.spec;
    const adminVolume = apiPod.volumes.find(({ name }) => name === "chatgpt-admin");
    assert.deepEqual(adminVolume.secret, {
      secretName: "occ-chatgpt-admin",
      items: [{ key: "admin-key", path: "admin-key" }],
    });
    assert.deepEqual(
      apiPod.containers[0].volumeMounts.find(({ name }) => name === "chatgpt-admin"),
      { name: "chatgpt-admin", mountPath: "/etc/openclaw/chatgpt", readOnly: true },
    );
    const workerPod = findResourceByComponent(objects, "Deployment", "worker").spec.template.spec;
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
    const providerPolicy = findResource(
      objects,
      "NetworkPolicy",
      "openclaw-enterprise-api-chatgpt-egress",
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

const signInEnv = /^OCC_AUTH_(GOOGLE_|OIDC_|TRUSTED_PROXY_CIDRS|CLIENT_IP_HEADER)/;

async function signInObjects(overrides) {
  const objects = await renderObjects(overrides);
  const selected = (kind, component) => findResourceByComponent(objects, kind, component);
  const apiEnv = Object.fromEntries(
    selected("Deployment", "api").spec.template.spec.containers[0].env.map(({ name, ...value }) => [
      name,
      value,
    ]),
  );
  const egress = findResource(
    objects,
    "NetworkPolicy",
    "openclaw-enterprise-api-google-login-egress",
  );
  return { objects, selected, apiEnv, egress };
}

test(
  "optional Google sign-in reaches only the API through a dedicated Secret and Google egress",
  tooling,
  async () => {
    const { objects, selected, apiEnv, egress } = await signInObjects({
      ...googleLoginValues,
      ...googleEgressValues,
      ...trustedProxyValues,
    });
    assert.deepEqual(selected("Deployment", "api").spec.strategy, { type: "Recreate" });
    assert.deepEqual(apiEnv.OCC_AUTH_GOOGLE_CLIENT_ID, {
      valueFrom: { secretKeyRef: { name: "occ-google-login", key: "client-id" } },
    });
    assert.deepEqual(apiEnv.OCC_AUTH_GOOGLE_CLIENT_SECRET, {
      valueFrom: { secretKeyRef: { name: "occ-google-login", key: "client-secret" } },
    });
    assert.deepEqual(apiEnv.OCC_AUTH_RECOVERY_USER_ID, { value: "Xk3u9pQ2rT7vW1yZ" });
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

test("Google sign-in egress defaults to HTTPS except link-local", tooling, async () => {
  const { apiEnv, egress } = await signInObjects(googleLoginValues);
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
      assert.ok(!Object.keys(apiEnv).some((name) => name.startsWith("OCC_AUTH_GOOGLE_")));
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
        "Google sign-in without a recovery user",
        { "auth.google.enabled": "true" },
        /auth\.google\.enabled requires auth\.recoveryUserId/,
      ],
      [
        "a recovery user without Google or OIDC sign-in",
        { "auth.recoveryUserId": "Xk3u9pQ2rT7vW1yZ" },
        /auth\.recoveryUserId requires auth\.google\.enabled or auth\.oidc\.enabled/,
      ],
      [
        "Google sign-in with an invalid recovery user",
        { ...googleLoginValues, "auth.recoveryUserId": "admin@example.invalid" },
        /auth\.recoveryUserId must be/,
      ],
      [
        "Google sign-in with a hostname egress",
        { ...googleLoginValues, "auth.google.egressCidrs[0]": "github.com" },
        /auth\.google\.egressCidrs requires explicit IPv4 CIDRs/,
      ],
      [
        "Google sign-in with an invalid egress address",
        { ...googleLoginValues, "auth.google.egressCidrs[0]": "140.82.312.0/20" },
        /invalid IPv4 address/,
      ],
      [
        "Google sign-in with a leading-zero egress octet",
        { ...googleLoginValues, "auth.google.egressCidrs[0]": "140.82.112.08/20" },
        /explicit IPv4 CIDRs/,
      ],
      [
        "Google sign-in with a /0 egress entry",
        { ...googleLoginValues, "auth.google.egressCidrs[0]": "0.0.0.0/0" },
        /prefixes 1 through 32/,
      ],
      [
        "Google sign-in with an empty-string egress list",
        { ...googleLoginValues, "auth.google.egressCidrs": "" },
        /auth\.google\.egressCidrs must be a list of IPv4 CIDRs; leave it unset, or set \[\] in a values file or with --set-json,/,
      ],
      [
        "Google sign-in sharing the Better Auth Secret",
        { ...googleLoginValues, "auth.google.secretName": "occ-auth" },
        /dedicated Secret/,
      ],
      [
        "Google sign-in sharing the database Secret",
        { ...googleLoginValues, "auth.google.secretName": "occ-database" },
        /dedicated Secret/,
      ],
      [
        "Google sign-in sharing the installation Secret",
        { ...googleLoginValues, "auth.google.secretName": "occ-installation-startup" },
        /dedicated Secret/,
      ],
      [
        "Google sign-in reusing one Secret key",
        { ...googleLoginValues, "auth.google.clientSecretKey": "client-id" },
        /different Secret keys/,
      ],
      [
        "Google sign-in without a client ID key",
        { ...googleLoginValues, "auth.google.clientIdKey": "" },
        /client ID key/,
      ],
      [
        "Google sign-in over HTTP",
        { ...googleLoginValues, "auth.baseUrl": "http://occ.example.invalid" },
        /HTTPS auth\.baseUrl/,
      ],
      [
        "Google sign-in with shared native admin cookies",
        { ...googleLoginValues, ...agentNativeAdminValues },
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
    const objects = await renderObjects({}, { strings: { "bootstrap.adminEmail": email } });
    const job = findResourceByComponent(objects, "Job", "initialization");
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
  const objects = await renderObjects({}, { strings: { "bootstrap.password.claimName": longest } });
  const job = findResourceByComponent(objects, "Job", "initialization");
  const claim = job.spec.template.spec.volumes.find(
    (volume) => volume.name === "bootstrap-password-output",
  ).persistentVolumeClaim.claimName;
  assert.equal(claim, longest);
  assert.equal(longest.length, 253);
});

// Findings 1065 and 1066: every Secret or ConfigMap name an operator sets, and the GatewayClass,
// must be a Kubernetes resource name (the profile renderer's resourceNameRule), so a malformed
// one fails at template time instead of in the cluster.
const oidcLoginValues = {
  "auth.oidc.enabled": "true",
  "auth.recoveryUserId": "recovery-admin_1",
  "auth.oidc.issuer": "https://tenant.idp.example.test/",
  "auth.oidc.authorizationUrl": "https://tenant.idp.example.test/authorize",
  "auth.oidc.tokenUrl": "https://tenant.idp.example.test/oauth/token",
  "auth.oidc.jwksUrl": "https://tenant.idp.example.test/.well-known/jwks.json",
};
const executionClusterValues = {
  "executionCluster.enabled": "true",
  "executionCluster.apiKubeconfigSecretName": "execution-api",
  "executionCluster.workerKubeconfigSecretName": "execution-worker",
  "executionCluster.apiCidrs[0]": "10.44.0.2/32",
};
for (const [field, enable = {}] of [
  ["installation.secretName"],
  ["database.secretName"],
  ["auth.secretName"],
  ["database.caSecretName", databaseCaValues],
  ["auth.google.secretName", googleLoginValues],
  ["auth.google.secretName", { "auth.google.enabled": "true", "auth.recoveryUserId": "r1" }],
  ["auth.oidc.secretName", oidcLoginValues],
  ["backend.chatgpt.secretName", chatgptValues],
  ["gatewayRouting.apiKeySecretName", gatewayRoutingValues],
  ["gatewayRouting.tlsSecretName", gatewayRoutingValues],
  ["gatewayRouting.gatewayClassName", gatewayRoutingValues],
  ["gatewayRouting.issuerRef.name", externalGatewayRoutingValues],
  [
    "gatewayRouting.caSecretName",
    { ...externalGatewayRoutingValues, "gatewayRouting.caSecretKey": "ca.crt" },
  ],
  ["gatewayRouting.sandbox.tlsSecretName", sandboxValues],
  ["executionCluster.apiKubeconfigSecretName", executionClusterValues],
  ["executionCluster.workerKubeconfigSecretName", executionClusterValues],
  ...[
    "registryConfigMapName",
    "serviceConfigSecretName",
    "appKeySecretName",
    "tlsSecretName",
    "publicCaSecretName",
  ].map((key) => [`repositoryCredentials.${key}`, repositoryCredentialValues]),
  ["logging.collector.configSecretName", productionCollectorValues],
  ["logging.collector.envSecretName", productionCollectorValues],
]) {
  test(`the chart refuses a malformed ${field} with the resource name rule`, tooling, async () => {
    const message = new RegExp(
      `${field.replaceAll(".", "\\.")} must be a Kubernetes resource name of at most 253 characters`,
    );
    for (const name of ["Bad_Name", "-secret", "secret.", "a".repeat(254)]) {
      await assert.rejects(
        render(enable, { strings: { [field]: name } }),
        ({ code, stderr }) => code !== 0 && message.test(stderr),
        `${field}: ${name.length > 40 ? `${name.length} characters` : name}`,
      );
    }
    for (const name of ["occ.custom-secret-v2", "s".repeat(253)]) {
      const { stdout } = await render(enable, { strings: { [field]: name } });
      assert.match(stdout, new RegExp(`\\b${name.replaceAll(".", "\\.")}\\b`), field);
    }
  });
}

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

const externalGatewayCaValues = {
  ...externalGatewayRoutingValues,
  "gatewayRouting.issuerRef.kind": "ClusterIssuer",
  "gatewayRouting.issuerRef.group": "cert-manager.io",
  "gatewayRouting.caSecretName": "occ-private-ca",
  "gatewayRouting.caSecretKey": "ca.crt",
};
const gatewayRootSecret = rootSecretName("openclaw-system", "oce-agent-gateways");
const gatewayCertificateSecretCollisions = [
  [gatewayRoutingValues, "oce-agent-gateways-tls", "gatewayRouting.tlsSecretName"],
  [gatewayRoutingValues, gatewayRootSecret, "the generated Gateway root CA"],
  [externalGatewayCaValues, "occ-private-ca", "gatewayRouting.caSecretName"],
];

function dedicatedSecretRefusal(setting, secret, holder) {
  const message = `${setting} must name a dedicated Secret; ${secret} is also ${holder}`;
  return ({ code, stderr }) => code !== 0 && stderr.includes(message);
}

test(
  "the chart refuses sign-in Secrets that share a Gateway certificate Secret",
  tooling,
  async () => {
    // cert-manager writes the generated Gateway TLS and root CA Secrets and would overwrite a
    // sign-in Secret sharing either name (finding 1046).
    for (const [routing, secret, role] of gatewayCertificateSecretCollisions) {
      await assert.rejects(
        render({ ...routing, ...googleLoginValues, "auth.google.secretName": secret }),
        dedicatedSecretRefusal("auth.google.secretName", secret, role),
        secret,
      );
      // Without gateway routing those names are free.
      await render({ ...googleLoginValues, "auth.google.secretName": secret });
    }
    await render({ ...externalGatewayCaValues, ...googleLoginValues });
  },
);

test(
  "the chart refuses log collector Secrets shared with any credential Secret",
  tooling,
  async () => {
    // Finding 1054: the collector's Secrets join the dedicated-Secret table, so cert-manager
    // cannot overwrite a collector config named like a Gateway certificate Secret.
    for (const [feature, secret, role] of [
      [{}, "occ-installation-startup", "installation.secretName"],
      [{}, "occ-database", "database.secretName"],
      [{}, "occ-auth", "auth.secretName"],
      ...gatewayCertificateSecretCollisions,
      [databaseCaValues, "occ-rds-ca", "database.caSecretName"],
      [sandboxValues, "preview-wildcard", "gatewayRouting.sandbox.tlsSecretName"],
      [chatgptValues, "occ-chatgpt-admin", "backend.chatgpt.secretName"],
    ]) {
      for (const key of ["configSecretName", "envSecretName"]) {
        const setting = `logging.collector.${key}`;
        await assert.rejects(
          render({ ...productionCollectorValues, ...feature, [setting]: secret }),
          dedicatedSecretRefusal(setting, secret, role),
          `${key} = ${secret}`,
        );
      }
    }
    await assert.rejects(
      render({
        ...productionCollectorValues,
        "logging.collector.envSecretName": "occ-otel-collector-config",
      }),
      /logging\.collector\.envSecretName must name a dedicated Secret; occ-otel-collector-config is also logging\.collector\.configSecretName/,
    );
    // A disabled feature's Secret name is free, as preflight treats the ChatGPT admin Secret.
    await render({
      ...productionCollectorValues,
      "logging.collector.configSecretName": "occ-chatgpt-admin",
    });
  },
);

test("the chart requires installation and database Secret names", tooling, async () => {
  // Finding 1055: an empty name rendered `secretName: ""` instead of failing at template time.
  for (const [key, message] of [
    ["installation.secretName", "installation startup"],
    ["database.secretName", "database URL"],
  ]) {
    // `null` removes the key, which must fail the same way as an empty name.
    for (const value of ["", "null"]) {
      await assert.rejects(
        render({ [key]: value }),
        ({ code, stderr }) =>
          code !== 0 && stderr.includes(`${key} must name the operator-created ${message} Secret`),
        `${key}=${value}`,
      );
    }
  }
});

test(
  "the chart refuses credential Secrets shared with the database CA or sandbox TLS Secret",
  tooling,
  async () => {
    // Finding 1048: the dedicated-Secret rule covers every Secret an enabled feature reads.
    const sandbox = gatewaySandboxValues;
    for (const [base, setting, secret, other] of [
      [
        { ...databaseCaValues, ...googleLoginValues },
        "auth.google.secretName",
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
        { ...sandbox, ...googleLoginValues },
        "auth.google.secretName",
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
        dedicatedSecretRefusal(setting, secret, other),
        `${setting} = ${secret}`,
      );
      // The same values with distinct names render.
      await render(base);
    }
  },
);

test("the chart lets the public CA settings share one trust bundle Secret", tooling, async () => {
  // Finding 1059: each CA setting mounts only its selected key of public trust data, so one
  // trust bundle Secret may serve all of them. Private and cert-manager Secrets stay dedicated.
  const base = {
    ...externalGatewayCaValues,
    ...databaseCaValues,
    ...repositoryCredentialValues,
  };
  const settings = [
    "database.caSecretName",
    "gatewayRouting.caSecretName",
    "repositoryCredentials.publicCaSecretName",
  ];
  for (const [index, first] of settings.entries()) {
    for (const second of settings.slice(index + 1)) {
      await render({ ...base, [first]: "occ-trust-bundle", [second]: "occ-trust-bundle" });
    }
  }
  const shared = Object.fromEntries(settings.map((setting) => [setting, "occ-trust-bundle"]));
  const objects = await renderObjects({ ...base, ...shared });
  const api = findResource(objects, "Deployment", "openclaw-enterprise-api").spec.template.spec;
  assert.deepEqual(
    api.volumes
      .filter((volume) => volume.secret?.secretName === "occ-trust-bundle")
      .map((volume) => [volume.name, volume.secret.items.map(({ key }) => key)])
      .sort(),
    [
      ["database-ca", ["ca.pem"]],
      ["gateway-ca", ["ca.crt"]],
      ["repository-public-ca", ["ca.crt"]],
    ],
  );
  // The bundle still may not hold a credential or a Secret cert-manager writes.
  for (const [setting, secret, message] of [
    ["database.caSecretName", "occ-database", "database.caSecretName / database.secretName"],
    [
      "repositoryCredentials.tlsSecretName",
      "occ-trust-bundle",
      "repositoryCredentials.tlsSecretName / database.caSecretName",
    ],
    [
      "gatewayRouting.apiKeySecretName",
      "occ-trust-bundle",
      "gatewayRouting.apiKeySecretName / database.caSecretName",
    ],
    [
      "gatewayRouting.tlsSecretName",
      "occ-trust-bundle",
      "database.caSecretName / gatewayRouting.tlsSecretName",
    ],
  ]) {
    const [refused, holder] = message.split(" / ");
    await assert.rejects(
      render({ ...base, ...shared, [setting]: secret }),
      dedicatedSecretRefusal(refused, secret, holder),
      `${setting} = ${secret}`,
    );
  }
  // An external issuer creates no root CA Secret, so its generated name is free.
  await render({ ...base, ...googleLoginValues, "auth.google.secretName": gatewayRootSecret });
  await assert.rejects(
    render({
      ...gatewayRoutingValues,
      ...googleLoginValues,
      "auth.google.secretName": gatewayRootSecret,
    }),
    /auth\.google\.secretName must name a dedicated Secret; \S+ is also the generated Gateway root CA/,
  );
});

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
      const objects = await renderObjects(externalGatewayRoutingValues, { namespace });
      const gateway = objects.find((object) => object.kind === "Gateway");
      assert.equal(gateway.metadata.namespace, namespace);
    }
    for (const [description, override, message] of productionChartRendererRefusalCases({
      agentNativeAdminValues,
      chatgptValues,
      externalGatewayRoutingValues,
      gatewayRootSecret: rootSecretName("openclaw-system", "oce-agent-gateways"),
      gatewayRoutingValues,
      googleLoginValues,
    })) {
      // Rejection comes from the actual Helm templates, not a reimplemented test validator.
      await assert.rejects(
        render(override),
        ({ code, stderr }) => code !== 0 && stderr.length > 0 && (!message || message.test(stderr)),
        description,
      );
    }
    for (const [provider, override] of [
      ["google", { ...googleLoginValues, "auth.google.clientIdKey": ".hidden" }],
      [
        "oidc",
        {
          "auth.oidc.enabled": "true",
          "auth.recoveryUserId": "recovery-admin_1",
          "auth.oidc.issuer": "https://tenant.idp.example.test/",
          "auth.oidc.authorizationUrl": "https://tenant.idp.example.test/authorize",
          "auth.oidc.tokenUrl": "https://tenant.idp.example.test/oauth/token",
          "auth.oidc.jwksUrl": "https://tenant.idp.example.test/.well-known/jwks.json",
          "auth.oidc.clientSecretKey": "a".repeat(253),
        },
      ],
    ]) {
      assert.match(
        (await render(override)).stdout,
        new RegExp(`OCC_AUTH_${provider.toUpperCase()}`),
      );
    }
    assert.match(
      (await render({ ...chatgptValues, "backend.chatgpt.key": ".hidden" })).stdout,
      /key: "\.hidden"/,
    );
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
    const objects = await renderObjects(
      { ...gatewayRoutingValues, ...slackProxyValues },
      { namespace },
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
      const objects = await renderObjects(features, { release, namespace, strings });
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
          { cwd: repository, env: goToolEnvironment(), maxBuffer: 2_000_000 },
        )
      ).stdout,
    );
    assert.deepEqual(nonStringIdentifiers(execution), []);
  },
);

test("default routing refuses missing operator configuration", tooling, async () => {
  // Omitting the switch must still require both operator-owned prerequisite names.
  const options = { omit: ["gatewayRouting.enabled"] };
  await assert.rejects(
    render({}, options),
    /gatewayRouting\.gatewayClassName must reference an operator-created GatewayClass/,
  );
  await assert.rejects(
    render({ "gatewayRouting.gatewayClassName": "eg" }, options),
    /gatewayRouting\.apiKeySecretName must reference an operator-created Opaque Secret/,
  );
});

function deploymentPodSpec(objects, component) {
  return objects.find(
    ({ kind, metadata }) =>
      kind === "Deployment" && metadata.labels["app.kubernetes.io/component"] === component,
  ).spec.template.spec;
}

test(
  "private Envoy Gateway routing defaults on with automatic CA and deterministic hostnames",
  tooling,
  async () => {
    const gatewayName = "oce-agent-gateways";
    const gatewayNamespace = "openclaw-system";
    const envoyNamespace = "envoy-gateway-system";
    const label = routeNamespaceLabel(gatewayNamespace, gatewayName);
    const serviceName = gatewayServiceName(gatewayNamespace, gatewayName);
    const hostname = defaultGatewayHostname(gatewayNamespace, gatewayName, envoyNamespace);
    const rootSecret = rootSecretName(gatewayNamespace, gatewayName);
    const configured = await renderObjects(
      { ...gatewayRoutingValues, ...controlPlaneSelectorValues },
      { omit: ["gatewayRouting.enabled"] },
    );
    const alternateNamespace = "openclaw-alt";
    const alternateObjects = await renderObjects(gatewayRoutingValues, {
      namespace: alternateNamespace,
    });
    const envoyPolicyName = envoyNetworkPolicyName("oce", gatewayNamespace, gatewayName);
    const alternateEnvoyPolicyName = envoyNetworkPolicyName("oce", alternateNamespace, gatewayName);
    assert.notEqual(envoyPolicyName, alternateEnvoyPolicyName);
    assert.match(envoyPolicyName, /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    assert.ok(envoyPolicyName.length <= 63);
    // Truncating a dotted release name can leave a trailing "." (finding 2338).
    for (const release of [`${"a".repeat(33)}.b`, `${"a".repeat(33)}-b`]) {
      const names = (await renderObjects(gatewayRoutingValues, { release }))
        .filter(({ kind }) => kind === "NetworkPolicy")
        .map(({ metadata }) => metadata.name)
        .filter((name) => name.endsWith("-envoy-dataplane"));
      assert.equal(names.length, 1);
      assert.match(names[0], new RegExp(`^${"a".repeat(33)}-[0-9a-f]{12}-envoy-dataplane$`));
    }
    assert.ok(
      alternateObjects.some(
        ({ kind, metadata }) =>
          kind === "NetworkPolicy" &&
          metadata.namespace === envoyNamespace &&
          metadata.name === alternateEnvoyPolicyName,
      ),
    );

    for (const component of ["api", "worker"]) {
      const pod = deploymentPodSpec(configured, component);
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

    const bootstrapIssuer = findResource(configured, "Issuer", `${serviceName}-bootstrap`);
    assert.deepEqual(bootstrapIssuer.spec, { selfSigned: {} });
    const caIssuer = findResource(configured, "Issuer", `${serviceName}-ca`);
    assert.deepEqual(caIssuer.spec, { ca: { secretName: rootSecret } });

    const rootCertificate = findResource(configured, "Certificate", rootSecret);
    assert.deepEqual(rootCertificate.spec, {
      isCA: true,
      commonName: rootSecret,
      secretName: rootSecret,
      duration: "87600h",
      renewBefore: "720h",
      privateKey: { algorithm: "ECDSA", size: 256, rotationPolicy: "Never" },
      issuerRef: { name: `${serviceName}-bootstrap`, kind: "Issuer", group: "cert-manager.io" },
    });

    const leafCertificate = findResource(configured, "Certificate", `${gatewayName}-tls`);
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
    const apiEnvoyEgress = findResource(
      configured,
      "NetworkPolicy",
      "openclaw-enterprise-controller-envoy-egress",
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

    const envoyPolicy = findResource(configured, "NetworkPolicy", envoyPolicyName);
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
    const configured = await renderObjects({
      ...externalGatewayRoutingValues,
      "gatewayRouting.caSecretName": "occ-private-ca",
      "gatewayRouting.caSecretKey": "ca.crt",
    });
    const gatewayName = "oce-agent-gateways";
    const gatewayNamespace = "openclaw-system";
    const serviceName = gatewayServiceName(gatewayNamespace, gatewayName);
    const apiPod = deploymentPodSpec(configured, "api");
    const workerPod = deploymentPodSpec(configured, "worker");

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
    const leafCertificate = findResource(configured, "Certificate", `${gatewayName}-tls`);
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
    const objects = await renderObjects(productionCollectorValues, { strings: { [field]: value } });
    const policy = findResource(objects, "NetworkPolicy", "openclaw-enterprise-collector-egress");
    assert.deepEqual(policy.spec.egress.at(-1).ports, [{ protocol: "TCP", port: Number(value) }]);
  }
  const numeric = await renderObjects({ ...productionCollectorValues, [field]: 3100 });
  assert.deepEqual(
    numeric
      .find(({ metadata }) => metadata.name === "openclaw-enterprise-collector-egress")
      .spec.egress.at(-1).ports,
    [{ protocol: "TCP", port: 3100 }],
  );
});

test(
  "the chart refuses control-plane node selectors the volume helper refuses",
  tooling,
  async (t) => {
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
    const directory = await temporaryDirectory(t, "openclaw-node-selector-");
    const selectorValues = join(directory, "selector.yaml");
    await writeFile(
      selectorValues,
      "controlPlane:\n  nodeSelector:\n    Example.com/role: control\n",
    );
    await assert.rejects(
      render({}, { valuesFiles: [selectorValues] }),
      ({ code, stderr }) => code !== 0 && keyMessage.test(stderr),
    );
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
  // A later --set or --set-string replaces the helper's routing.hostname.
  const template = renderExecutionChart;
  await assert.rejects(
    template("--set", "routing.hostname=Bad_Host"),
    /routing\.hostname must be a DNS hostname without a port or path/,
  );
  // --set reads these as a number and a boolean; the chart names the field instead of failing in len.
  for (const hostname of ["123", "true"]) {
    await assert.rejects(
      template("--set", `routing.hostname=${hostname}`),
      /routing\.hostname must be a string: quote a value YAML reads as a number or boolean, or pass it with --set-string/,
      hostname,
    );
  }
  for (const hostname of [
    "123",
    "127.1",
    "0x",
    "0x.0.0.1",
    "1.2.3.4.5",
    "api.0x10",
    "api.123",
    "999.1.2.3",
    "example.0x10",
  ]) {
    await assert.rejects(
      template("--set-string", `routing.hostname=${hostname}`),
      /routing\.hostname must be .*numeric or 0x last label parses as IPv4; use a DNS name resolving to the gateway that its TLS certificate covers/,
      hostname,
    );
  }
  for (const hostname of ["agents.example.invalid", "0xdead.gateway.example.test"]) {
    const { stdout } = await template("--set-string", `routing.hostname=${hostname}`);
    const gateway = (await resources(stdout)).find((object) => object.kind === "Gateway");
    assert.equal(gateway?.spec.listeners[0].hostname, hostname);
  }
});

test(
  "execution chart refuses an Envoy HTTPS port or DNS namespace the cluster refuses",
  tooling,
  async () => {
    const template = renderExecutionChart;
    const proxyPolicy = async (stdout) =>
      findResource(await resources(stdout), "NetworkPolicy", "oce-harness-proxy");
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

test(
  "the plugin request guard installs beside OpenShell without control-plane access",
  tooling,
  async () => {
    const clients = [
      {
        namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "execution" } },
        podSelector: { matchLabels: { "openshell.ai/boundary-role": "supervisor" } },
      },
    ];
    const template = (...args) =>
      execute(
        helm,
        [
          "template",
          "guard",
          "deploy/helm/openclaw-plugin-request-guard",
          "--set",
          `image=${values["images.controller"]}`,
          "--set",
          "tlsSecretName=guard-tls,issuerSecretName=issuer-keys,issuer=openshell,keyId=current",
          "--set-json",
          `clients=${JSON.stringify(clients)}`,
          ...args,
        ],
        { cwd: repository, env: goToolEnvironment() },
      );

    const objects = await resources((await template()).stdout);
    const specs = Object.fromEntries(objects.map(({ kind, spec }) => [kind, spec]));
    assert.deepEqual(Object.keys(specs).sort(), ["Deployment", "NetworkPolicy", "Service"]);
    const pod = specs.Deployment.template;
    assert.deepEqual(specs.Service.selector, pod.metadata.labels);
    assert.deepEqual(specs.NetworkPolicy.podSelector, specs.Deployment.selector);
    assert.deepEqual(specs.NetworkPolicy.ingress, [
      { from: clients, ports: [{ protocol: "TCP", port: 9445 }] },
    ]);
    assert.deepEqual(specs.NetworkPolicy.policyTypes, ["Ingress", "Egress"]);
    assert.deepEqual(specs.NetworkPolicy.egress, []);
    assert.deepEqual(specs.Service.ports, [
      { name: "plugin-requests", port: 9445, targetPort: "plugin-requests" },
    ]);
    assert.equal(pod.spec.automountServiceAccountToken, false);
    assert.equal(pod.spec.enableServiceLinks, false);
    assert.equal(pod.spec.securityContext.runAsNonRoot, true);
    const [guard] = pod.spec.containers;
    assert.equal(guard.image, values["images.controller"]);
    assert.deepEqual(guard.args, ["apps/controller/src/plugin-request-guard.ts"]);
    assert.deepEqual(Object.fromEntries(guard.env.map(({ name, value }) => [name, value])), {
      OCC_PLUGIN_REQUEST_AUTHORITY_PORT: "9445",
      OCC_PLUGIN_REQUEST_AUTHORITY_ISSUER: "openshell",
      OCC_PLUGIN_REQUEST_AUTHORITY_KEY_ID: "current",
    });
    assert.deepEqual(guard.volumeMounts, [
      { name: "trust", mountPath: "/etc/openclaw/egress", readOnly: true },
    ]);
    assert.deepEqual(
      pod.spec.volumes.map((volume) => volume.projected.sources),
      [
        [
          {
            secret: {
              name: "guard-tls",
              items: [
                { key: "tls.crt", path: "tls/tls.crt" },
                { key: "tls.key", path: "tls/tls.key" },
              ],
            },
          },
          {
            secret: {
              name: "issuer-keys",
              items: [{ key: "public.pem", path: "issuer/issuer.pub" }],
            },
          },
        ],
      ],
    );

    await assert.rejects(template("--set", "image=controller:latest"), /image/);
    await assert.rejects(
      template("--set-json", 'clients=[{"namespaceSelector":{},"podSelector":{}}]'),
      /matchLabels/,
    );
  },
);

test(
  "protected authority packaging confines keys and listener to the owning control plane",
  tooling,
  async () => {
    const protectedValues = {
      "backend.openshell.clientSecretName": "dedicated-openshell-admin",
      "egressAuthority.enabled": "true",
      "egressAuthority.tlsSecretName": "authority-server-tls",
      "egressAuthority.issuerSecretName": "gateway-jwt-keys",
      "egressAuthority.clients[0].namespaceSelector.matchLabels.kubernetes\\.io/metadata\\.name":
        "openshell-system",
      "egressAuthority.clients[0].podSelector.matchLabels.app": "openshell-gateway",
    };
    const defaults = await resources((await render()).stdout);
    assert.ok(
      !defaults.some((object) => object.metadata?.name === "openclaw-enterprise-egress-authority"),
    );
    const issuerPolicyName = "openclaw-enterprise-prepared-github-issuer-egress";
    assert.ok(!defaults.some((object) => object.metadata?.name === issuerPolicyName));
    for (const workload of defaults.filter((object) => object.kind === "Deployment")) {
      assert.ok(
        !workload.spec.template.spec.volumes?.some(
          ({ name }) => name.startsWith("egress-authority") || name === "openshell-client",
        ),
      );
    }
    const objects = await resources((await render(protectedValues)).stdout);
    assert.ok(!objects.some((object) => object.metadata?.name === issuerPolicyName));
    const service = findResource(objects, "Service", "openclaw-enterprise-egress-authority");
    assert.equal(service.spec.type, "ClusterIP");
    assert.equal(service.spec.selector["app.kubernetes.io/component"], "api");
    assert.deepEqual(service.spec.ports, [
      { name: "egress-tls", port: 9444, targetPort: "egress-tls" },
    ]);
    const ingress = findResource(
      objects,
      "NetworkPolicy",
      "openclaw-enterprise-egress-authority-ingress",
    );
    assert.equal(ingress.spec.podSelector.matchLabels["app.kubernetes.io/component"], "api");
    assert.deepEqual(ingress.spec.ingress, [
      {
        from: [
          {
            namespaceSelector: {
              matchLabels: { "kubernetes.io/metadata.name": "openshell-system" },
            },
            podSelector: { matchLabels: { app: "openshell-gateway" } },
          },
        ],
        ports: [{ protocol: "TCP", port: 9444 }],
      },
    ]);
    for (const component of ["api", "worker"]) {
      const pod = findResource(objects, "Deployment", `openclaw-enterprise-${component}`).spec
        .template.spec;
      const client = pod.volumes.find(({ name }) => name === "openshell-client");
      assert.equal(client.secret.secretName, "dedicated-openshell-admin");
      assert.deepEqual(client.secret.items.map(({ key }) => key).sort(), [
        "ca.crt",
        "tls.crt",
        "tls.key",
      ]);
      const container = pod.containers.find(({ name }) => name === component);
      assert.deepEqual(
        container.volumeMounts.find(({ name }) => name === "openshell-client"),
        { name: "openshell-client", mountPath: "/etc/openclaw/openshell", readOnly: true },
      );
      const issuer = pod.volumes.find(({ name }) => name === "egress-authority-issuer");
      if (component === "api") {
        assert.deepEqual(issuer.secret.items, [{ key: "public.pem", path: "issuer.pub" }]);
        assert.equal(issuer.secret.secretName, "gateway-jwt-keys");
        assert.equal(
          pod.volumes.find(({ name }) => name === "egress-authority-tls").secret.secretName,
          "authority-server-tls",
        );
        assert.ok(
          container.ports.some(
            ({ name, containerPort }) => name === "egress-tls" && containerPort === 9444,
          ),
        );
      } else {
        assert.equal(issuer, undefined);
        assert.ok(!pod.volumes.some(({ name }) => name === "egress-authority-tls"));
      }
    }
    // Initialization has only database/bootstrap duties; it never receives Gateway admin or issuer keys.
    for (const job of objects.filter(({ kind }) => kind === "Job")) {
      assert.ok(
        !job.spec.template.spec.volumes?.some(
          ({ name }) => name === "openshell-client" || name.startsWith("egress-authority"),
        ),
      );
    }
    for (const [override, diagnostic] of [
      [{ "egressAuthority.tlsSecretName": "" }, /tlsSecretName is required/],
      [{ "egressAuthority.issuerSecretName": "" }, /issuerSecretName is required/],
      [{ "egressAuthority.clients": "null" }, /clients must select/],
      [{ "egressAuthority.clients[0].podSelector": "null" }, /podSelector.matchLabels/],
      [{ "egressAuthority.port": "8080" }, /distinct TCP port/],
      [{ "egressAuthority.port": "65536" }, /distinct TCP port/],
      // The API runs as UID 1000 without capabilities: a port below 1024 cannot bind.
      [{ "egressAuthority.port": "1023" }, /distinct TCP port from 1024/],
      // Sprig int read "09444" as 0 and startup refused the text, after the install.
      [
        { "egressAuthority.port": "09444" },
        /egressAuthority.port must be a TCP port without leading/,
      ],
      [
        { "backend.openshell.clientSecretName": "authority-server-tls" },
        /egressAuthority.tlsSecretName must name a dedicated Secret.*backend.openshell.clientSecretName/,
      ],
      [
        { "egressAuthority.issuerSecretName": "authority-server-tls" },
        /egressAuthority.issuerSecretName must name a dedicated Secret.*egressAuthority.tlsSecretName/,
      ],
    ]) {
      await assert.rejects(render({ ...protectedValues, ...override }), diagnostic);
    }

    const prepared = {
      ...protectedValues,
      "preparedGitHub.custodySecretName": "prepared-github-custody",
      "preparedGitHub.issuerCidrs[0]": "192.0.2.19/32",
    };
    // Kubernetes interprets a null NetworkPolicyPort.port as every TCP port to this peer.
    const portKey = "preparedGitHub.issuerPort";
    for (const invalid of [null, "", "https", 0, 65536, "0443"]) {
      await assert.rejects(
        render({ ...prepared, [portKey]: invalid }),
        /preparedGitHub.issuerPort must be/,
      );
    }
    for (const override of [{}, { [portKey]: 10443 }]) {
      const rendered = await resources((await render({ ...prepared, ...override })).stdout);
      const { spec } = rendered.find(({ metadata }) => metadata?.name === issuerPolicyName);
      assert.deepEqual(spec.egress, [
        {
          to: [{ ipBlock: { cidr: "192.0.2.19/32" } }],
          ports: [{ protocol: "TCP", port: override[portKey] ?? 443 }],
        },
      ]);
    }
  },
);

test(
  "protected OpenShell Git installs without a repository broker and refuses the retired trial",
  tooling,
  async () => {
    const selected = {
      ...protectedRepositoryValues,
      "openshellGit.enabled": "true",
      "openshellGit.tlsSecretName": "openshell-git-tls",
      "openshellGit.issuerPublicKeyConfigMapName": "openshell-gateway-public",
      "openshellGit.clients[0].namespaceSelector.matchLabels.kubernetes\\.io/metadata\\.name":
        "openshell-system",
      "openshellGit.clients[0].podSelector.matchLabels.app": "openshell-supervisor",
    };
    const defaults = await renderObjects();
    assert.ok(!defaults.some(({ metadata }) => metadata?.name?.includes("openshell-git")));
    const { stdout } = await render(selected);
    // Check the entire installation, including Services, probes, ingress and broker-specific RBAC.
    assert.doesNotMatch(
      stdout,
      /8443|repository-credentials|prepared-repository-ingress|repository-(?:public-ca|control|inputs|private)/,
    );
    const objects = await resources(stdout);
    const workerRole = objects.find(
      ({ kind, metadata }) => kind === "ClusterRole" && metadata.name.endsWith("-tenant-worker"),
    );
    assert.ok(
      !workerRole.rules.some(
        ({ resources, verbs }) => resources.includes("secrets") && verbs.includes("list"),
      ),
      "protected Git does not grant the broker's Secret enumeration privilege",
    );
    const issuer = objects.find(({ metadata }) =>
      metadata.name.endsWith("-repository-provider-egress"),
    );
    assert.deepEqual(issuer.spec.egress, [
      { to: [{ ipBlock: { cidr: "198.51.100.23/32" } }], ports: [{ protocol: "TCP", port: 443 }] },
    ]);
    const service = findResource(objects, "Service", "openclaw-enterprise-openshell-git");
    assert.equal(service.spec.type, "ClusterIP");
    assert.equal(service.spec.selector["app.kubernetes.io/component"], "worker");
    assert.deepEqual(service.spec.ports, [
      { name: "openshell-git", port: 8445, targetPort: "openshell-git", protocol: "TCP" },
    ]);
    const policy = findResource(
      objects,
      "NetworkPolicy",
      "openclaw-enterprise-openshell-git-ingress",
    );
    assert.equal(policy.spec.podSelector.matchLabels["app.kubernetes.io/component"], "worker");
    assert.deepEqual(policy.spec.ingress, [
      {
        from: [
          {
            namespaceSelector: {
              matchLabels: { "kubernetes.io/metadata.name": "openshell-system" },
            },
            podSelector: { matchLabels: { app: "openshell-supervisor" } },
          },
        ],
        ports: [{ protocol: "TCP", port: 8445 }],
      },
    ]);
    for (const object of objects.filter(({ kind }) => ["Deployment", "Job"].includes(kind))) {
      const pod = object.spec.template.spec;
      const volume = pod.volumes?.find(({ name }) => name === "openshell-git");
      if (object.metadata.name !== "openclaw-enterprise-worker") {
        assert.equal(volume, undefined);
        assert.ok(!pod.volumes?.some(({ name }) => name.startsWith("prepared-repository-")));
        continue;
      }
      assert.equal(volume.projected.defaultMode, 0o440);
      assert.deepEqual(volume.projected.sources, [
        {
          secret: {
            name: "openshell-git-tls",
            items: [
              { key: "tls.crt", path: "tls.crt" },
              { key: "tls.key", path: "tls.key" },
            ],
          },
        },
        {
          configMap: {
            name: "openshell-gateway-public",
            items: [{ key: "gateway-public.pem", path: "gateway-public.pem" }],
          },
        },
      ]);
      assert.deepEqual(
        pod.containers.map(({ name }) => name),
        ["worker"],
      );
      assert.equal(object.spec.strategy.type, "Recreate", "stop the old owner before replacement");
      const worker = pod.containers[0];
      assert.deepEqual(
        pod.volumes
          .find(({ name }) => name === "prepared-repository-owner")
          .projected.sources.map(({ secret }) => secret.name),
        ["repository-app-key", "git-custody"],
      );
      for (const name of [
        "repository-registry",
        "prepared-repository-owner",
        "prepared-repository-ca",
      ]) {
        assert.ok(
          worker.volumeMounts.some((mount) => mount.name === name && mount.readOnly),
          name,
        );
      }
      assert.deepEqual(
        worker.volumeMounts.find(({ name }) => name === "openshell-git"),
        { name: "openshell-git", mountPath: "/etc/openclaw/openshell-git", readOnly: true },
      );
      assert.ok(
        worker.ports.some(
          ({ name, containerPort }) => name === "openshell-git" && containerPort === 8445,
        ),
      );
    }
    const upgrade = await render(selected, { isUpgrade: true });
    assert.doesNotMatch(upgrade.stdout, /8443|repository-public-ca|repository-control/);
    const job = (await resources(upgrade.stdout)).find(({ kind }) => kind === "Job");
    const check = job.spec.template.spec.initContainers.find(
      ({ name }) => name === "installation-check",
    );
    assert.deepEqual(
      check.volumeMounts.filter(({ name }) => /repository|openshell-git/.test(name)),
      [
        {
          name: "repository-registry",
          mountPath: "/etc/openclaw/repository-registry",
          readOnly: true,
        },
      ],
    );
    // An older trial must drain on its original owner, not restart with this chart.
    const oldTrial = {
      ...selected,
      ...repositoryCredentialValues,
      "repositoryCredentials.serviceName": "git",
    };
    await assert.rejects(
      render(oldTrial, { isUpgrade: true }),
      /protected Git requires the repository broker disabled/,
    );
    await assert.rejects(
      render({ ...oldTrial, "openshellGit.mode": "broker-trial" }, { isUpgrade: true }),
      /drain the earlier broker trial on its original owner/,
    );
    const sealed = await renderObjects({
      ...selected,
      ...gatewayRoutingValues,
      "preprovisionedNamespace.namespaceId": "ns_fixture",
      "preprovisionedNamespace.uid": "11111111-2222-3333-4444-555555555555",
    });
    const namespaceRules = sealed.flatMap(({ kind, rules }) =>
      kind === "ClusterRole" ? rules.filter((rule) => rule.resources?.includes("namespaces")) : [],
    );
    assert.equal(namespaceRules.length, 2, "named namespace access for API and worker");
    for (const rule of namespaceRules) {
      assert.deepEqual(rule.verbs, ["get"]);
      assert.equal(rule.resourceNames.length, 1);
    }
    assert.ok(!sealed.some(({ kind }) => kind === "Job"), "do not bootstrap a sealed installation");
    for (const [override, diagnostic] of [
      [{ "repositoryCredentials.authority": "github-app" }, /authority prepared-git/],
      [
        { "openshellGit.mode": "broker-trial" },
        /drain the earlier broker trial on its original owner/,
      ],
      [
        { "repositoryCredentials.preparedCustodySecretName": "" },
        /preparedCustodySecretName is required/,
      ],
      [{ "openshellGit.tlsSecretName": "" }, /openshellGit.tlsSecretName is required/],
      [
        { "openshellGit.issuerPublicKeyConfigMapName": "" },
        /issuerPublicKeyConfigMapName is required/,
      ],
      [{ "openshellGit.clients": "null" }, /select trusted supervisor callers/],
      [{ "openshellGit.clients[0].podSelector": "null" }, /podSelector.matchLabels/],
      [{ "openshellGit.clients[0].namespaceSelector": "null" }, /namespaceSelector.matchLabels/],
      [{ "openshellGit.port": "8443" }, /distinct from repository/],
      [{ "openshellGit.port": "65536" }, /unprivileged TCP port/],
      [{ "openshellGit.port": "8445.5" }, /positive safe integer/],
      // Sprig int read "02000" as octal 1024 and startup refused the text, after the install.
      [{ "openshellGit.port": "02000" }, /openshellGit.port must be a TCP port without leading/],
      // The provider egress rule read "02000" as port 1024 and "0x7d0" as 2000.
      [
        { "repositoryCredentials.upstreamPort": "02000" },
        /repositoryCredentials.upstreamPort must be a TCP port without leading/,
      ],
      [
        { "repositoryCredentials.upstreamPort": "0x7d0" },
        /repositoryCredentials.upstreamPort must be a positive safe integer/,
      ],
      [{ "openshellGit.tlsSecretName": "repository-app-key" }, /must name a dedicated Secret/],
    ]) {
      await assert.rejects(render({ ...selected, ...override }), diagnostic);
    }
  },
);

test(
  "Helm supplies protected Git custody for a separately installed Credential Proxy",
  tooling,
  async () => {
    const delivery = "repositoryCredentials.delivery";
    const selected = { ...protectedRepositoryValues, [delivery]: "credential-proxy" };

    // Staging the registry, issuer key and custody does not select a protected sender.
    const inactive = (await render(protectedRepositoryValues)).stdout;
    assert.equal(inactive, (await render()).stdout);

    for (const isUpgrade of [false, true]) {
      const { stdout } = await render(selected, { isUpgrade });
      assert.doesNotMatch(
        stdout,
        /844[35]|openshell-git|repository-credentials|prepared-repository-ingress|repository-(?:public-ca|control|inputs|private)/,
      );
      const objects = await resources(stdout);
      const policy = objects.find(({ metadata }) =>
        metadata.name.endsWith("-repository-provider-egress"),
      );
      assert.equal(policy?.spec.podSelector.matchLabels["app.kubernetes.io/component"], "worker");
      assert.deepEqual(policy.spec.egress, [
        {
          to: [{ ipBlock: { cidr: "198.51.100.23/32" } }],
          ports: [{ protocol: "TCP", port: 443 }],
        },
      ]);

      // The API and installation check can read the registry. Only the worker gets signing and custody keys.
      const readers = {};
      for (const { spec } of objects.filter(({ kind }) => ["Deployment", "Job"].includes(kind))) {
        const pod = spec.template.spec;
        for (const container of [...(pod.initContainers ?? []), ...pod.containers]) {
          const mounts = (container.volumeMounts ?? [])
            .filter(({ name }) => name.includes("repository"))
            .map(({ name, readOnly }) => {
              assert.equal(readOnly, true, name);
              return name;
            });
          if (mounts.length) {
            readers[container.name] = mounts;
          }
        }
        if (!pod.containers.some(({ name }) => name === "worker")) {
          continue;
        }
        assert.equal(spec.strategy.type, "Recreate");
        const owner = pod.volumes.find(({ name }) => name === "prepared-repository-owner");
        assert.deepEqual(
          owner.projected.sources.map(({ secret }) => secret.name),
          ["repository-app-key", "git-custody"],
        );
      }
      const registry = ["repository-registry"];
      assert.deepEqual(readers, {
        api: registry,
        worker: [...registry, "prepared-repository-owner", "prepared-repository-ca"],
        "installation-check": registry,
      });
    }
    for (const [override, diagnostic] of [
      [{ [delivery]: "other" }, /delivery must be empty or credential-proxy/],
      [{ "repositoryCredentials.enabled": true }, /requires the repository broker disabled/],
      [{ "repositoryCredentials.authority": "github-app" }, /requires authority prepared-git/],
      [
        { "repositoryCredentials.upstreamCidrs": "null" },
        /must contain approved provider IPv4 CIDRs/,
      ],
    ]) {
      await assert.rejects(render({ ...selected, ...override }), diagnostic);
    }
  },
);

test(
  "gateway routing service type is limited to the EnvoyProxy service types",
  tooling,
  async () => {
    // EnvoyProxy envoyService.type accepts only these three. Any other value rendered, and the
    // apply failed after the pre-install hooks had migrated and bootstrapped the Installation.
    for (const serviceType of ["clusterIP", "ExternalName"]) {
      await assert.rejects(
        render({ ...gatewayRoutingValues, "gatewayRouting.serviceType": serviceType }),
        /gatewayRouting\.serviceType must be ClusterIP, LoadBalancer or NodePort/,
        serviceType,
      );
    }
    for (const serviceType of ["LoadBalancer", "NodePort"]) {
      const objects = await renderObjects({
        ...gatewayRoutingValues,
        "gatewayRouting.serviceType": serviceType,
      });
      const envoy = objects.find(({ kind }) => kind === "EnvoyProxy");
      assert.equal(envoy.spec.provider.kubernetes.envoyService.type, serviceType);
    }
  },
);

test("OpenShell Envoy cleanup reports rejected deletes and continues remaining cleanup", async (t) => {
  const directory = await temporaryDirectory(t, "envoy-cleanup-");
  const certificate = await selfSigned(directory);
  await withEnvironment(
    {
      OCC_TEST_GATEWAY_CA_CERT_PATH: certificate.certPath,
      OCC_TEST_GATEWAY_CA_KEY_PATH: certificate.keyPath,
    },
    async () => {
      for (const refused of ["gatewayclass", "networkpolicy"]) {
        const attempted = [];
        const testContext = new RecordingContext();
        // The plugin fixture registers its aggregate first on the raw context.
        testContext.after(async () => {
          attempted.push("fixture aggregate");
        });
        // Run the real plan and its Helm rendering. Only cluster I/O is substituted;
        // the regression concerns the actual registered cleanup's rejected command.
        await createEnvoyWorkspaceGatewayPlan(
          testContext,
          { platformNamespace: "cleanup-fixture" },
          {
            applyManifest: async () => {},
            waitFor: async (_description, read) => {
              assert.ok(await read());
            },
            resource: async (kind) => {
              if (kind === "secret") {
                return { data: { "tls.crt": certificate.cert } };
              }
              return {
                status: {
                  conditions: ["Ready", "Accepted", "Programmed"].map((type) => ({
                    type,
                    status: "True",
                  })),
                  listeners: [
                    { name: "https", conditions: [{ type: "Accepted", status: "True" }] },
                  ],
                },
              };
            },
            kubectl: async (...args) => {
              if (args[0] === "get") {
                return JSON.stringify({ items: [{ spec: { podCIDR: "10.42.0.0/24" } }] });
              }
              assert.equal(args[0], "delete");
              assert.ok(args.includes("--ignore-not-found=true"));
              if (args[1] === "gatewayclass") {
                assert.ok(args.includes("--wait=false"));
              }
              attempted.push(args[1]);
              if (args[1] === refused) {
                throw new Error("fixture delete rejected");
              }
              return "";
            },
          },
        );
        // Another helper receiving this raw context shares the Envoy cleanup group.
        withBoundedTeardown(testContext).after(() => attempted.push("relay cleanup"));
        await assert.rejects(async () => {
          for (const hook of testContext.hooks) {
            await hook();
          }
        }, /fixture delete rejected/);
        assert.equal(attempted[0], "fixture aggregate");
        assert.equal(attempted[1], "relay cleanup");
        assert.ok(attempted.includes("gatewayclass"));
        assert.ok(attempted.includes("networkpolicy"));
      }
    },
  );
});
