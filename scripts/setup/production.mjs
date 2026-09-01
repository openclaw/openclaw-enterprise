import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const CHART_PATH = "deploy/helm/openclaw-enterprise";
const MANAGER = "openclaw-setup";
const BOOTSTRAP_MOUNT = "/var/lib/openclaw/bootstrap";
const BOOTSTRAP_PASSWORD_FILE = "initial-admin-password";
const BOOTSTRAP_SERVICE_KEY_FILE = "initial-admin-service-key.json";
const TRANSPORT_SECRET_PREFIX = "openclaw-agent-transport";
const MODEL_SECRET_PREFIX = "openclaw-agent-model";
const RUNTIME_RESOURCE_1GI = {
  requests: { cpu: "100m", memory: "1Gi" },
  limits: { cpu: "2", memory: "1Gi" },
};
const NAMESPACE_RESOURCE_DEFAULTS = {
  quota: { pods: "10" },
  containerDefaults: structuredClone(RUNTIME_RESOURCE_1GI),
};
const DEFAULTS = Object.freeze({
  clusterName: "openclaw-enterprise-production",
  systemNamespace: "openclaw-system",
  release: "oce",
  dns: Object.freeze({
    namespace: "kube-system",
    podLabels: Object.freeze({ "k8s-app": "kube-dns" }),
  }),
});

const TOP_LEVEL_KEYS = [
  "model",
  "modelKeyFile",
  "kubeconfig",
  "context",
  "url",
  "controllerImage",
  "runtimeImage",
  "adminEmail",
  "clusterName",
  "systemNamespace",
  "release",
  "gatewayStorageClass",
  "bootstrapStorageClass",
  "database",
  "apiClient",
  "kubernetesApi",
  "gatewayClient",
  "dns",
];

const DATABASE_KEYS = ["applicationUrlFile", "migrationUrlFile", "cidr", "port"];
const WORKLOAD_PEER_KEYS = ["namespace", "podLabels"];
const KUBERNETES_API_KEYS = ["cidr", "port"];
const DNS_KEYS = ["namespace", "podLabels"];

export function validateProductionConfig(input, { modelKey, requireModelKey = false } = {}) {
  const config = object(input, "production setup config");
  knownKeys(config, TOP_LEVEL_KEYS, "production setup config");

  const normalized = {
    model: nonempty(config.model, "model"),
    ...(config.modelKeyFile === undefined
      ? {}
      : { modelKeyFile: absolutePath(config.modelKeyFile, "modelKeyFile") }),
    kubeconfig: absolutePath(config.kubeconfig, "kubeconfig"),
    context: nonempty(config.context, "context"),
    url: httpsUrl(config.url, "url"),
    controllerImage: immutableImage(config.controllerImage, "controllerImage"),
    runtimeImage: immutableImage(config.runtimeImage, "runtimeImage"),
    adminEmail: email(config.adminEmail, "adminEmail"),
    clusterName: nonempty(config.clusterName ?? DEFAULTS.clusterName, "clusterName"),
    systemNamespace: kubernetesName(
      config.systemNamespace ?? DEFAULTS.systemNamespace,
      "systemNamespace",
    ),
    release: kubernetesName(config.release ?? DEFAULTS.release, "release"),
    gatewayStorageClass: kubernetesName(config.gatewayStorageClass, "gatewayStorageClass"),
    bootstrapStorageClass: kubernetesName(config.bootstrapStorageClass, "bootstrapStorageClass"),
    database: database(config.database),
    apiClient: workloadPeer(config.apiClient, "apiClient"),
    kubernetesApi: kubernetesApi(config.kubernetesApi),
    dns: dns(config.dns ?? DEFAULTS.dns, "dns"),
  };
  normalized.gatewayClient =
    config.gatewayClient === undefined
      ? structuredClone(normalized.apiClient)
      : workloadPeer(config.gatewayClient, "gatewayClient");

  if (requireModelKey && config.modelKeyFile === undefined && !secretValue(modelKey)) {
    throw new Error(
      "modelKeyFile is required when OPENAI_API_KEY is not provided by the setup CLI.",
    );
  }
  return Object.freeze(normalized);
}

export function renderInstallationConfig(config) {
  const normalized = validateProductionConfig(config, { modelKey: "validated-by-caller" });
  return {
    occ: { cluster: normalized.clusterName },
    drivers: {
      configuration: {
        id: "configuration-kubernetes-production",
        configuration: { authentication: { mode: "inCluster" } },
      },
      iam: {
        id: "native-iam",
        configuration: {},
      },
      compute: {
        id: "compute-kubernetes-production",
        configuration: {
          authentication: { mode: "inCluster" },
          images: {
            gateway: normalized.runtimeImage,
            agent: normalized.runtimeImage,
            requireImmutableDigest: true,
          },
          resources: {
            gateway: structuredClone(RUNTIME_RESOURCE_1GI),
            agent: structuredClone(RUNTIME_RESOURCE_1GI),
            namespace: structuredClone(NAMESPACE_RESOURCE_DEFAULTS),
          },
          network: {
            dns: normalized.dns,
            gatewayPort: 8080,
            gatewayClients: [normalized.gatewayClient],
          },
          servicePrincipalCredentials: {
            mode: "projectedServiceAccountToken",
            audience: "openclaw-enterprise",
            expirationSeconds: 900,
          },
          runtime: {
            gatewayStorageClassName: normalized.gatewayStorageClass,
            transportSecretPrefix: TRANSPORT_SECRET_PREFIX,
            modelSecretPrefix: MODEL_SECRET_PREFIX,
          },
        },
      },
      secret: {
        id: "secret-kubernetes",
        configuration: { authentication: { mode: "inCluster" } },
      },
    },
  };
}

