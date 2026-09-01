import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";

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
  "database.cidr": "10.45.0.12/32",
  "cluster.cidr": "10.43.0.1/32",
};
const chatgptValues = {
  "provider.chatgpt.enabled": "true",
  "provider.chatgpt.providerCidr": "198.51.100.25/32",
};

async function render(overrides = {}) {
  const args = [
    "template",
    "oce",
    "deploy/helm/openclaw-enterprise",
    "--namespace",
    "openclaw-system",
  ];
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

async function composeConfiguration() {
  const { stdout } = await execute(
    "docker",
    ["compose", "--file", "compose.yaml", "--env-file", "/dev/null", "config", "--format", "json"],
    {
      cwd: repository,
      env: {
        PATH: process.env.PATH,
      },
      maxBuffer: 2_000_000,
    },
  );
  return JSON.parse(stdout);
}

test("production native examples satisfy the current Helm, Installation, and PVC schemas", async () => {
  const installationPath = fileURLToPath(new URL("installation.yaml", productionExamples));
  const drivers = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: installationPath },
  });
  assert.equal(drivers.installation.occ.cluster, "production-west");
  assert.deepEqual(drivers.installation.provider, []);
  assert.equal(drivers.computeDriver.id, "compute-kubernetes");
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

test("production Helm values example renders the providerless default chart", tooling, async () => {
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
  assert.ok(
    objects.some(
      ({ kind, metadata }) =>
        kind === "Job" && metadata.labels?.["app.kubernetes.io/component"] === "initialization",
    ),
  );
  assert.equal(objects.filter(({ kind }) => kind === "Secret").length, 0);
  assert.ok(!objects.some(({ metadata }) => metadata.name.endsWith("-api-chatgpt-egress")));
});

test(
  "the production Helm chart renders private least-privilege runtime and ordered bootstrap",
  tooling,
  async () => {
    const { stdout } = await render();
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
    assert.ok(!objects.some(({ kind }) => ["Ingress", "Gateway"].includes(kind)));

    // Initialization, API, and worker use distinct identities; database credentials remain isolated.
    for (const component of ["initialization", "api", "worker"]) {
      assert.ok(selected("ServiceAccount", component));
    }
    const initialization = selected("Job", "initialization");
    assert.equal(initialization.spec.backoffLimit, 0);
    const pod = initialization.spec.template.spec;
    assert.equal(pod.automountServiceAccountToken, false);
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

    // Worker tenant authority excludes Secret access and remains unbound until operators authorize each tenant.
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
    assert.ok(tenant);
    assert.ok(tenantApiRole);
    assert.ok(!bindings.has(tenant.metadata.name));
    assert.ok(!bindings.has(tenantApiRole.metadata.name));
    assert.ok(tenant.rules.some(({ resources }) => resources.includes("configmaps")));
    assert.deepEqual(tenantApiRole.rules, [
      {
        apiGroups: [""],
        resources: ["secrets"],
        verbs: ["get", "create", "update", "patch", "delete"],
      },
    ]);
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
      assert.ok(!role.rules.some(({ resources }) => resources.includes("persistentvolumeclaims")));
    }
    for (const role of roles.filter(
      ({ metadata }) => metadata.name !== tenantApiRole.metadata.name,
    ))
      for (const rule of role.rules) {
        assert.ok(!rule.resources.includes("secrets"));
        assert.ok(!rule.resources.includes("rolebindings"));
        assert.ok(!rule.verbs.includes("*"));
      }

    // Real rendered workloads retain restricted execution and mount credentials only by Secret reference.
    for (const component of ["api", "worker"]) {
      const pod = selected("Deployment", component).spec.template.spec;
      const container = pod.containers[0];
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
    assert.ok(!objects.some(({ metadata }) => metadata.name.endsWith("-api-chatgpt-egress")));
  },
);

