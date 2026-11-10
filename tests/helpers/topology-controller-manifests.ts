import type { ConfigurationRecord } from "../../apps/controller/src/composition/startup-file.ts";

type EnvironmentVariable =
  | { name: string; value: string }
  | {
      name: string;
      valueFrom:
        { secretKeyRef: { name: string; key: string } } | { fieldRef: { fieldPath: string } };
    };

type VolumeMount = {
  name: string;
  mountPath: string;
  readOnly?: boolean;
  subPath?: string;
};

type Volume = { name: string } & (
  | { secret: { secretName: string; items: { key: string; path: string }[] } }
  | { configMap: { name: string } }
);

type ControllerTopologyManifestInputs = {
  apiConfiguration: ConfigurationRecord;
  authBaseURL: string;
  authSecret: string;
  controller: { apiAccount: string; account: string };
  controllerImage: string;
  databaseAddress: string;
  databaseServiceName: string;
  inClusterDatabaseUrl: URL;
  kubernetesAddress: string;
  kubernetesPort: number;
  labels: Record<string, string>;
  name: string;
  configurationSecret: string;
  databaseSecret: string;
  authSecretName: string;
  probeConfigMap: string;
  probeSource: string;
  nativeAdminDomain: string;
  nativeAdminEnabled: boolean;
  platformNamespace: string;
  workerOptions: {
    pollIntervalMs: number;
    leaseDurationMs: number;
    maxAttempts: number;
    convergenceTimeoutMs: number;
  };
  workspaceGateway: { apiKeySecretName: string; caSecretName: string };
};

