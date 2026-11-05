import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { temporaryDirectory } from "./temporary-directory.ts";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createKubernetesClient,
  kubectlArguments,
  kubernetesHash,
  validateExplicitK3dLoopbackContext,
} from "./kubernetes-real.mjs";
import { kubectlGetJson } from "./kubernetes-api-read.mjs";
import {
  parseProductionChart,
  productionCollectorValues,
  renderProductionChart,
} from "./production-chart.mjs";
import { createDriver, fixtureComputeConfiguration } from "./kubernetes-compute-real.mjs";

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
const {get} = require('node:https');
async function probe(target) {
  try {
    if (target.dns) {
      await new Resolver({timeout: 1500, tries: 1}).resolve4(target.dns);
    } else if (target.ca) {
      await new Promise((resolve, reject) => {
        const request = get({hostname: target.host, port: target.port, path: '/version',
          servername: 'kubernetes.default.svc', ca: target.ca, agent: false}, response => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', chunk => { body += chunk; });
          response.once('error', reject);
          response.once('end', () => {
            try {
              const result = JSON.parse(body);
              const version = response.statusCode === 200 && typeof result.gitVersion === 'string';
              const unauthenticated = response.statusCode === 401 && result.kind === 'Status' &&
                result.reason === 'Unauthorized' && result.code === 401;
              if (version || unauthenticated) resolve();
              else reject(Object.assign(new Error('Expected Kubernetes response'), {code: 'INVALID_API_RESPONSE'}));
            } catch (error) { reject(error); }
          });
        });
        const deadline = setTimeout(() => request.destroy(Object.assign(new Error(), {code: 'ETIMEDOUT'})), 1500);
        request.once('close', () => clearTimeout(deadline));
        request.once('error', reject);
      });
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
    (await kubectlGetJson(selection, args, { timeoutMs: 30_000 })) ??
    (await execute("kubectl", kubectlArguments(selection, args), { timeout: 30_000 })).stdout;
  const { resource, waitFor } = createKubernetesClient({
    selection,
    kubectl,
    waitTimeoutMs: 60_000,
  });
  const kubectlWithInput = (args, object) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        "kubectl",
        kubectlArguments(selection, args),
        { timeout: 30_000 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin.on("error", reject);
      child.stdin.end(JSON.stringify(object));
    });
  const apply = (objects, verb = "apply") =>
    kubectlWithInput([verb, "-f", "-"], { apiVersion: "v1", kind: "List", items: objects });
  let apiEndpointSlice;
  let apiEndpointSliceCreationPending = false;
  t.after(async () => {
    // The exclusive disposable cluster's API must stop routing to these proxies
    // before their Pods disappear, including after a failed assertion.
    assert.equal(
      apiEndpointSliceCreationPending,
      false,
      "API EndpointSlice creation was not acknowledged; retain proxies until the disposable cluster is removed",
    );
    if (apiEndpointSlice) {
      await kubectlWithInput(
        [
          "delete",
          `--raw=/apis/discovery.k8s.io/v1/namespaces/default/endpointslices/${apiEndpointSlice.metadata.name}`,
          "-f",
          "-",
        ],
        {
          apiVersion: "v1",
          kind: "DeleteOptions",
          preconditions: { uid: apiEndpointSlice.metadata.uid },
        },
      );
      await waitFor(
        "owned API EndpointSlice removed",
        async () =>
          (
            await kubectl(
              "get",
              "endpointslice",
              apiEndpointSlice.metadata.name,
              "-n",
              "default",
              "--ignore-not-found",
              "-o",
              "name",
            )
          ).trim() === "",
      );
    }
    if (ownedNamespaces.length) {
      await kubectl("delete", "namespace", ...ownedNamespaces, "--wait=false");
      await waitFor(
        "fixture namespaces removed",
        async () =>
          (
            await kubectl(
              "get",
              "namespace",
              ...ownedNamespaces,
              "--ignore-not-found",
              "-o",
              "name",
            )
          ).trim() === "",
        120_000,
      );
    }
  });
  // Claim the public quickstart's fixed namespaces first. Never adopt an existing installation.
  const system = "oce-system";
  const envoy = "envoy-gateway-system";
  for (const name of [system, envoy, namespace, destinations, envoyNamespace]) {
    await kubectl("create", "namespace", name);
    ownedNamespaces.push(name);
  }

  async function pod(name, podNamespace, labels, port, forwardTo) {
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
                forwardTo
                  ? `const net = require('node:net');
                    for (const port of [${port}, ${port + 1}]) net.createServer(socket => {
                      const upstream = net.createConnection(${JSON.stringify(forwardTo)});
                      socket.on('error', () => upstream.destroy());
                      upstream.on('error', () => socket.destroy());
                      socket.on('close', () => upstream.destroy());
                      upstream.on('close', () => socket.destroy());
                      socket.pipe(upstream).pipe(socket);
                    }).listen(port, '0.0.0.0');`
                  : `for(const port of [${port},${port + 1}]) require('node:net').createServer(s=>s.end()).listen(port,'0.0.0.0')`,
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

  const probe = async (source, names, tcpOnly = []) =>
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
        JSON.stringify(
          Object.fromEntries(
            names.map((name) => [
              name,
              // Denial means no TCP connection. A later TLS failure must never hide
              // a policy that accidentally allowed the connection through.
              tcpOnly.includes(name) && targets[name].ca
                ? { host: targets[name].host, port: targets[name].port }
                : targets[name],
            ]),
          ),
        ),
      ),
    );
  let envoyEnabled = false;
  async function controls(names, controlSource) {
    for (const source of controlSource ? [controlSource] : ["operator", "api"]) {
      const selected = controlSource
        ? names
        : names.filter(
            (name) => (envoyEnabled && name === "envoy" ? "api" : "operator") === source,
          );
      if (!selected.length) {
        continue;
      }
      let last;
      await waitFor(
        `${source}: reachable positive controls ${selected}`,
        async () => {
          last = await probe(source, selected);
          return selected.every((name) => last[name] === "connected");
        },
        30_000,
      ).catch((error) => {
        t.diagnostic(`${source}: last positive-control results ${JSON.stringify(last)}`);
        throw error;
      });
    }
  }

  const quickstart = fileURLToPath(
    new URL("../../docs/snippets/openshell-quickstart/", import.meta.url),
  );
  const runDir = await temporaryDirectory(t, "oce-network-");
  await symlink(join(quickstart, "kubernetes"), join(runDir, "kubernetes"));
  const runNetworkHelper = (command, tenant, path = process.env.PATH) =>
    execute(
      "bash",
      [
        "-eu",
        "-c",
        'source "$1"; source "$2"; "$3"',
        "bash",
        join(quickstart, "operator-session.sh"),
        join(quickstart, "platform-kubernetes.sh"),
        command,
      ],
      {
        env: {
          ...process.env,
          PATH: path,
          RUN_DIR: runDir,
          KUBECONFIG: selection.kubeconfigPath,
          CONTEXT: selection.kubernetesContext,
          PLATFORM_NS: system,
          ...(tenant && {
            TENANT_NAMESPACE: tenant.namespace,
            namespace: tenant.id,
            agent: tenant.agent,
          }),
        },
        timeout: 30_000,
      },
    );
  const policy = (name, space, spec) => ({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name, namespace: space },
    spec,
  });
  let managementTenants;
  let ownedApiDiscoveryPath;
  return {
    async installOpenShellManagement(tenantIndex) {
      if (!managementTenants) {
        const api = baseline.find(
          (object) =>
            object?.kind === "Service" && object.metadata.name === "openclaw-enterprise-api",
        );
        assert.ok(api, "the chart must provide the public quickstart API Service");
        const supervisor = {
          "openshell.ai/managed-by": "openshell",
          "openshell.ai/boundary-role": "supervisor",
        };
        const management = {
          "app.kubernetes.io/name": "openshell",
          "app.kubernetes.io/instance": "openshell-gateway",
        };
        const service = (name, space, labels, port, targetPort = port) => ({
          apiVersion: "v1",
          kind: "Service",
          metadata: { name, namespace: space },
          spec: { selector: labels, ports: [{ port, targetPort, protocol: "TCP" }] },
        });
        const resources = [
          service("openshell-gateway", system, management, 8080),
          service("openclaw-enterprise-api", system, api.spec.selector, 8080),
          service("occ-gateway-362888b35fce", envoy, { app: "quickstart-proxy" }, 443, 10443),
          service("envoy-gateway", envoy, { app: "quickstart-envoy-controller" }, 18000),
        ];
        const managementSources = {
          management: { namespace: system, labels: management },
          managementinitialization: { namespace: system, labels: sources.initialization.labels },
          ordinary: { namespace, labels: { app: "ordinary-tenant" } },
          foreignsupervisor: { namespace: envoyNamespace, labels: supervisor },
        };
        for (const component of ["api", "worker"]) {
          const labels = sources[component].labels;
          managementSources[`management${component}`] = { namespace: system, labels };
          // cluster-installation.md supplies this source-side prerequisite; the renderer
          // under test must supply ingress. It must not be masked by a fixture ingress grant.
          resources.push(
            policy(`management-${component}-egress`, system, {
              podSelector: { matchLabels: labels },
              policyTypes: ["Egress"],
              egress: [
                {
                  to: [{ podSelector: { matchLabels: management } }],
                  ports: [{ protocol: "TCP", port: 8080 }],
                },
              ],
            }),
          );
        }
        managementTenants = [];
        for (const [index, space] of [namespace, destinations].entries()) {
          const id = `ns_${randomUUID()}`;
          const agent = `agt_${randomUUID()}`;
          const labels = {
            "app.kubernetes.io/managed-by": "openclaw-enterprise",
            "openclaw.dev/agent": agent,
            "openclaw.dev/workload-role": "gateway",
          };
          await kubectl("label", "namespace", space, `openclaw.dev/namespace=${id}`);
          managementTenants.push({ namespace: space, id, agent });
          managementSources[`supervisor${index}`] = { namespace: space, labels: supervisor };
          managementSources[`gateway${index}`] = { namespace: space, labels };
          resources.push(
            service(`gateway-${kubernetesHash(agent)}`, space, labels, 8080),
            policy("allow-dns", space, {
              podSelector: { matchLabels: { "openclaw.dev/network-profile": "broad-egress-v1" } },
              policyTypes: ["Egress"],
              egress: [
                {
                  to: [
                    {
                      namespaceSelector: {
                        matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
                      },
                    },
                  ],
                  ports: [
                    { protocol: "UDP", port: 53 },
                    { protocol: "TCP", port: 53 },
                  ],
                },
              ],
            }),
          );
        }
        await Promise.all([
          pod("quickstart-proxy", envoy, { app: "quickstart-proxy" }, 10443),
          pod("quickstart-envoy-controller", envoy, { app: "quickstart-envoy-controller" }, 18000),
          ...Object.entries(managementSources).map(async ([name, source]) => {
            sources[name] = source;
            const host = await pod(name, source.namespace, source.labels, 8080);
            if (name === "management") {
              targets.management = { host, port: 8080 };
              targets.managementWrongPort = { host, port: 8081 };
            }
          }),
        ]);
        // Prove every source reaches both real listeners before adding policies. The
        // existing suite's policies must not make a later denial pass accidentally.
        await Promise.all(
          Object.keys(managementSources).map((source) =>
            controls(["management", "managementWrongPort"], source),
          ),
        );
        await apply(resources);
      }
      await runNetworkHelper("deployment_network", managementTenants[tenantIndex]);
      // Let each selected caller send to the second listener. Leave the unconfigured
      // tenant unrestricted until its production policies have been applied.
      await apply(
        [
          "managementapi",
          "managementworker",
          `supervisor${tenantIndex}`,
          `gateway${tenantIndex}`,
        ].map((name) =>
          policy("verify-management-port-" + name, sources[name].namespace, {
            podSelector: { matchLabels: sources[name].labels },
            policyTypes: ["Egress"],
            egress: [
              {
                to: [
                  {
                    namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": system } },
                    podSelector: { matchLabels: sources.management.labels },
                  },
                ],
                ports: [{ protocol: "TCP", port: 8081 }],
              },
            ],
          }),
        ),
      );
    },
    async installManagementRepositoryAccess() {
      // Only the explicitly selected, exclusive disposable cluster may acquire an
      // additional API EndpointSlice. Native slices are never changed. These real
      // TCP proxies preserve API TLS and forward to a native endpoint, so Service
      // traffic remains valid while Pod IPs make CNI revocation observable.
      const api = await resource("service", "kubernetes", "default");
      const https = api.spec.ports.find(({ port, protocol }) => port === 443 && protocol === "TCP");
      assert.ok(https, "Kubernetes must expose its HTTPS Service port");
      const slices = JSON.parse(
        await kubectl(
          "get",
          "endpointslices",
          "-n",
          "default",
          "-l",
          "kubernetes.io/service-name=kubernetes",
          "-o",
          "json",
        ),
      );
      let forwardTo;
      for (const slice of slices.items) {
        const port = slice.ports.find(
          ({ name, protocol }) => name === https.name && protocol === "TCP",
        )?.port;
        const endpoint = slice.endpoints.find(({ conditions }) => conditions?.ready !== false);
        if (port && endpoint?.addresses.length) {
          forwardTo = { host: endpoint.addresses[0], port };
          break;
        }
      }
      assert.ok(forwardTo, "a native Kubernetes API endpoint must be ready before adding proxies");
      const ca = (await resource("configmap", "kube-root-ca.crt", "default")).data["ca.crt"];
      for (const name of ["managementApi", "withdrawnManagementApi"]) {
        targets[name] = {
          host: await pod(name.toLowerCase(), destinations, {}, 8443, forwardTo),
          port: 8443,
          ca,
        };
        targets[`${name}WrongPort`] = { ...targets[name], port: 8444 };
      }
      targets.kubernetesApi = { host: api.spec.clusterIP, port: 443, ca };
      const dns = await resource("service", "kube-dns", "kube-system");
      targets.dnsTcp = { host: dns.spec.clusterIP, port: 53 };
      const labels = { app: "quickstart-git-hook" };
      targets.managementGit = { host: await pod("git-hook", system, labels, 8445), port: 8445 };
      targets.managementGitWrongPort = { ...targets.managementGit, port: 8446 };
      await apply(
        [
          {
            apiVersion: "v1",
            kind: "Service",
            metadata: { name: "openclaw-enterprise-openshell-git", namespace: system },
            spec: { selector: labels, ports: [{ port: 8445, targetPort: 8445, protocol: "TCP" }] },
          },
        ],
        "create",
      );
      const git = await resource("service", "openclaw-enterprise-openshell-git", system);
      targets.managementGitService = { host: git.spec.clusterIP, port: 8445 };
      const newTargets = [
        "dns",
        "dnsTcp",
        "kubernetesApi",
        "managementApi",
        "managementApiWrongPort",
        "withdrawnManagementApi",
        "withdrawnManagementApiWrongPort",
        "managementGit",
        "managementGitService",
        "managementGitWrongPort",
        "unexpected",
      ];
      // Verify API TLS and either /version or Kubernetes' explicit Unauthorized
      // response through both ports. No credentials are sent: this proves API
      // transport, not authentication or permission to read cluster resources.
      await controls(newTargets, "management");
      const candidate = {
        apiVersion: "discovery.k8s.io/v1",
        kind: "EndpointSlice",
        metadata: {
          name: `${namespace}-api`,
          namespace: "default",
          labels: {
            "kubernetes.io/service-name": "kubernetes",
            "endpointslice.kubernetes.io/managed-by": "openclaw-enterprise-network-test",
          },
        },
        addressType: "IPv4",
        ports: [{ name: https.name, protocol: "TCP", port: 8443 }],
        endpoints: [targets.managementApi, targets.withdrawnManagementApi].map(({ host }) => ({
          addresses: [host],
          conditions: { ready: true },
        })),
      };
      // Only the API's successful create response establishes ownership. A lost
      // response leaves the proxies running for explicit cluster cleanup.
      apiEndpointSliceCreationPending = true;
      apiEndpointSlice = JSON.parse(
        await kubectlWithInput(["create", "-f", "-", "-o", "json"], candidate),
      );
      assert.ok(apiEndpointSlice.metadata.uid, "created EndpointSlice must have a UID");
      apiEndpointSliceCreationPending = false;
      await runNetworkHelper("repository_network", managementTenants[0]);
    },
    async withdrawManagementApiEndpoint() {
      // Keep the old proxy listening. A failed connection must be caused by the
      // rerendered egress policy, not by tearing down its destination.
      apiEndpointSlice.endpoints[1].conditions.ready = false;
      await apply([apiEndpointSlice]);
      await runNetworkHelper("repository_network", managementTenants[0]);
    },
    async useOwnedManagementApiDiscovery() {
      // Keep native API discovery untouched. Only this renderer subprocess sees
      // the acknowledged proxy slice as its complete discovery snapshot; every
      // other query and all writes still reach kubectl and the real API server.
      const directory = await temporaryDirectory(t, "oce-api-discovery-");
      const binary = (await execute("sh", ["-c", "command -v kubectl"])).stdout.trim();
      assert.ok(binary.startsWith("/"), "kubectl must resolve to an absolute path");
      const query = kubectlArguments(selection, [
        "-n",
        "default",
        "get",
        "endpointslices",
        "-l",
        "kubernetes.io/service-name=kubernetes",
        "-o",
        "json",
      ]);
      await writeFile(
        join(directory, "kubectl"),
        `#!/usr/bin/env python3
import json
import os
import subprocess
import sys
binary = ${JSON.stringify(binary)}
arguments = sys.argv[1:]
if arguments != ${JSON.stringify(query)}:
    os.execv(binary, [binary] + arguments)
result = subprocess.run([binary] + arguments, capture_output=True)
sys.stderr.buffer.write(result.stderr)
if result.returncode:
    sys.stdout.buffer.write(result.stdout)
    sys.exit(result.returncode)
payload = json.loads(result.stdout)
selected = [item for item in payload["items"]
    if item["metadata"]["name"] == ${JSON.stringify(apiEndpointSlice.metadata.name)}
    and item["metadata"]["namespace"] == "default"
    and item["metadata"]["uid"] == ${JSON.stringify(apiEndpointSlice.metadata.uid)}]
if len(selected) != 1:
    sys.exit("Expected exactly the acknowledged API fixture slice")
payload["items"] = selected
print(json.dumps(payload))
`,
        { mode: 0o700 },
      );
      ownedApiDiscoveryPath = `${directory}:${process.env.PATH}`;
      for (const endpoint of apiEndpointSlice.endpoints) {
        endpoint.conditions.ready = true;
      }
      await apply([apiEndpointSlice]);
      await runNetworkHelper("repository_network", managementTenants[0], ownedApiDiscoveryPath);
    },
    async withdrawAllManagementApiEndpoints() {
      assert.ok(ownedApiDiscoveryPath, "select the owned API discovery snapshot first");
      for (const endpoint of apiEndpointSlice.endpoints) {
        endpoint.conditions.ready = false;
      }
      await apply([apiEndpointSlice]);
      const result = await runNetworkHelper(
        "repository_network",
        managementTenants[0],
        ownedApiDiscoveryPath,
      );
      assert.match(result.stderr, /No ready Kubernetes API endpoint/);
    },
    async confirmManagementPortControls() {
      // Change only destination ingress. A successful connection from each caller
      // proves that its preceding 8081 denial was not caused by source egress.
      const name = "verify-management-listener";
      await apply([
        policy(name, system, {
          podSelector: { matchLabels: sources.management.labels },
          policyTypes: ["Ingress"],
          ingress: [{ ports: [{ protocol: "TCP", port: 8081 }] }],
        }),
      ]);
      try {
        await Promise.all(
          [
            "managementapi",
            "managementworker",
            "supervisor0",
            "gateway0",
            "supervisor1",
            "gateway1",
          ].map((source) => controls(["managementWrongPort"], source)),
        );
      } finally {
        await kubectl("delete", "networkpolicy", "-n", system, name);
      }
    },
    async removeRecordedServicePolicies() {
      await runNetworkHelper("delete_service_peers");
      for (const tenant of managementTenants) {
        const remaining = await kubectl(
          "get",
          "networkpolicy",
          "-n",
          system,
          "--ignore-not-found",
          "-o",
          "name",
          "oce-management-from-supervisors-" + kubernetesHash(tenant.id),
          "oce-management-from-" + kubernetesHash(tenant.agent),
        );
        assert.equal(remaining.trim(), "", "uninstall must remove earlier and later tenant grants");
      }
    },
    async withdrawSupervisorGrant(index) {
      const tenant = managementTenants[index];
      await kubectl(
        "delete",
        "networkpolicy",
        "-n",
        "oce-system",
        "oce-management-from-supervisors-" + kubernetesHash(tenant.id),
      );
    },
    async removeTenantOwnership(index) {
      await kubectl(
        "label",
        "namespace",
        managementTenants[index].namespace,
        "openclaw.dev/namespace-",
      );
    },
    async installPublicReaderRevisions() {
      const address = "10.43.0.19";
      const peer = { namespace: destinations, podLabels: { app: "public-reader" }, address };
      targets.publicReader = {
        host: await pod("public-reader", destinations, peer.podLabels, 8080),
        port: 8080,
      };
      targets.publicReaderWrongPort = { ...targets.publicReader, port: 8081 };
      const base = fixtureComputeConfiguration();
      const { driver } = await createDriver({
        network: { ...base.network, publicGithubRead: peer },
        runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
      });
      const common = {
        namespaceId: `ns_${randomUUID()}`,
        agentId: `agt_${randomUUID()}`,
        servicePrincipalId: `principal-${randomUUID()}`,
        harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
        harnessAuth: { method: "runtime" },
        configuration: {
          plugins: {
            entries: {
              codex: {
                config: {
                  appServer: {
                    networkProxy: {
                      enabled: true,
                      domains: { [address]: "allow" },
                    },
                  },
                },
              },
            },
          },
        },
        compute: { id: driver.id, implementation: driver.implementation },
        executionAdmission: { version: 2, mode: "unprotected" },
      };
      const old = { ...structuredClone(common), id: `rev_${randomUUID()}` };
      const selected = { ...structuredClone(common), id: `rev_${randomUUID()}` };
      selected.compute.admission = driver.admitRevision(selected);
      assert.ok(selected.compute.admission);
      assert.equal(driver.pluginRuntimeSnapshot(old).runtime.publicGithubRead, undefined);
      assert.ok(driver.pluginRuntimeSnapshot(selected).runtime.publicGithubRead);
      await apply([
        {
          apiVersion: "networking.k8s.io/v1",
          kind: "NetworkPolicy",
          metadata: { name: "isolate-public-reader-probes", namespace },
          spec: {
            podSelector: { matchLabels: { "openclaw.dev/agent": common.agentId } },
            policyTypes: ["Egress"],
          },
        },
      ]);
      await driver.reconcilePublicGithubReadNetworkPolicy(
        selected,
        { name: namespace, plane: "execution" },
        driver.pluginRuntimeSnapshot(selected),
      );
      for (const [name, revision] of [
        ["selectedreader", selected],
        ["oldreader", old],
      ]) {
        sources[name] = { namespace, labels: driver.agentServiceSelector(revision) };
        await pod(name, namespace, sources[name].labels, 8080);
      }
    },
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
    async verify({ source, allow = [], deny = [], controlSource }) {
      const names = [...allow, ...deny];
      await controls(names, controlSource);
      let consecutive = 0;
      let last;
      await waitFor(
        `${source}: allow ${allow}; deny ${deny}`,
        async () => {
          last = await probe(source, names, deny);
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
      await controls(names, controlSource);
      t.diagnostic(`${source}: allow [${allow.join(", ")}]; deny [${deny.join(", ")}]`);
    },
  };
}