export function renderHelmValues(config, generated = {}) {
  const normalized = validateProductionConfig(config, { modelKey: "validated-by-caller" });
  const bootstrapClaimName =
    generated.bootstrapClaimName ?? `${normalized.release}-bootstrap-output`;
  return {
    images: { controller: normalized.controllerImage },
    installation: {
      name: "openclaw-enterprise",
      secretName: "occ-installation-startup",
      key: "installation.yaml",
    },
    auth: {
      baseUrl: normalized.url,
      secretName: "occ-auth",
      secretKey: "secret",
    },
    bootstrap: {
      adminEmail: normalized.adminEmail,
      password: {
        claimName: bootstrapClaimName,
        mountPath: BOOTSTRAP_MOUNT,
        fileName: BOOTSTRAP_PASSWORD_FILE,
      },
      serviceKey: { fileName: BOOTSTRAP_SERVICE_KEY_FILE },
    },
    integrations: {
      chatgpt: { enabled: false },
    },
    database: {
      secretName: "occ-database",
      appUrlKey: "application-url",
      migrationUrlKey: "migration-url",
      cidr: normalized.database.cidr,
      port: normalized.database.port,
    },
    api: {
      port: 8080,
      clients: [normalized.apiClient],
    },
    cluster: {
      cidr: normalized.kubernetesApi.cidr,
      port: normalized.kubernetesApi.port,
    },
    dns: normalized.dns,
  };
}

export function productionIdentity(config) {
  return validateProductionConfig(config, { requireModelKey: false });
}

export function createProductionBackend(options) {
  const backend = new ProductionBackend(options);
  return {
    start: () => backend.start(),
    prepareNamespace: (namespaceId) => backend.prepareNamespace(namespaceId),
    prepareAgent: (agentId) => backend.prepareAgent(agentId),
    tuiCommand: (input) => backend.tuiCommand(input),
  };
}

class ProductionBackend {
  constructor({ config, directory, state = {}, save, run, progress, modelKey } = {}) {
    if (typeof save !== "function") throw new Error("createProductionBackend requires save.");
    if (typeof run !== "function") throw new Error("createProductionBackend requires run.");
    this.config = validateProductionConfig(config, { modelKey, requireModelKey: false });
    this.directory = absolutePath(directory, "directory");
    this.state = object(state, "setup state");
    this.save = save;
    this.run = run;
    this.progress = typeof progress === "function" ? progress : () => {};
    this.modelKey = secretValue(modelKey) ? String(modelKey) : undefined;
    this.redactions = new Set([this.modelKey].filter(Boolean));
    this.temporaryPods = [];
  }

  async start() {
    await this.validateProtectedInputs({ requireModelKey: true });
    await this.ensurePrivateDirectory();
    const setup = await this.setupState();

    this.note(
      "Production runtime model egress currently uses the Kubernetes driver public TCP/443 policy until the per-Agent model proxy replaces it. Setup will not claim a narrower allowlist.",
    );

    try {
      const generated =
        setup.pendingInstall && !setup.helmInstalled
          ? await this.existingGeneratedState(setup)
          : await this.generatedState(setup);
      const files = await this.writeRenderedFiles(generated);
      await this.helm("lint", [CHART_PATH, "-n", this.config.systemNamespace, "-f", files.values]);
      await this.helm("template", [
        this.config.release,
        CHART_PATH,
        "-n",
        this.config.systemNamespace,
        "-f",
        files.values,
      ]);
      if (setup.pendingInstall && !setup.helmInstalled) {
        await this.resumePendingInstall(generated, files);
      }
      if (this.productionState().helmInstalled === true) {
        await this.waitForSystemReady();
        const { keyFile, passwordFile } = await this.copyBootstrapOutputs(
          generated.bootstrapClaimName,
        );
        await this.patchProductionState({
          pendingInstall: false,
          helmInstalled: true,
          keyFile,
          passwordFile,
          url: this.config.url,
        });
        return { url: this.config.url, keyFile };
      }
      await this.ensureSystemNamespace();
      const systemSecrets = await this.systemSecretData(generated, files);
      for (const [name, stringData] of systemSecrets) await this.ensureSecret(name, stringData);
      await this.ensureBootstrapClaim(generated.bootstrapClaimName);
      if (!generated.bootstrapPrepared) {
        await this.prepareBootstrapClaim(generated.bootstrapClaimName);
        await this.patchGenerated({ bootstrapPrepared: true });
      }
      await this.patchProductionState({ pendingInstall: true });
      await this.helm(
        "upgrade",
        [
          "--install",
          this.config.release,
          CHART_PATH,
          "-n",
          this.config.systemNamespace,
          "-f",
          files.values,
          "--wait",
          "--timeout",
          "300s",
        ],
        { timeout: 360_000 },
      );
      await this.patchProductionState({ pendingInstall: false, helmInstalled: true });
      await this.waitForSystemReady();
      const { keyFile, passwordFile } = await this.copyBootstrapOutputs(
        generated.bootstrapClaimName,
      );
      await this.patchProductionState({ keyFile, passwordFile, url: this.config.url });
      return { url: this.config.url, keyFile };
    } finally {
      await this.cleanupTemporaryPods();
    }
  }

  async prepareNamespace(namespaceId) {
    const namespace = await this.findBackingNamespace(namespaceId);
    await this.ensureRoleBinding(namespace.name, {
      name: `${this.config.release}-openclaw-worker`,
      role: `${this.config.release}-openclaw-tenant-worker`,
      serviceAccount: "openclaw-enterprise-worker",
    });
    await this.ensureRoleBinding(namespace.name, {
      name: `${this.config.release}-openclaw-configuration`,
      role: `${this.config.release}-openclaw-tenant-configuration`,
      serviceAccount: "openclaw-enterprise-api",
    });
    const namespaces = { ...(this.productionState().namespaces ?? {}) };
    namespaces[namespaceId] = namespace.name;
    await this.patchProductionState({ namespaces, lastNamespaceId: namespaceId });
    return { namespace: namespace.name };
  }

