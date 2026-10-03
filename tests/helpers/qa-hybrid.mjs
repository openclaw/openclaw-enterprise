import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { gatewayRoutingPins } from "../../scripts/ci/routing.mjs";
import { loadYaml, dumpYaml, waitFor, yamlDocuments } from "./qa-utils.mjs";

export async function verifyNetworkPolicy(f) {
  const namespace = `qa-policy-${f.suffix}`;
  await f.apply({ apiVersion: "v1", kind: "Namespace", metadata: { name: namespace } });
  try {
    for (const name of ["target", "allowed", "denied"]) {
      await f.apply({
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name, namespace, labels: { "qa-peer": name } },
        spec: {
          automountServiceAccountToken: false,
          restartPolicy: "Never",
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "probe",
              image: f.configuration.drivers.compute.configuration.images.agent,
              imagePullPolicy: "Never",
              command: [
                "node",
                "-e",
                name === "target"
                  ? "for(const port of [8080,8081])require('net').createServer(s=>s.end('live')).listen(port,'0.0.0.0')"
                  : "setInterval(()=>{},10000)",
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
            },
          ],
        },
      });
    }
    await f.apply({
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "exact-peer", namespace },
      spec: {
        podSelector: { matchLabels: { "qa-peer": "target" } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [{ podSelector: { matchLabels: { "qa-peer": "allowed" } } }],
            ports: [{ protocol: "TCP", port: 8080 }],
          },
          { ports: [{ protocol: "TCP", port: 8081 }] },
        ],
      },
    });
    await f.kubectl(
      "-n",
      namespace,
      "wait",
      "--for=condition=Ready",
      "pods",
      "--all",
      "--timeout=180s",
    );
    const target = await f.resource("pod", "target", namespace);
    const script =
      "const s=require('net').connect(Number(process.argv[2]),process.argv[1]);s.setTimeout(3000);s.on('data',()=>{console.log('connected');s.destroy()});s.on('timeout',()=>{console.log('denied');s.destroy()});s.on('error',()=>console.log('denied'));";
    const probe = async (peer, port) =>
      (
        await f.kubectl(
          "-n",
          namespace,
          "exec",
          peer,
          "--",
          "node",
          "-e",
          script,
          target.status.podIP,
          String(port),
        )
      ).trim();
    assert.equal(await probe("allowed", 8080), "connected");
    assert.equal(
      await probe("denied", 8081),
      "connected",
      "denied client must reach the live control listener",
    );
    assert.equal(await probe("denied", 8080), "denied");
    assert.equal(
      await probe("allowed", 8080),
      "connected",
      "allowed listener must remain live after denial",
    );
    await f.record("network-policy", { allowed: true, denied: true, control: true });
  } finally {
    await f.kubectl("delete", "namespace", namespace, "--wait=true", "--timeout=120s");
  }
}

async function resolveComposeControllerImage(f) {
  const container = (await f.compose("ps", "-q", "controller")).trim();
  const observed = JSON.parse(await f.run("docker", ["inspect", container]))[0];
  f.controllerDockerImage = observed.Image;
  const [image] = JSON.parse(await f.run("docker", ["image", "inspect", observed.Image]));
  const tag = `openclaw-qa/controller:${f.suffix}`;
  const archive = join(f.directory, "controller-image.tar");
  const existing = JSON.parse(
    await f.run("docker", ["image", "inspect", tag], { allowExitCodes: [0, 1] }),
  );
  assert.equal(existing.length, 0, "preserve any pre-existing controller image tag");
  // The Compose launcher builds from source without an image field. Import that
  // actual image to obtain its manifest digest for the routing chart's validation.
  await f.run("docker", ["tag", observed.Image, tag]);
  try {
    await f.run("docker", [
      "image",
      "save",
      "--platform",
      `${image.Os}/${image.Architecture}`,
      "--output",
      archive,
      tag,
    ]);
    await f.run("k3d", ["image", "import", "--mode", "direct", archive, "-c", f.cluster]);
    const node = `k3d-${f.cluster}-server-0`;
    const listed = await f.run("docker", ["exec", node, "ctr", "-n", "k8s.io", "images", "list"]);
    const fields = listed
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .find(([name]) => name === tag || name === `docker.io/${tag}`);
    assert.match(fields?.[2] ?? "", /^sha256:[a-f0-9]{64}$/);
    f.controllerChartImage = `docker.io/openclaw-qa/controller@${fields[2]}`;
    await f.run("docker", [
      "exec",
      node,
      "ctr",
      "-n",
      "k8s.io",
      "images",
      "tag",
      fields[0],
      f.controllerChartImage,
    ]);
    await f.record("controller-image", {
      dockerImageId: observed.Image,
      chartReference: f.controllerChartImage,
    });
  } finally {
    await rm(archive, { force: true });
    await f.run("docker", ["image", "rm", tag]);
  }
}

