import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  createKubernetesClient,
  kubectlArguments,
  validateExplicitK3dLoopbackContext,
} from "./kubernetes-real.mjs";
import {
  parseProductionChart,
  productionCollectorValues,
  renderProductionChart,
} from "./production-chart.mjs";

const execute = promisify(execFile);
const componentLabel = "app.kubernetes.io/component";
const instanceLabel = "app.kubernetes.io/instance";
const deniedErrors = new Set([
  "ETIMEDOUT",
  "ETIMEOUT",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

// Resolve through the Pod's real kube-DNS configuration; TCP destinations are live listeners.
// Reporting transport errors as data keeps kubectl, image, and JavaScript failures fatal.
const probeCode = `
const {createConnection} = require('node:net');
const {Resolver} = require('node:dns/promises');
async function probe(target) {
  try {
    if (target.dns) {
      await new Resolver({timeout: 1500, tries: 1}).resolve4(target.dns);
    } else {
      await new Promise((resolve, reject) => {
        const socket = createConnection({host: target.host, port: target.port});
        socket.setTimeout(1500, () => socket.destroy(Object.assign(new Error(), {code: 'ETIMEDOUT'})));
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('error', reject);
      });
    }
    return 'connected';
  } catch (error) { return error.code; }
}
Promise.all(Object.entries(JSON.parse(process.argv[1])).map(async ([name, target]) =>
  [name, await probe(target)]
)).then(results => console.log(JSON.stringify(Object.fromEntries(results))));
`;

export async function createProductionNetworkAccess(t, { selection, image }) {
  assert.ok(image, "OCC_TEST_KUBERNETES_IMAGE must select an imported Kubernetes fixture image.");
  await validateExplicitK3dLoopbackContext(selection);
  const namespace = `oce-access-${randomUUID().slice(0, 8)}`;
  const destinations = `${namespace}-destinations`;
  const envoyNamespace = `${namespace}-envoy`;
  const ownedNamespaces = [];
  const kubectl = async (...args) =>
    (await execute("kubectl", kubectlArguments(selection, args), { timeout: 30_000 })).stdout;
  const { resource, waitFor } = createKubernetesClient({
    selection,
    kubectl,
    waitTimeoutMs: 60_000,
  });
  const apply = (objects) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        "kubectl",
        kubectlArguments(selection, ["apply", "-f", "-"]),
        { timeout: 30_000 },
        (error) => (error ? reject(error) : resolve()),
      );
      child.stdin.on("error", reject);
      child.stdin.end(JSON.stringify({ apiVersion: "v1", kind: "List", items: objects }));
    });
  t.after(async () => {
    if (ownedNamespaces.length) {
      await kubectl("delete", "namespace", ...ownedNamespaces, "--wait=false");
    }
  });
  for (const name of [namespace, destinations, envoyNamespace]) {
    await kubectl("create", "namespace", name);
    ownedNamespaces.push(name);
  }

  async function pod(name, podNamespace, labels, port) {
    await apply([
      {
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name, namespace: podNamespace, labels },
        spec: {
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000 },
          containers: [
            {
              name: "probe",
              image,
              imagePullPolicy: "Never",
              command: [
                "node",
                "-e",
                `for(const port of [${port},${port + 1}]) require('node:net').createServer(s=>s.end()).listen(port,'0.0.0.0')`,
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
                seccompProfile: { type: "RuntimeDefault" },
              },
              resources: {
                requests: { cpu: "10m", memory: "32Mi" },
                limits: { cpu: "250m", memory: "96Mi" },
              },
              readinessProbe: { tcpSocket: { port }, periodSeconds: 1 },
            },
          ],
        },
      },
    ]);
    return waitFor(`${podNamespace}/${name} listening`, async () => {
      const current = await resource("pod", name, podNamespace);
      return (
        current.status?.conditions?.some(
          (condition) => condition.type === "Ready" && condition.status === "True",
        ) && current.status.podIP
      );
    });
  }

  // Separate Pod IPs prevent a broad dependency rule from accidentally authorizing another role.
  // A node-hosted API endpoint would be unsuitable: CNIs can exempt traffic to the Pod's node.
  const targets = { dns: { dns: "kubernetes.default.svc.cluster.local" } };
  await Promise.all(
    Object.entries({
      database: 5432,
      cluster: 6443,
      exporter: 443,
      provider: 443,
      authentication: 443,
      catalog: 443,
      unexpected: 443,
    }).map(async ([name, port]) => {
      targets[name] = { host: await pod(name, destinations, {}, port), port };
    }),
  );
  targets.envoy = {
    host: await pod(
      "envoy",
      envoyNamespace,
      {
        "app.kubernetes.io/component": "proxy",
        "app.kubernetes.io/managed-by": "envoy-gateway",
        "app.kubernetes.io/name": "envoy",
        "gateway.envoyproxy.io/owning-gateway-namespace": namespace,
        "gateway.envoyproxy.io/owning-gateway-name": "access",
      },
      10443,
    ),
    port: 10443,
  };
  for (const name of ["database", "cluster", "exporter", "provider", "authentication", "catalog"]) {
    targets[`${name}WrongPort`] = { ...targets[name], port: targets[name].port + 1 };
  }

  const values = {
    ...productionCollectorValues,
    "api.clients[0].namespace": namespace,
    "api.clients[0].podLabels.app": "operator",
    "database.cidrs[0]": `${targets.database.host}/32`,
    "cluster.cidrs[0]": `${targets.cluster.host}/32`,
    "cluster.port": targets.cluster.port,
    "logging.collector.exporter.cidr": `${targets.exporter.host}/32`,
    "backend.chatgpt.providerCidr": `${targets.provider.host}/32`,
    "gatewayRouting.envoyNamespace": envoyNamespace,
    "gatewayRouting.gatewayName": "access",
    "gatewayRouting.gatewayClassName": "fixture",
    "gatewayRouting.apiKeySecretName": "fixture",
  };
  const chart = async (overrides = {}, release) =>
    parseProductionChart(
      (await renderProductionChart({ ...values, ...overrides }, { namespace, release })).stdout,
    );
  const baseline = await chart();
  const sources = {};
  for (const component of ["api", "worker", "initialization", "collector"]) {
    const workload = baseline.find(
      (object) =>
        ["Deployment", "Job", "DaemonSet"].includes(object?.kind) &&
        object.spec.template.metadata.labels[componentLabel] === component,
    );
    assert.ok(workload, `chart must provide the ${component} workload`);
    sources[component] = { namespace, labels: workload.spec.template.metadata.labels };
  }
  sources.unknown = { namespace, labels: { ...sources.api.labels, [componentLabel]: "unknown" } };
  sources.missing = { namespace, labels: { ...sources.api.labels } };
  delete sources.missing.labels[componentLabel];
  sources.otherRelease = { namespace, labels: { ...sources.api.labels, [instanceLabel]: "other" } };
  sources.operator = { namespace, labels: { app: "operator" } };
  sources.foreign = { namespace: destinations, labels: { app: "operator" } };
  await Promise.all(
    Object.entries(sources).map(async ([name, source]) => {
      const host = await pod(name.toLowerCase(), source.namespace, source.labels, 8080);
      if (name === "api") {
        targets.api = { host, port: 8080 };
      }
    }),
  );

  const probe = async (source, names) =>
    JSON.parse(
      await kubectl(
        "exec",
        "--namespace",
        sources[source].namespace,
        source.toLowerCase(),
        "--",
        "node",
        "-e",
        probeCode,
        JSON.stringify(Object.fromEntries(names.map((name) => [name, targets[name]]))),
      ),
    );
  let envoyEnabled = false;
  async function controls(names) {
    for (const source of ["operator", "api"]) {
      const selected = names.filter(
        (name) => (envoyEnabled && name === "envoy" ? "api" : "operator") === source,
      );
      if (!selected.length) {
        continue;
      }
      await waitFor(
        `${source}: reachable positive controls ${selected}`,
        async () => {
          const results = await probe(source, selected);
          return selected.every((name) => results[name] === "connected");
        },
        30_000,
      );
    }
  }

  return {
    async install(phase) {
      const documents =
        phase === "optional"
          ? await chart({
              "backend.chatgpt.enabled": true,
              "gatewayRouting.enabled": true,
              "api.modelDiscoveryCidrs[0]": `${targets.authentication.host}/32`,
              "api.modelDiscoveryCidrs[1]": `${targets.catalog.host}/32`,
            })
          : baseline;
      const policies = documents.filter(
        (object) =>
          object?.kind === "NetworkPolicy" &&
          (phase !== "bootstrap" || object.metadata.annotations?.["helm.sh/hook"]),
      );
      if (phase === "optional") {
        // The unrelated release was unrestricted in the baseline. Isolate its probe
        // before checking that this release's discovery grant cannot authorize it.
        const isolation = (await chart({}, "other")).find(
          ({ kind, metadata }) =>
            kind === "NetworkPolicy" && metadata.name === "openclaw-enterprise-default-deny",
        );
        assert.ok(isolation, "the unrelated release must render its own default-deny policy");
        policies.push({
          ...isolation,
          metadata: { ...isolation.metadata, name: "other-release-default-deny" },
        });
      }
      await apply(
        policies.map((policy) => ({
          ...policy,
          metadata: { ...policy.metadata, namespace: policy.metadata.namespace ?? namespace },
        })),
      );
      envoyEnabled = phase === "optional";
    },
    async verify({ source, allow = [], deny = [] }) {
      const names = [...allow, ...deny];
      await controls(names);
      let consecutive = 0;
      let last;
      await waitFor(
        `${source}: allow ${allow}; deny ${deny}`,
        async () => {
          last = await probe(source, names);
          for (const name of names) {
            assert.ok(
              last[name] === "connected" || deniedErrors.has(last[name]),
              `${source} -> ${name}: unexpected probe result ${last[name]}`,
            );
          }
          const matches =
            allow.every((name) => last[name] === "connected") &&
            deny.every((name) => deniedErrors.has(last[name]));
          consecutive = matches ? consecutive + 1 : 0;
          return consecutive >= (deny.length ? 2 : 1);
        },
        30_000,
      ).catch((error) => {
        t.diagnostic(`${source}: last connection results ${JSON.stringify(last)}`);
        throw error;
      });
      await controls(names);
      t.diagnostic(`${source}: allow [${allow.join(", ")}]; deny [${deny.join(", ")}]`);
    },
  };
}