  async prepareAgent(agentId) {
    const resolved = await this.resolveAgentNamespace(agentId);
    const transportName = `${TRANSPORT_SECRET_PREFIX}-${hash(agentId)}`;
    const existingTransport = await this.existingOwnedSecret(
      transportName,
      resolved.tenantNamespace,
      {
        namespaceId: resolved.namespaceId,
        agentId,
        secretKind: "transport",
      },
    );
    if (existingTransport === undefined) {
      await this.ensureAgentSecret({
        namespace: resolved.tenantNamespace,
        namespaceId: resolved.namespaceId,
        agentId,
        name: transportName,
        data: { "gateway-token": randomBytes(32).toString("base64url") },
        secretKind: "transport",
      });
    }
    const existingModel = await this.existingOwnedSecret(
      `${MODEL_SECRET_PREFIX}-${hash(agentId)}`,
      resolved.tenantNamespace,
      {
        namespaceId: resolved.namespaceId,
        agentId,
        secretKind: "model",
      },
    );
    if (existingModel === undefined) {
      const key = await this.resolveModelKey();
      await this.ensureAgentSecret({
        namespace: resolved.tenantNamespace,
        namespaceId: resolved.namespaceId,
        agentId,
        name: `${MODEL_SECRET_PREFIX}-${hash(agentId)}`,
        data: { OPENAI_API_KEY: key },
        secretKind: "model",
      });
    }
    return {
      namespaceId: resolved.namespaceId,
      tenantNamespace: resolved.tenantNamespace,
      agentId,
    };
  }

  async tuiCommand({ namespaceId, agentId, revisionId, session, message }) {
    const tenantNamespace = (await this.findBackingNamespace(namespaceId)).name;
    const configMap = `gateway-${hash(agentId)}-rev-${hash(revisionId)}`;
    const selector = [
      "app.kubernetes.io/managed-by=openclaw-enterprise",
      `openclaw.dev/namespace=${namespaceId}`,
      `openclaw.dev/agent=${agentId}`,
      "openclaw.dev/workload-role=gateway",
    ].join(",");
    const pod = await this.waitForReadyGatewayPod({
      tenantNamespace,
      selector,
      configMap,
    });
    const stateDir = `/tmp/openclaw-tui-${hash(`${namespaceId}:${agentId}`)}`;
    return {
      command: "kubectl",
      args: [
        ...this.kubectlArgs([
          "-n",
          tenantNamespace,
          "exec",
          "-it",
          pod,
          "-c",
          "gateway",
          "--",
          "env",
          "-u",
          "OPENAI_API_KEY",
          `OPENCLAW_STATE_DIR=${stateDir}`,
          "node",
          "/app/openclaw.mjs",
          "tui",
          ...(session === undefined ? [] : ["--session", nonempty(session, "session")]),
          ...(message === undefined ? [] : ["--message", nonempty(message, "message")]),
        ]),
      ],
    };
  }

  async validateProtectedInputs({ requireModelKey }) {
    await this.assertProtectedFile(this.config.kubeconfig, "kubeconfig");
    await this.assertProtectedFile(
      this.config.database.applicationUrlFile,
      "database.applicationUrlFile",
    );
    await this.assertProtectedFile(
      this.config.database.migrationUrlFile,
      "database.migrationUrlFile",
    );
    if (this.config.modelKeyFile !== undefined) {
      await this.assertProtectedFile(this.config.modelKeyFile, "modelKeyFile");
    } else if (requireModelKey && this.modelKey === undefined) {
      throw new Error("OPENAI_API_KEY must be supplied by the setup CLI or modelKeyFile.");
    }
  }

  async ensurePrivateDirectory() {
    await mkdir(this.directory, { mode: 0o700, recursive: true });
    const info = await lstat(this.directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("The production setup state directory must be a real directory.");
    }
    if ((info.mode & 0o077) !== 0) {
      throw new Error("The production setup state directory must not be group/world accessible.");
    }
  }

  async setupState() {
    const existing = this.productionState();
    const fingerprint = stableHash(publicConfigFingerprintInput(this.config));
    if (existing.configFingerprint !== undefined && existing.configFingerprint !== fingerprint) {
      throw new Error(
        "The existing production setup state belongs to a different non-secret configuration.",
      );
    }
    await this.patchProductionState({ configFingerprint: fingerprint });
    return this.productionState();
  }

  async generatedState(setup) {
    const generated = setup.generated ?? {};
    const authSecretFile = generated.authSecretFile ?? join(this.directory, "occ-auth-secret");
    if (generated.authSecretFile === undefined) {
      const existing = await optionalPrivateFile(authSecretFile);
      if (existing === undefined) {
        await writePrivateFile(authSecretFile, randomBytes(32).toString("base64url"));
      }
    } else {
      await this.assertProtectedFile(authSecretFile, "generated.authSecretFile");
    }
    const authSecret = (await readFile(authSecretFile, "utf8")).trim();
    if (!secretValue(authSecret)) throw new Error("generated.authSecretFile is invalid.");
    this.addRedactions([authSecret]);
    const next = {
      authSecretFile,
      authSecretFingerprint: stableHash({ authSecret }),
      bootstrapClaimName: generated.bootstrapClaimName ?? `${this.config.release}-bootstrap-output`,
      bootstrapPrepared: generated.bootstrapPrepared === true,
    };
    await this.patchGenerated(next);
    return { ...this.productionState().generated, authSecret };
  }

  async existingGeneratedState(setup) {
    const generated = setup.generated ?? {};
    const authSecretFile = generated.authSecretFile ?? join(this.directory, "occ-auth-secret");
    await this.assertProtectedFile(authSecretFile, "generated.authSecretFile");
    const authSecret = (await readFile(authSecretFile, "utf8")).trim();
    if (!secretValue(authSecret)) throw new Error("generated.authSecretFile is invalid.");
    this.addRedactions([authSecret]);
    return {
      authSecretFile,
      authSecretFingerprint: stableHash({ authSecret }),
      bootstrapClaimName: generated.bootstrapClaimName ?? `${this.config.release}-bootstrap-output`,
      bootstrapPrepared: generated.bootstrapPrepared === true,
      authSecret,
    };
  }