test(
  "the optional ChatGPT Provider isolates admin credentials, tenant Secrets, and provider egress to the API",
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
    assert.deepEqual(tenantApiRole.rules, [
      {
        apiGroups: [""],
        resources: ["secrets"],
        verbs: ["get", "create", "update", "patch", "delete"],
      },
    ]);
    assert.ok(
      !objects.some(
        ({ kind, roleRef }) =>
          kind === "ClusterRoleBinding" && roleRef.name === tenantApiRole.metadata.name,
      ),
    );
    for (const role of roles.filter(
      ({ metadata }) => metadata.name !== tenantApiRole.metadata.name,
    ))
      for (const rule of role.rules) assert.ok(!rule.resources.includes("secrets"));

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
      ["mutable controller", { "images.controller": "controller:latest" }],
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
      ["broad database egress", { "database.cidr": "0.0.0.0/0" }],
      ["broad Kubernetes API egress", { "cluster.cidr": "10.43.0.0/16" }],
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
        { ...chatgptValues, "provider.chatgpt.providerCidr": "0.0.0.0/0" },
      ],
      [
        "ChatGPT Provider without an approved provider host",
        { ...chatgptValues, "provider.chatgpt.providerCidr": "" },
      ],
      [
        "ChatGPT admin key shared with installation configuration",
        { ...chatgptValues, "provider.chatgpt.secretName": "occ-installation-startup" },
      ],
      [
        "ChatGPT Provider without an admin Secret key",
        { ...chatgptValues, "provider.chatgpt.key": "" },
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

test("development packaging isolates bootstrap service key output to the bootstrap service", async () => {
  const configuration = await composeConfiguration();
  const { bootstrap, controller, migrate, worker } = configuration.services;
  assert.ok(bootstrap);
  assert.ok(controller);
  assert.ok(migrate);
  assert.ok(worker);

  assert.deepEqual(bootstrap.command, ["scripts/bootstrap-installation.mjs"]);
  assert.equal(bootstrap.environment.NODE_ENV, "development");
  assert.equal(
    bootstrap.environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE,
    "/var/lib/openclaw/bootstrap/initial-admin-service-key.json",
  );
  assert.equal(bootstrap.environment.OPENCLAW_DEV_EMAIL, "admin@openclaw.local");
  assert.equal(bootstrap.environment.OPENCLAW_DEV_PASSWORD, "openclaw-development-password");
  assert.equal(bootstrap.environment.OPENCLAW_DEV_INSTALLATION_NAME, "OpenClaw Local Development");
  assert.equal(controller.environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE, undefined);
  assert.equal(controller.environment.OPENCLAW_DEV_EMAIL, undefined);
  assert.equal(controller.environment.OPENCLAW_DEV_PASSWORD, undefined);
  assert.equal(controller.environment.OPENCLAW_DEV_INSTALLATION_NAME, undefined);
  assert.equal(migrate.environment?.OCC_BOOTSTRAP_SERVICE_KEY_FILE, undefined);
  assert.equal(worker.environment?.OCC_BOOTSTRAP_SERVICE_KEY_FILE, undefined);

  assert.deepEqual(controller.depends_on.bootstrap, {
    condition: "service_completed_successfully",
    required: true,
  });
  assert.equal(controller.depends_on.migrate, undefined);
  assert.deepEqual(bootstrap.depends_on.migrate, {
    condition: "service_completed_successfully",
    required: true,
  });

  assert.ok(configuration.volumes.occ_bootstrap_data);
  assert.deepEqual(
    bootstrap.volumes.filter(({ target }) => target === "/var/lib/openclaw/bootstrap"),
    [
      {
        type: "volume",
        source: "occ_bootstrap_data",
        target: "/var/lib/openclaw/bootstrap",
        volume: {},
      },
    ],
  );
  assert.ok(
    controller.volumes === undefined ||
      controller.volumes.every(({ source, target }) => {
        return source !== "occ_bootstrap_data" && target !== "/var/lib/openclaw/bootstrap";
      }),
  );
  assert.ok(
    migrate.volumes === undefined ||
      migrate.volumes.every(({ source, target }) => {
        return source !== "occ_bootstrap_data" && target !== "/var/lib/openclaw/bootstrap";
      }),
  );
  assert.ok(
    worker.volumes === undefined ||
      worker.volumes.every(({ source, target }) => {
        return source !== "occ_bootstrap_data" && target !== "/var/lib/openclaw/bootstrap";
      }),
  );
});
