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

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const { loadYaml } = controllerRequire("@kubernetes/client-node");
const productionExamples = new URL("../../deploy/examples/production/", import.meta.url);
const helm = process.env.OCC_HELM_BIN ?? "helm";
const values = {
  "images.controller": `registry.example.invalid/controller@sha256:${"a".repeat(64)}`,
  "auth.baseUrl": "https://occ.example.invalid",
  "auth.secretName": "occ-auth",
  "auth.secretKey": "secret",
  "bootstrap.adminEmail": "admin@example.invalid",
  "bootstrap.password.claimName": "occ-bootstrap-admin-password",
  "api.clients[0].namespace": "operator-tools",
  "api.clients[0].podLabels.app": "operator",
  "database.cidrs[0]": "10.45.0.12/32",
  "database.cidrs[1]": "10.45.0.13/32",
  "cluster.cidrs[0]": "10.43.0.1/32",
  "cluster.cidrs[1]": "10.43.0.2/32",
};
const chatgptValues = {
  "backend.chatgpt.enabled": "true",
  "backend.chatgpt.providerCidr": "198.51.100.25/32",
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
const databaseCaValues = {
  "database.caSecretName": "occ-rds-ca",
  "database.caKey": "ca.pem",
  "database.caMountPath": "/etc/openclaw/database-ca",
};
const controlPlaneSelectorValues = {
  "controlPlane.nodeSelector.oce-role": "control",
};

async function render(overrides = {}, options = {}) {
  const args = [
    "template",
    "oce",
    "deploy/helm/openclaw-enterprise",
    "--namespace",
    options.namespace ?? "openclaw-system",
  ];
  if (options.isUpgrade) {
    args.push("--is-upgrade");
  }
  for (const [key, value] of Object.entries({ ...values, ...overrides })) {
    args.push("--set", `${key}=${value}`);
  }
  return execute(helm, args, { cwd: repository, maxBuffer: 2_000_000 });
}

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

async function resources(manifests) {
  const parsed = await new Promise((resolve, reject) => {
    const child = execFile(
      "yq",
      ["eval-all", "-o=json", "-I=0", ".", "-"],
      { cwd: repository, maxBuffer: 2_000_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin.end(manifests);
  });
  return parsed.trim().split("\n").map(JSON.parse);
}

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
    for (const port of ["0", "65536", "8080", "9.5"]) {
      await assert.rejects(render({ "metrics.port": port }), /metrics.port/);
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
  ];
}

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
  assert.equal(drivers.computeDriver.id, "compute-kubernetes");
  const compute = drivers.installation.drivers.compute.configuration;
  assert.equal(compute.network.gatewayClients, undefined);
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
  assert.ok(
    initialization.spec.template.spec.volumes.some(
      ({ name, secret }) => name === "database-ca" && secret?.secretName === "occ-rds-ca",
    ),
  );
  assert.equal(objects.filter(({ kind }) => kind === "Secret").length, 0);
  assert.ok(!objects.some(({ metadata }) => metadata.name.endsWith("-api-chatgpt-egress")));
});

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
    const controller = workerPod.containers.find(({ name }) => name === "worker");
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
    assert.equal(workerPod.initContainers, undefined);
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
      for (const container of pod.containers) {
        assert.deepEqual(
          container.volumeMounts.find(({ name }) => name === "repository-registry"),
          {
            name: "repository-registry",
            mountPath: "/etc/openclaw/repository-registry",
            readOnly: true,
          },
        );
      }
      const main = pod.containers[0];
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
    // Use chart defaults and real Helm/yq; only remote reads are fixtures.
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
    for (const path of [installation, kubeconfig, key]) {
      await writeFile(path, "{}", { mode: 0o600 });
    }
    const secret = join(directory, "secret.json");
    await writeFile(
      secret,
      JSON.stringify({
        metadata: { annotations: { "openclaw.dev/installation-id": "ins_test" } },
        data: { "installation.yaml": Buffer.from("{}").toString("base64") },
      }),
      { mode: 0o600 },
    );
    const worker = join(directory, "worker.json");
    const wrappers = {
      kubectl: `#!/usr/bin/env bash
case "$*" in
  *'get secret '*) cat "$TEST_SECRET" ;;
  *'get deployment openclaw-enterprise-worker '*) cat "$TEST_WORKER" ;;
  *'get deployments,statefulsets,pods,persistentvolumeclaims '*) printf '{"items":[]}' ;;
  *'get --raw=/readyz'*) printf 'ok' ;;
  *) exit 90 ;;
esac
`,
      occ: `#!/usr/bin/env bash
printf '{"id":"ins_test"}'
`,
      helm: `#!/usr/bin/env bash
case "$1 $2" in
  'get values') cat "$TEST_LIVE_VALUES" ;;
  'status oce') printf 'deployed' ;;
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
            `registry.example.invalid/controller@sha256:${"c".repeat(64)}`,
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
      },
    };
    const allowed = (peer = source, port = 8443, protocol = "TCP", chart = objects) =>
      chartAllowsIngress(chart, destination, peer, port, protocol);

    // Current Compute emits these ownership labels without a network-profile label.
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
      } else {
        const readinessMount = container.volumeMounts.find(
          ({ name }) => name === "worker-readiness",
        );
        assert.equal(readinessMount.readOnly, undefined);
        assert.equal(
          container.env.find(({ name }) => name === "OCC_WORKER_READINESS_PATH").value,
          `${readinessMount.mountPath}/ready`,
        );
        assert.deepEqual(container.readinessProbe.exec.command, [
          "node",
          "scripts/production-healthcheck.mjs",
          "worker",
          "ready",
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
    for (const cidr of ["0.0.0.0/0", "198.51.100.0/24", "api.openai.com", "999.1.1.1/32"]) {
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

test(
  "the real Helm renderer rejects mutable images, broad dependencies, and shared credentials",
  tooling,
  async () => {
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
      ["broad Kubernetes API egress", { "cluster.cidrs[0]": "10.43.0.0/16" }],
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