  async systemSecretData(generated, files) {
    const applicationUrl = (
      await this.readProtectedFile(
        this.config.database.applicationUrlFile,
        "database.applicationUrlFile",
      )
    ).trim();
    const migrationUrl = (
      await this.readProtectedFile(
        this.config.database.migrationUrlFile,
        "database.migrationUrlFile",
      )
    ).trim();
    this.addRedactions([applicationUrl, migrationUrl, generated.authSecret]);
    return [
      [
        "occ-installation-startup",
        { "installation.yaml": await readFile(files.installation, "utf8") },
      ],
      [
        "occ-database",
        {
          "application-url": applicationUrl,
          "migration-url": migrationUrl,
        },
      ],
      ["occ-auth", { secret: generated.authSecret }],
    ];
  }

  async resumePendingInstall(generated, files) {
    let lastObservation = "not inspected";
    try {
      await this.waitFor(
        "pending Helm installation to become inspectable",
        async () => {
          try {
            return (await this.inspectCompletedHelmInstall(generated, files)) ? true : false;
          } catch (error) {
            lastObservation = String(error?.message ?? error);
            return false;
          }
        },
        60_000,
      );
    } catch {
      throw new Error(
        `Production setup stopped during Helm install for release ${this.config.release} in namespace ${this.config.systemNamespace}, and setup could not prove that bootstrap completed. Inspect Helm release ${this.config.release}, Job ${this.config.release}-initialization, Deployments openclaw-enterprise-api/openclaw-enterprise-worker, Secrets occ-installation-startup/occ-database/occ-auth, and PVC ${generated.bootstrapClaimName} in namespace ${this.config.systemNamespace}; preserve the state directory and rerun setup only after resolving that exact release. Last observation: ${lastObservation}`,
      );
    }
    await this.patchProductionState({ pendingInstall: false, helmInstalled: true });
  }

  async inspectCompletedHelmInstall(generated, files) {
    const status = await this.helm(
      "status",
      [this.config.release, "-n", this.config.systemNamespace, "-o", "json"],
      { timeout: 60_000 },
    );
    const payload = JSON.parse(status);
    if (payload.info?.status !== "deployed") return false;

    const namespace = await this.getObject("namespace", this.config.systemNamespace);
    if (namespace === undefined) return false;
    this.verifySetupOwnership(namespace, "Namespace", { allowHelmManaged: true });

    for (const [name, stringData] of await this.systemSecretData(generated, files)) {
      const secret = await this.getObject("secret", name, this.config.systemNamespace);
      if (secret === undefined) return false;
      this.verifySetupOwnership(secret, "Secret");
      if (!secretDataMatches(secret, stringData)) {
        throw new Error(
          `Existing setup-owned Secret ${name} does not match rendered production input.`,
        );
      }
    }

    const claim = await this.getObject(
      "pvc",
      generated.bootstrapClaimName,
      this.config.systemNamespace,
    );
    if (claim === undefined) return false;
    this.verifySetupOwnership(claim, "PersistentVolumeClaim");
    if (claim.spec?.storageClassName !== this.config.bootstrapStorageClass) {
      throw new Error(
        `Existing bootstrap PVC ${generated.bootstrapClaimName} uses an unexpected storage class.`,
      );
    }

    for (const deployment of ["openclaw-enterprise-api", "openclaw-enterprise-worker"]) {
      const object = await this.getObject("deployment", deployment, this.config.systemNamespace);
      if (object === undefined) return false;
      this.verifyHelmReleaseOwnership(object, "Deployment");
    }

    const job = await this.getObject(
      "job",
      `${this.config.release}-initialization`,
      this.config.systemNamespace,
    );
    if (job === undefined) return false;
    this.verifyHelmReleaseOwnership(job, "Job");
    if (job.status?.failed > 0) {
      throw new Error(`Initialization Job ${this.config.release}-initialization failed.`);
    }
    return (
      job.status?.succeeded > 0 ||
      job.status?.conditions?.some(
        (condition) => condition.type === "Complete" && condition.status === "True",
      )
    );
  }

  async writeRenderedFiles(generated) {
    const installation = join(this.directory, "production-installation.yaml");
    const values = join(this.directory, "production-values.json");
    await writePrivateFile(
      installation,
      `${JSON.stringify(renderInstallationConfig(this.config), undefined, 2)}\n`,
    );
    await writePrivateFile(
      values,
      `${JSON.stringify(renderHelmValues(this.config, generated), undefined, 2)}\n`,
    );
    return { installation, values };
  }

  async ensureSystemNamespace() {
    const name = this.config.systemNamespace;
    const existing = await this.getObject("namespace", name);
    if (existing !== undefined) {
      this.verifySetupOwnership(existing, "Namespace", { allowHelmManaged: true });
      return;
    }
    await this.createObject({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: this.metadata(name),
    });
  }

  async ensureSecret(name, stringData) {
    const existing = await this.getObject("secret", name, this.config.systemNamespace);
    if (existing !== undefined) {
      this.verifySetupOwnership(existing, "Secret");
      if (!secretDataMatches(existing, stringData)) {
        throw new Error(`Refusing to rotate existing setup-owned Secret ${name}.`);
      }
      return;
    }
    await this.createObject({
      apiVersion: "v1",
      kind: "Secret",
      metadata: this.metadata(name, { namespace: this.config.systemNamespace }),
      stringData,
    });
  }