export function buildControllerTopologyManifests({
  apiConfiguration,
  authBaseURL,
  authSecret,
  controller,
  controllerImage,
  databaseAddress,
  databaseServiceName,
  inClusterDatabaseUrl,
  kubernetesAddress,
  kubernetesPort,
  labels,
  name,
  configurationSecret,
  databaseSecret,
  authSecretName,
  probeConfigMap,
  probeSource,
  nativeAdminDomain,
  nativeAdminEnabled,
  platformNamespace,
  workerOptions,
  workspaceGateway,
}: ControllerTopologyManifestInputs) {
  const resources = [
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: probeConfigMap, namespace: platformNamespace },
      data: { "gateway-probe.mjs": probeSource },
    },
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: configurationSecret, namespace: platformNamespace },
      stringData: { "installation.yaml": JSON.stringify(apiConfiguration) },
    },
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: databaseSecret, namespace: platformNamespace },
      stringData: { url: inClusterDatabaseUrl.toString() },
    },
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: authSecretName, namespace: platformNamespace },
      stringData: { secret: authSecret },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: databaseServiceName, namespace: platformNamespace },
      spec: { ports: [{ name: "postgres", port: 5432, targetPort: 5432 }] },
    },
    {
      apiVersion: "v1",
      kind: "Endpoints",
      metadata: { name: databaseServiceName, namespace: platformNamespace },
      subsets: [
        { addresses: [{ ip: databaseAddress }], ports: [{ name: "postgres", port: 5432 }] },
      ],
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name, namespace: platformNamespace },
      spec: { selector: labels, ports: [{ name: "http", port: 8080, targetPort: "http" }] },
    },
  ];
  const apiEnvironment: EnvironmentVariable[] = [
    { name: "NODE_ENV", value: "production" },
    {
      name: "OCC_CONFIG_PATH",
      value: "/etc/openclaw/installation/installation.yaml",
    },
    {
      name: "OCC_DATABASE_URL",
      valueFrom: { secretKeyRef: { name: databaseSecret, key: "url" } },
    },
    {
      name: "OCC_AUTH_SECRET",
      valueFrom: { secretKeyRef: { name: authSecretName, key: "secret" } },
    },
    { name: "OCC_AUTH_BASE_URL", value: authBaseURL },
    {
      name: "OCC_AGENT_NATIVE_ADMIN_ENABLED",
      value: nativeAdminEnabled ? "true" : "false",
    },
    { name: "OCC_AGENT_NATIVE_ADMIN_DOMAIN", value: nativeAdminDomain },
    {
      name: "OCC_HOST",
      valueFrom: { fieldRef: { fieldPath: "status.podIP" } },
    },
    { name: "OCC_PORT", value: "8080" },
    {
      name: "OCC_GATEWAY_API_KEY_PATH",
      value: "/etc/openclaw/gateway-api-key/key",
    },
    { name: "NODE_EXTRA_CA_CERTS", value: "/etc/openclaw/gateway-ca/ca.crt" },
  ];
  const apiVolumeMounts: VolumeMount[] = [
    {
      name: "installation",
      mountPath: "/etc/openclaw/installation",
      readOnly: true,
    },
    {
      name: "gateway-api-key",
      mountPath: "/etc/openclaw/gateway-api-key",
      readOnly: true,
    },
    { name: "gateway-ca", mountPath: "/etc/openclaw/gateway-ca", readOnly: true },
    {
      name: "gateway-probe",
      mountPath: "/app/apps/controller/gateway-probe.mjs",
      subPath: "gateway-probe.mjs",
      readOnly: true,
    },
  ];
  const apiContainer = {
    name: "api",
    image: controllerImage,
    imagePullPolicy: "IfNotPresent",
    args: ["apps/controller/src/server.mjs"],
    securityContext: {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      readOnlyRootFilesystem: true,
    },
    resources: {
      requests: { cpu: "100m", memory: "128Mi" },
      limits: { cpu: "1", memory: "1Gi" },
    },
    env: apiEnvironment,
    volumeMounts: apiVolumeMounts,
    ports: [{ name: "http", containerPort: 8080 }],
    readinessProbe: { httpGet: { path: "/readyz", port: "http" } },
    livenessProbe: { httpGet: { path: "/healthz", port: "http" } },
  };
  const apiVolumes: Volume[] = [
    {
      name: "installation",
      secret: {
        secretName: configurationSecret,
        items: [{ key: "installation.yaml", path: "installation.yaml" }],
      },
    },
    {
      name: "gateway-api-key",
      secret: {
        secretName: workspaceGateway.apiKeySecretName,
        items: [{ key: "occ", path: "key" }],
      },
    },
    {
      name: "gateway-ca",
      secret: {
        secretName: workspaceGateway.caSecretName,
        items: [{ key: "tls.crt", path: "ca.crt" }],
      },
    },
    { name: "gateway-probe", configMap: { name: probeConfigMap } },
  ];
  const apiPodSpec = {
    serviceAccountName: controller.apiAccount,
    automountServiceAccountToken: true,
    securityContext: {
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      seccompProfile: { type: "RuntimeDefault" },
    },
    containers: [
      apiContainer,
      {
        name: "loopback-forwarder",
        image: controllerImage,
        imagePullPolicy: "IfNotPresent",
        command: ["node", "-e"],
        args: [
          "const net=require('node:net');const host=process.env.POD_IP;net.createServer(client=>{const upstream=net.connect(8080,host);client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());client.pipe(upstream);upstream.pipe(client)}).listen(18080,'0.0.0.0')",
        ],
        env: [{ name: "POD_IP", valueFrom: { fieldRef: { fieldPath: "status.podIP" } } }],
        securityContext: {
          allowPrivilegeEscalation: false,
          capabilities: { drop: ["ALL"] },
          readOnlyRootFilesystem: true,
        },
        resources: {
          requests: { cpu: "10m", memory: "32Mi" },
          limits: { cpu: "100m", memory: "64Mi" },
        },
        ports: [{ name: "local-forward", containerPort: 18080 }],
      },
    ],
    volumes: apiVolumes,
  };
  const apiDeployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace: platformNamespace },
    spec: {
      replicas: 1,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: apiPodSpec,
      },
    },
  };
  const apiIsolation = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: `${name}-isolation`, namespace: platformNamespace },
    spec: {
      podSelector: { matchLabels: labels },
      policyTypes: ["Ingress", "Egress"],
      ingress: [],
      egress: [
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
              },
              podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
            },
          ],
          ports: [
            { protocol: "UDP", port: 53 },
            { protocol: "TCP", port: 53 },
          ],
        },
        {
          to: [{ ipBlock: { cidr: `${databaseAddress}/32` } }],
          ports: [{ protocol: "TCP", port: 5432 }],
        },
        {
          to: [{ ipBlock: { cidr: `${kubernetesAddress}/32` } }],
          ports: [{ protocol: "TCP", port: kubernetesPort }],
        },
      ],
    },
  };
  // Use the production worker entrypoint inside the same network as its private
  // Gateway route, with the worker's own identity and only its required mounts.
  const workerName = "openclaw-enterprise-worker";
  const workerLabels = { ...labels, "app.kubernetes.io/component": "worker" };
  const workerVolumes = ["installation", "gateway-api-key", "gateway-ca"];
  const workerDeployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: workerName, namespace: platformNamespace },
    spec: {
      replicas: 1,
      selector: { matchLabels: workerLabels },
      template: {
        metadata: { labels: workerLabels },
        spec: {
          serviceAccountName: controller.account,
          automountServiceAccountToken: true,
          securityContext: apiPodSpec.securityContext,
          containers: [
            {
              name: "worker",
              image: controllerImage,
              imagePullPolicy: "IfNotPresent",
              args: ["apps/controller/src/worker.mjs"],
              securityContext: apiContainer.securityContext,
              resources: apiContainer.resources,
              env: [
                ...apiContainer.env.filter(({ name }) =>
                  [
                    "NODE_ENV",
                    "OCC_CONFIG_PATH",
                    "OCC_DATABASE_URL",
                    "OCC_GATEWAY_API_KEY_PATH",
                    "NODE_EXTRA_CA_CERTS",
                  ].includes(name),
                ),
                { name: "OCC_WORKER_READINESS_PATH", value: "/var/run/openclaw/ready" },
                { name: "OCC_WORKER_LIVENESS_PATH", value: "/var/run/openclaw/alive" },
                {
                  name: "OCC_WORKER_POLL_INTERVAL_MS",
                  value: String(workerOptions.pollIntervalMs),
                },
                {
                  name: "OCC_WORKER_LEASE_DURATION_MS",
                  value: String(workerOptions.leaseDurationMs),
                },
                { name: "OCC_WORKER_MAX_ATTEMPTS", value: String(workerOptions.maxAttempts) },
                {
                  name: "OCC_WORKER_CONVERGENCE_TIMEOUT_MS",
                  value: String(workerOptions.convergenceTimeoutMs),
                },
              ],
              volumeMounts: [
                ...apiContainer.volumeMounts.filter(({ name }) => workerVolumes.includes(name)),
                { name: "worker-readiness", mountPath: "/var/run/openclaw" },
              ],
              readinessProbe: {
                exec: {
                  command: ["node", "scripts/production-healthcheck.mjs", "worker", "ready"],
                },
              },
              livenessProbe: {
                exec: { command: ["node", "scripts/production-healthcheck.mjs", "worker"] },
              },
            },
          ],
          volumes: [
            ...apiPodSpec.volumes.filter(({ name }) => workerVolumes.includes(name)),
            { name: "worker-readiness", emptyDir: { medium: "Memory", sizeLimit: "1Mi" } },
          ],
        },
      },
    },
  };
  const workerIsolation = structuredClone(apiIsolation);
  workerIsolation.metadata.name = `${workerName}-isolation`;
  workerIsolation.spec.podSelector.matchLabels = workerLabels;

  return {
    manifests: {
      apiVersion: "v1",
      kind: "List",
      items: [...resources, apiDeployment, apiIsolation, workerDeployment, workerIsolation],
    },
    apiPodSpec,
    apiContainer,
    workerName,
    workerLabels,
  };
}