export async function prepareHybridInstallation(f) {
  await resolveComposeControllerImage(f);
  const composePath = join(f.stateDirectory, "compose.yaml");
  const compose = loadYaml(await readFile(composePath, "utf8"));
  f.consoleUrl = f.apiUrl;
  f.credentials = {
    email: compose.services.bootstrap.environment.OPENCLAW_DEV_EMAIL,
    password: compose.services.bootstrap.environment.OPENCLAW_DEV_PASSWORD,
  };
  // Use the same pinned controllers as the shipped Kubernetes-only launcher.
  for (const pin of Object.values(gatewayRoutingPins)) {
    const response = await fetch(pin.url, { signal: AbortSignal.timeout(90_000) });
    assert.ok(response.ok, `routing controller download failed: ${pin.name}`);
    const text = await response.text();
    assert.equal(createHash("sha256").update(text).digest("hex"), pin.sha256);
    const retained = yamlDocuments(text)
      .filter((document) => {
        const object = loadYaml(document);
        return (
          object &&
          !(
            object.kind === "CustomResourceDefinition" &&
            object.metadata.name.endsWith(".gateway.networking.k8s.io")
          )
        );
      })
      .join("\n---\n");
    const path = await f.write(pin.path, retained);
    await f.kubectl("apply", "--server-side", "-f", path);
    for (const deployment of pin.deployments ?? [pin.deployment]) {
      await f.kubectl(
        "-n",
        pin.namespace,
        "rollout",
        "status",
        `deployment/${deployment}`,
        "--timeout=300s",
      );
    }
  }
  await f.apply({ apiVersion: "v1", kind: "Namespace", metadata: { name: "oce-system" } });
  await f.apply({
    apiVersion: "gateway.networking.k8s.io/v1",
    kind: "GatewayClass",
    metadata: { name: "eg" },
    spec: { controllerName: "gateway.envoyproxy.io/gatewayclass-controller" },
  });
  const key = randomBytes(32).toString("hex");
  await f.apply({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "occ-private-gateway-key", namespace: "oce-system" },
    stringData: { occ: key },
  });
  await writeFile(join(f.stateDirectory, "gateway-api-key"), key, { mode: 0o600 });
  const nodeName = `k3d-${f.cluster}-server-0`;
  const network = `${f.cluster}_development`;
  const inspect = async (name) =>
    JSON.parse(await f.run("docker", ["inspect", name]))[0].NetworkSettings.Networks[network]
      .IPAddress;
  const serviceIp = async (service) => inspect((await f.compose("ps", "-q", service)).trim());
  const nodeIp = await inspect(nodeName);
  const compute = f.configuration.drivers.compute.configuration;
  const values = {
    images: { controller: f.controllerChartImage },
    auth: { baseUrl: f.apiUrl },
    bootstrap: { adminEmail: f.credentials.email, password: { claimName: "bootstrap-password" } },
    api: {
      clients: [
        { namespace: "envoy-gateway-system", podLabels: { "app.kubernetes.io/name": "envoy" } },
      ],
    },
    database: { cidrs: [`${await serviceIp("postgres")}/32`] },
    cluster: { cidrs: [`${nodeIp}/32`], port: 6443 },
    agentNativeAdmin: { enabled: false },
    gatewayRouting: {
      enabled: true,
      gatewayClassName: "eg",
      gatewayName: "openclaw-enterprise-agent-gateways",
      hostname: nodeName,
      serviceType: "NodePort",
      apiKeySecretName: "occ-private-gateway-key",
      remoteNodeCidrs: [],
    },
  };
  async function render() {
    values.gatewayRouting.remoteNodeCidrs = [
      `${await serviceIp("controller")}/32`,
      `${await serviceIp("worker-kubernetes")}/32`,
      `${nodeIp}/32`,
    ];
    const path = await f.write("routing-values.json", values);
    const manifests = await f.run("helm", [
      "template",
      "openclaw-enterprise",
      "deploy/helm/openclaw-enterprise",
      "--namespace",
      "oce-system",
      "-f",
      path,
      "--show-only",
      "templates/gateway-routing.yaml",
    ]);
    assert.ok(
      !yamlDocuments(manifests).some((doc) => loadYaml(doc)?.kind === "Deployment"),
      "routing-only render must not install another OCC",
    );
    await f.kubectl("apply", "-f", await f.write("routing.yaml", manifests));
  }
  await render();
  await f.kubectl(
    "-n",
    "oce-system",
    "wait",
    "--for=condition=Programmed",
    "gateway/openclaw-enterprise-agent-gateways",
    "--timeout=300s",
  );
  const proxies = JSON.parse(
    await f.kubectl("-n", "oce-system", "get", "envoyproxies", "-o", "json"),
  ).items;
  assert.equal(proxies.length, 1);
  const serviceName = proxies[0].spec.provider.kubernetes.envoyService.name;
  const service = await f.resource("service", serviceName, "envoy-gateway-system");
  const port = service.spec.ports.find((p) => p.port === 443).nodePort;
  const ca = await f.resource("secret", `${serviceName}-root`, "oce-system");
  await writeFile(
    join(f.stateDirectory, "gateway-ca.crt"),
    Buffer.from(ca.data["tls.crt"], "base64"),
    { mode: 0o600 },
  );
  await verifyNetworkPolicy(f);
  compute.gatewayRouting = {
    gatewayName: "openclaw-enterprise-agent-gateways",
    gatewayNamespace: "oce-system",
    envoyNamespace: "envoy-gateway-system",
    hostname: nodeName,
    endpointPort: port,
  };
  delete compute.network.gatewayClients;
  compute.network.gatewayTrustedProxyCidrs = [(await f.resource("node", nodeName)).spec.podCIDR];
  for (const name of ["controller", "worker-kubernetes"]) {
    const selected = compose.services[name];
    for (const file of ["gateway-api-key", "gateway-ca.crt"]) {
      selected.volumes.push({
        type: "bind",
        source: join(f.stateDirectory, file),
        target: `/run/openclaw-development/${file}`,
        read_only: true,
      });
    }
    selected.environment.OCC_GATEWAY_API_KEY_PATH = "/run/openclaw-development/gateway-api-key";
    selected.environment.NODE_EXTRA_CA_CERTS = "/run/openclaw-development/gateway-ca.crt";
  }
  await writeFile(composePath, dumpYaml(compose), { mode: 0o600 });
  await f.saveInstallation(f.configuration);
  await render();
  // Existing tenants were provisioned before routing. A normal new Namespace
  // supplies the routing-aware policies instead of patching tenant resources.
  f.namespace = await f.api("POST", "/namespaces", { name: `qa-${f.suffix}` });
  f.namespace = await waitFor("routed Namespace readiness", async () => {
    const value = await f.api("GET", `/namespaces/${f.namespace.id}`);
    return value.status === "ready" && value;
  });
  f.presets = await f.api("GET", `/namespaces/${f.namespace.id}/presets`);
  assert.deepEqual(f.presets.map((p) => p.name).sort(), ["Standard Codex", "Standard OpenClaw"]);
}