  async ensureBootstrapClaim(name) {
    const existing = await this.getObject("pvc", name, this.config.systemNamespace);
    if (existing !== undefined) {
      this.verifySetupOwnership(existing, "PersistentVolumeClaim");
      const storageClass = existing.spec?.storageClassName;
      if (storageClass !== this.config.bootstrapStorageClass) {
        throw new Error(`Existing bootstrap PVC ${name} uses an unexpected storage class.`);
      }
      return;
    }
    await this.createObject({
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: this.metadata(name, { namespace: this.config.systemNamespace }),
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: this.config.bootstrapStorageClass,
        resources: { requests: { storage: "1Gi" } },
      },
    });
  }

  async prepareBootstrapClaim(claimName) {
    const pod = `${this.config.release}-bootstrap-prepare-${randomUUID().slice(0, 8)}`;
    this.temporaryPods.push({ name: pod, namespace: this.config.systemNamespace });
    await this.createObject({
      apiVersion: "v1",
      kind: "Pod",
      metadata: this.metadata(pod, {
        namespace: this.config.systemNamespace,
        labels: { "openclaw.dev/setup-temporary": "true" },
      }),
      spec: {
        restartPolicy: "Never",
        automountServiceAccountToken: false,
        securityContext: {
          runAsUser: 0,
          runAsGroup: 0,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            name: "prepare",
            image: this.config.controllerImage,
            imagePullPolicy: "IfNotPresent",
            command: [
              "node",
              "-e",
              [
                "const fs=require('node:fs');",
                `const root=${JSON.stringify(BOOTSTRAP_MOUNT)};`,
                `for (const name of ${JSON.stringify([BOOTSTRAP_PASSWORD_FILE, BOOTSTRAP_SERVICE_KEY_FILE])}) {`,
                "  if (fs.existsSync(`${root}/${name}`)) throw new Error(`${name} already exists on bootstrap PVC`);",
                "}",
                "fs.chownSync(root, 1000, 1000);",
                "fs.chmodSync(root, 0o700);",
              ].join(""),
            ],
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"], add: ["CHOWN", "FOWNER"] },
            },
            resources: {
              requests: { cpu: "50m", memory: "64Mi" },
              limits: { cpu: "500m", memory: "256Mi" },
            },
            volumeMounts: [{ name: "bootstrap", mountPath: BOOTSTRAP_MOUNT }],
          },
        ],
        volumes: [{ name: "bootstrap", persistentVolumeClaim: { claimName } }],
      },
    });
    await this.waitForSucceededPod(pod, this.config.systemNamespace, "bootstrap PVC preparation");
  }

  async waitForSystemReady() {
    await this.kubectl(
      [
        "-n",
        this.config.systemNamespace,
        "rollout",
        "status",
        "deployment/openclaw-enterprise-api",
        "--timeout=180s",
      ],
      { timeout: 210_000 },
    );
    await this.kubectl(
      [
        "-n",
        this.config.systemNamespace,
        "rollout",
        "status",
        "deployment/openclaw-enterprise-worker",
        "--timeout=180s",
      ],
      { timeout: 210_000 },
    );
  }

  async copyBootstrapOutputs(claimName) {
    const keyFile = join(this.directory, BOOTSTRAP_SERVICE_KEY_FILE);
    const passwordFile = join(this.directory, "initial-admin-password");
    const missing = [];
    for (const target of [
      { path: keyFile, label: "Bootstrap service-key file", validate: validateServiceKeyFile },
      { path: passwordFile, label: "Bootstrap password file", validate: validatePasswordFile },
    ]) {
      try {
        await this.assertProtectedFile(target.path, target.label);
        await target.validate(target.path);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        missing.push(target);
      }
    }
    if (missing.length === 0) return { keyFile, passwordFile };

    const pod = `${this.config.release}-bootstrap-reader-${randomUUID().slice(0, 8)}`;
    this.temporaryPods.push({ name: pod, namespace: this.config.systemNamespace });
    await this.createObject({
      apiVersion: "v1",
      kind: "Pod",
      metadata: this.metadata(pod, {
        namespace: this.config.systemNamespace,
        labels: { "openclaw.dev/setup-temporary": "true" },
      }),
      spec: {
        restartPolicy: "Never",
        automountServiceAccountToken: false,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            name: "reader",
            image: this.config.controllerImage,
            imagePullPolicy: "IfNotPresent",
            command: ["node", "-e", "setInterval(() => {}, 1000)"],
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ["ALL"] },
            },
            resources: {
              requests: { cpu: "25m", memory: "64Mi" },
              limits: { cpu: "250m", memory: "128Mi" },
            },
            volumeMounts: [{ name: "bootstrap", mountPath: BOOTSTRAP_MOUNT, readOnly: true }],
          },
        ],
        volumes: [{ name: "bootstrap", persistentVolumeClaim: { claimName, readOnly: true } }],
      },
    });
    await this.kubectl(
      [
        "-n",
        this.config.systemNamespace,
        "wait",
        "--for=condition=Ready",
        `pod/${pod}`,
        "--timeout=120s",
      ],
      { timeout: 150_000 },
    );
    for (const target of missing) {
      const remoteName =
        target.path === keyFile ? BOOTSTRAP_SERVICE_KEY_FILE : BOOTSTRAP_PASSWORD_FILE;
      await this.kubectl([
        "-n",
        this.config.systemNamespace,
        "cp",
        `${pod}:${BOOTSTRAP_MOUNT}/${remoteName}`,
        target.path,
        "-c",
        "reader",
      ]);
      await chmod(target.path, 0o600);
      await target.validate(target.path);
    }
    return { keyFile, passwordFile };
  }

  async findBackingNamespace(namespaceId) {
    const id = occId(namespaceId, "namespaceId");
    return this.waitFor("backing Kubernetes Namespace", async () => {
      const output = await this.kubectl([
        "get",
        "namespaces",
        "-l",
        `openclaw.dev/namespace=${id}`,
        "-o",
        "json",
      ]);
      const items = JSON.parse(output).items;
      const matches = items.filter(
        (item) =>
          item.metadata?.deletionTimestamp === undefined &&
          item.metadata?.annotations?.["openclaw.dev/namespace-id"] === id,
      );
      const foreign = items.filter(
        (item) => item.metadata?.annotations?.["openclaw.dev/namespace-id"] !== id,
      );
      if (foreign.length > 0 || matches.length > 1) {
        throw new Error(`Expected exactly one backing Kubernetes Namespace for ${id}.`);
      }
      return matches[0] === undefined ? false : { name: matches[0].metadata.name };
    });
  }

  async ensureRoleBinding(namespace, { name, role, serviceAccount }) {
    const existing = await this.getObject("rolebinding", name, namespace);
    const desired = {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: this.metadata(name, { namespace }),
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: role,
      },
      subjects: [
        {
          kind: "ServiceAccount",
          name: serviceAccount,
          namespace: this.config.systemNamespace,
        },
      ],
    };
    if (existing !== undefined) {
      this.verifySetupOwnership(existing, "RoleBinding");
      if (
        !sameJson(existing.roleRef, desired.roleRef) ||
        !sameJson(existing.subjects, desired.subjects)
      ) {
        throw new Error(
          `Existing RoleBinding ${namespace}/${name} does not match production setup.`,
        );
      }
      return;
    }
    await this.createObject(desired);
  }

  async resolveAgentNamespace(agentId) {
    const id = occId(agentId, "agentId");
    const known = this.productionState().agentNamespaces?.[id];
    if (known !== undefined) return known;
    const namespaceId = occId(this.productionState().lastNamespaceId, "lastNamespaceId");
    const agent = await this.api("GET", `/namespaces/${namespaceId}/agents/${id}`);
    if (agent?.data?.id !== id || agent.data.namespaceId !== namespaceId) {
      throw new Error(`Production API did not return the exact Agent ${id}.`);
    }
    const backing = await this.findBackingNamespace(namespaceId);
    const resolved = {
      namespaceId,
      tenantNamespace: backing.name,
      agentId: id,
    };
    const agentNamespaces = { ...(this.productionState().agentNamespaces ?? {}) };
    agentNamespaces[id] = resolved;
    await this.patchProductionState({ agentNamespaces });
    return resolved;
  }

  async ensureAgentSecret({ namespace, namespaceId, agentId, name, data, secretKind }) {
    const existing = await this.existingOwnedSecret(name, namespace, {
      namespaceId,
      agentId,
      secretKind,
    });
    if (existing !== undefined) {
      if (!secretDataMatches(existing, data)) {
        throw new Error(
          `Refusing to rotate existing Agent ${secretKind} Secret ${namespace}/${name}.`,
        );
      }
      return;
    }
    await this.createObject({
      apiVersion: "v1",
      kind: "Secret",
      metadata: this.metadata(name, {
        namespace,
        labels: {
          "openclaw.dev/namespace": namespaceId,
          "openclaw.dev/agent": agentId,
          "openclaw.dev/setup-secret-kind": secretKind,
        },
        annotations: {
          "openclaw.dev/namespace-id": namespaceId,
          "openclaw.dev/agent-id": agentId,
        },
      }),
      stringData: data,
    });
  }

  async existingOwnedSecret(name, namespace, { namespaceId, agentId, secretKind }) {
    const existing = await this.getObject("secret", name, namespace);
    if (existing === undefined) return undefined;
    this.verifySetupOwnership(existing, "Secret");
    const metadata = existing.metadata;
    if (
      metadata?.labels?.["openclaw.dev/namespace"] !== namespaceId ||
      metadata?.labels?.["openclaw.dev/agent"] !== agentId ||
      metadata?.labels?.["openclaw.dev/setup-secret-kind"] !== secretKind ||
      metadata?.annotations?.["openclaw.dev/namespace-id"] !== namespaceId ||
      metadata?.annotations?.["openclaw.dev/agent-id"] !== agentId
    ) {
      throw new Error(`Existing Secret ${namespace}/${name} does not match the exact Agent scope.`);
    }
    return existing;
  }

  async waitForReadyGatewayPod({ tenantNamespace, selector, configMap }) {
    return this.waitFor("ready gateway Pod", async () => {
      const output = await this.kubectl([
        "-n",
        tenantNamespace,
        "get",
        "pods",
        "-l",
        selector,
        "-o",
        "json",
      ]);
      const matches = JSON.parse(output).items.filter(
        (pod) =>
          pod.metadata?.deletionTimestamp === undefined &&
          pod.status?.phase === "Running" &&
          pod.status?.conditions?.some(
            (condition) => condition.type === "Ready" && condition.status === "True",
          ) &&
          pod.spec?.volumes?.some((volume) => volume.configMap?.name === configMap),
      );
      if (matches.length > 1) throw new Error("Ambiguous active gateway Pod.");
      return matches[0]?.metadata?.name;
    });
  }

  async waitForSucceededPod(name, namespace, description) {
    await this.waitFor(description, async () => {
      const pod = await this.getObject("pod", name, namespace);
      if (pod?.status?.phase === "Failed") throw new Error(`${description} Pod failed.`);
      return pod?.status?.phase === "Succeeded";
    });
  }

  async waitFor(description, operation, timeoutMs = 240_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await operation();
      if (result !== undefined && result !== false) return result;
      await delay(1_000);
    }
    throw new Error(`Timed out waiting for ${description}.`);
  }

  async api(method, path, body) {
    const keyFile = this.productionState().keyFile;
    if (typeof keyFile !== "string") {
      throw new Error("Production setup must retrieve the bootstrap service key before API calls.");
    }
    const key = JSON.parse(await this.readProtectedFile(keyFile, "bootstrap service key")).data
      ?.key;
    if (!secretValue(key)) throw new Error("The bootstrap service-key file is invalid.");
    const response = await fetch(`${this.config.url}${path}`, {
      method,
      headers: {
        "x-api-key": key,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      throw new Error(`Production API returned invalid JSON (HTTP ${response.status}).`);
    }
    if (!response.ok)
      throw new Error(`Production API ${method} ${path} failed with HTTP ${response.status}.`);
    if (!payload || typeof payload !== "object" || !("data" in payload) || !("meta" in payload)) {
      throw new Error(`Production API ${method} ${path} returned an unsupported envelope.`);
    }
    return payload;
  }

  async resolveModelKey() {
    if (this.modelKey !== undefined) return this.modelKey;
    if (this.config.modelKeyFile === undefined) {
      throw new Error("OPENAI_API_KEY must be supplied to create the Agent model Secret.");
    }
    const value = (await this.readProtectedFile(this.config.modelKeyFile, "modelKeyFile")).trim();
    if (!secretValue(value)) throw new Error("modelKeyFile does not contain a valid model key.");
    return value;
  }

  async readProtectedFile(path, label) {
    await this.assertProtectedFile(path, label);
    return readFile(path, "utf8");
  }

  async assertProtectedFile(path, label) {
    const link = await lstat(path);
    if (link.isSymbolicLink()) throw new Error(`${label} must not be a symlink.`);
    const file = await stat(path);
    if (!file.isFile()) throw new Error(`${label} must be a regular file.`);
    if ((file.mode & 0o077) !== 0) {
      throw new Error(`${label} must not be group/world accessible.`);
    }
  }

  async createObject(object) {
    const kind = object?.kind ?? "object";
    const name = object?.metadata?.name ?? "unknown";
    const namespace = object?.metadata?.namespace;
    const label = namespace === undefined ? `${kind} ${name}` : `${kind} ${namespace}/${name}`;
    const sensitiveValues = object?.kind === "Secret" ? Object.values(object.stringData ?? {}) : [];
    this.addRedactions(sensitiveValues);
    try {
      return await this.kubectl(["create", "-f", "-"], {
        input: `${JSON.stringify(object)}\n`,
        capture: true,
        sensitiveValues,
      });
    } catch (error) {
      if (object?.kind === "Secret") {
        throw new Error(`Failed to create ${label}; check cluster access and admission policy.`);
      }
      throw new Error(
        `Failed to create ${label}: ${redact(String(error?.message ?? error), [
          ...this.redactions,
          ...sensitiveValues,
        ])}`,
      );
    }
  }

  async getObject(kind, name, namespace) {
    try {
      const output = await this.kubectl([
        ...(namespace === undefined ? [] : ["-n", namespace]),
        "get",
        kind,
        name,
        "-o",
        "json",
      ]);
      return JSON.parse(output);
    } catch (error) {
      if (/not found|NotFound/i.test(String(error?.message))) return undefined;
      throw error;
    }
  }

  async getMetadata(kind, name, namespace) {
    const object = await this.getObject(kind, name, namespace);
    return object?.metadata;
  }

  async kubectl(args, options = {}) {
    return this.command("kubectl", this.kubectlArgs(args), options);
  }

  kubectlArgs(args) {
    return ["--kubeconfig", this.config.kubeconfig, "--context", this.config.context, ...args];
  }

  async helm(action, args, options = {}) {
    return this.command(
      "helm",
      [
        action,
        ...args,
        "--kubeconfig",
        this.config.kubeconfig,
        "--kube-context",
        this.config.context,
      ],
      options,
    );
  }

  async command(command, args, options = {}) {
    const { sensitiveValues = [], ...runOptions } = options;
    this.addRedactions(sensitiveValues);
    try {
      return await this.run(command, args, {
        capture: true,
        timeout: 120_000,
        ...runOptions,
      });
    } catch (error) {
      const message = redact(String(error?.message ?? error), [
        ...this.redactions,
        ...sensitiveValues,
      ]);
      throw new Error(message);
    }
  }

  metadata(name, { namespace, labels = {}, annotations = {} } = {}) {
    return {
      name,
      ...(namespace === undefined ? {} : { namespace }),
      labels: {
        "app.kubernetes.io/managed-by": MANAGER,
        "openclaw.dev/setup-release": this.config.release,
        ...labels,
      },
      annotations: {
        "openclaw.dev/setup-system-namespace": this.config.systemNamespace,
        ...annotations,
      },
    };
  }

  verifySetupOwnership(object, kind, { allowHelmManaged = false } = {}) {
    const labels = object.metadata?.labels ?? object.labels ?? {};
    const annotations = object.metadata?.annotations ?? object.annotations ?? {};
    if (
      labels["app.kubernetes.io/managed-by"] === MANAGER &&
      labels["openclaw.dev/setup-release"] === this.config.release &&
      annotations["openclaw.dev/setup-system-namespace"] === this.config.systemNamespace
    ) {
      return;
    }
    if (allowHelmManaged && labels["app.kubernetes.io/managed-by"] === "Helm") return;
    throw new Error(`Refusing to adopt foreign existing ${kind}.`);
  }

  verifyHelmReleaseOwnership(object, kind) {
    const labels = object.metadata?.labels ?? {};
    const annotations = object.metadata?.annotations ?? {};
    const annotatedRelease = annotations["meta.helm.sh/release-name"];
    const annotatedNamespace = annotations["meta.helm.sh/release-namespace"];
    if (
      labels["app.kubernetes.io/managed-by"] === "Helm" &&
      labels["app.kubernetes.io/instance"] === this.config.release &&
      (annotatedRelease === undefined || annotatedRelease === this.config.release) &&
      (annotatedNamespace === undefined || annotatedNamespace === this.config.systemNamespace)
    ) {
      return;
    }
    throw new Error(`Refusing to trust foreign existing ${kind}.`);
  }

  async cleanupTemporaryPods() {
    for (const { name, namespace } of this.temporaryPods.reverse()) {
      try {
        await this.kubectl(
          ["-n", namespace, "delete", "pod", name, "--ignore-not-found", "--wait=false"],
          {
            timeout: 30_000,
          },
        );
        await this.kubectl(
          ["-n", namespace, "wait", "--for=delete", `pod/${name}`, "--timeout=30s"],
          {
            timeout: 40_000,
          },
        );
      } catch (error) {
        this.note(
          `Temporary Pod cleanup did not complete for ${namespace}/${name}: ${String(error?.message ?? error)}`,
        );
      }
    }
  }

  addRedactions(values) {
    for (const value of values) {
      if (secretValue(value)) this.redactions.add(String(value));
    }
  }

  note(message) {
    this.progress(message);
  }

  productionState() {
    return object(this.state.production ?? {}, "production setup state");
  }

  async patchGenerated(patch) {
    const production = this.productionState();
    await this.patchProductionState({
      generated: { ...(production.generated ?? {}), ...patch },
    });
  }

  async patchProductionState(patch) {
    this.state.production = { ...this.productionState(), ...patch };
    await this.save();
  }
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function knownKeys(value, keys, label) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported key ${key}.`);
  }
}

function nonempty(value, label) {
  if (typeof value !== "string" || value.trim().length === 0 || /[\r\n]/.test(value)) {
    throw new Error(`${label} must be a non-empty single-line string.`);
  }
  return value.trim();
}

function absolutePath(value, label) {
  const path = nonempty(value, label);
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return path;
}

function kubernetesName(value, label) {
  const name = nonempty(value, label);
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) || name.length > 63) {
    throw new Error(`${label} must be a Kubernetes DNS label.`);
  }
  return name;
}

function occId(value, label) {
  const id = nonempty(value, label);
  if (!/^[a-z]+_[A-Za-z0-9-]+$/.test(id)) throw new Error(`${label} must be an OCC ID.`);
  return id;
}

function immutableImage(value, label) {
  const image = nonempty(value, label);
  if (!/^\S+@sha256:[a-fA-F0-9]{64}$/.test(image)) {
    throw new Error(`${label} must be an immutable sha256 image reference.`);
  }
  return image;
}

function httpsUrl(value, label) {
  const raw = nonempty(value, label);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute URL.`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${label} must use HTTPS.`);
  return parsed.toString().replace(/\/$/, "");
}

function email(value, label) {
  const address = nonempty(value, label).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    throw new Error(`${label} must be an email address.`);
  }
  return address;
}

function database(value) {
  const config = object(value, "database");
  knownKeys(config, DATABASE_KEYS, "database");
  return {
    applicationUrlFile: absolutePath(config.applicationUrlFile, "database.applicationUrlFile"),
    migrationUrlFile: absolutePath(config.migrationUrlFile, "database.migrationUrlFile"),
    cidr: ipv4Cidr32(config.cidr, "database.cidr"),
    port: port(config.port, "database.port"),
  };
}

function kubernetesApi(value) {
  const config = object(value, "kubernetesApi");
  knownKeys(config, KUBERNETES_API_KEYS, "kubernetesApi");
  return {
    cidr: ipv4Cidr32(config.cidr, "kubernetesApi.cidr"),
    port: port(config.port, "kubernetesApi.port"),
  };
}

function dns(value, label) {
  const config = object(value, label);
  knownKeys(config, DNS_KEYS, label);
  return workloadPeer(config, label);
}

function workloadPeer(value, label) {
  const peer = object(value, label);
  knownKeys(peer, WORKLOAD_PEER_KEYS, label);
  return {
    namespace: kubernetesName(peer.namespace, `${label}.namespace`),
    podLabels: podLabels(peer.podLabels, `${label}.podLabels`),
  };
}

function podLabels(value, label) {
  const labels = object(value, label);
  const entries = Object.entries(labels);
  if (entries.length === 0) throw new Error(`${label} must not be empty.`);
  return Object.freeze(
    Object.fromEntries(
      entries.map(([key, value]) => [
        labelKey(key, `${label}.${key}`),
        labelValue(value, `${label}.${key}`),
      ]),
    ),
  );
}

function labelKey(value, label) {
  const key = nonempty(value, label);
  if (!/^([A-Za-z0-9][-A-Za-z0-9_.]*\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/.test(key)) {
    throw new Error(`${label} must be a Kubernetes label key.`);
  }
  return key;
}

function labelValue(value, label) {
  const text = nonempty(value, label);
  if (text.length > 63 || !/^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/.test(text)) {
    throw new Error(`${label} must be a Kubernetes label value.`);
  }
  return text;
}

function ipv4Cidr32(value, label) {
  const cidr = nonempty(value, label);
  const [address, suffix, extra] = cidr.split("/");
  if (extra !== undefined || suffix !== "32" || isIP(address) !== 4) {
    throw new Error(`${label} must identify one IPv4 host with /32.`);
  }
  return cidr;
}

function port(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${label} must be a TCP port from 1 to 65535.`);
  }
  return value;
}

function secretValue(value) {
  return typeof value === "string" && value.trim().length > 0 && !/[\r\n]/.test(value);
}

function stableHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameJson(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function secretDataMatches(secret, stringData) {
  const actual = secret.data ?? {};
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(stringData).sort();
  if (!sameJson(actualKeys, expectedKeys)) return false;
  return expectedKeys.every((key) => {
    const encoded = actual[key];
    if (typeof encoded !== "string") return false;
    return Buffer.from(encoded, "base64").toString("utf8") === String(stringData[key]);
  });
}

function publicConfigFingerprintInput(config) {
  return structuredClone(config);
}

async function writePrivateFile(path, contents) {
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function optionalPrivateFile(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) {
      throw new Error("Existing generated secret file is not protected.");
    }
    return path;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function validateServiceKeyFile(path) {
  const payload = JSON.parse(await readFile(path, "utf8"));
  if (!secretValue(payload?.data?.key)) {
    throw new Error("Bootstrap service-key file does not contain data.key.");
  }
  if (payload.meta?.installationId !== undefined && !secretValue(payload.meta.installationId)) {
    throw new Error("Bootstrap service-key file contains invalid installation metadata.");
  }
}

async function validatePasswordFile(path) {
  const password = (await readFile(path, "utf8")).trim();
  if (!secretValue(password)) {
    throw new Error("Bootstrap password file is empty.");
  }
}

function redact(message, secrets) {
  let text = String(message ?? "");
  const values = Array.isArray(secrets) ? secrets : [secrets];
  for (const secret of values) {
    if (!secretValue(secret)) continue;
    const raw = String(secret);
    text = text.split(raw).join("[redacted]");
    text = text.split(Buffer.from(raw).toString("base64")).join("[redacted]");
    text = text.split(JSON.stringify(raw).slice(1, -1)).join("[redacted]");
  }
  return text;
}
