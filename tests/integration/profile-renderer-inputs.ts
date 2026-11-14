type InputRecord = Record<string, unknown>;

// Operator JSON may contain malformed settings. Only the sections that fixture
// builders merge or mutate need an object type here.
interface SiteOverrides extends InputRecord {
  controlPlane?: InputRecord;
  runtime?: InputRecord;
  channels?: InputRecord;
  codex?: InputRecord;
  repository?: InputRecord;
}

interface SiteInput extends SiteOverrides {
  controlPlane: InputRecord;
  runtime: InputRecord;
  channels: InputRecord;
}

export const digestA = "a".repeat(64);
export const digestB = "b".repeat(64);
export const digestC = "c".repeat(64);
export const digestD = "d".repeat(64);

export function baseInput(overrides: SiteOverrides = {}): SiteInput {
  return {
    controlPlane: {
      releaseName: "oce",
      namespace: "openclaw-system",
      clusterName: "profile-qualification",
      controllerImage: `registry.example.invalid/openclaw-enterprise/controller@sha256:${digestA}`,
      authBaseUrl: "https://console.oce.example.internal",
      adminEmail: "admin@example.invalid",
      bootstrapPasswordClaimName: "occ-bootstrap-admin-password",
      apiClients: [{ namespace: "operator-tools", podLabels: { app: "occ-operator" } }],
      databaseCidrs: ["192.0.2.10/32"],
      clusterCidrs: ["192.0.2.11/32"],
      dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
      gatewayClassName: "eg",
      gatewayApiKeySecretName: "occ-private-gateway-key",
      agentNativeAdminDomain: "agents.oce.example.internal",
      gatewayTrustedProxyCidrs: ["192.0.2.12/32"],
      pluginStatusProxySourceCidrs: ["192.0.2.13/32"],
      nodeSelector: { "oce-role": "control" },
      metrics: {
        scraperNamespaceLabels: { name: "monitoring" },
        scraperPodLabels: { app: "prometheus" },
      },
    },
    runtime: {
      image: `registry.example.invalid/openclaw-enterprise/runtime@sha256:${digestB}`,
      gatewayStorageClassName: "occ-gateway-rwo",
      nodeSelector: { "oce-role": "agents" },
      gatewayNodeSelector: { "oce-role": "control" },
      transportSecretPrefix: "openclaw-agent-transport",
    },
    channels: {
      managedSlackProxy: true,
    },
    ...overrides,
  };
}

export function codexInput(overrides: SiteOverrides = {}): SiteInput {
  const input = baseInput();
  return {
    ...input,
    ...overrides,
    runtime: {
      ...input.runtime,
      codexSeccompProfile: "profiles/codex.json",
      ...(overrides.runtime ?? {}),
    },
    codex: {
      modelDiscoveryCidrs: ["192.0.2.20/32"],
      ...(overrides.codex ?? {}),
    },
  };
}

export function managedCodexInput(overrides: SiteOverrides = {}): SiteInput {
  return codexInput({
    ...overrides,
    codex: {
      managedServiceAccounts: {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        adminSecretName: "occ-chatgpt-admin",
        adminSecretKey: "admin-key",
        providerCidr: "192.0.2.21/32",
      },
      ...(overrides.codex ?? {}),
    },
  });
}

export function repositoryConfiguration(upstreamCidrs: string[] = ["192.0.2.30/32"]) {
  return {
    enabled: true,
    authority: "prepared-git",
    preparedCustodySecretName: "occ-repository-custody",
    image: `registry.example.invalid/openclaw-enterprise/repository-credentials@sha256:${digestC}`,
    backendId: "github-primary",
    registryConfigMapName: "occ-repository-registry-v1",
    serviceConfigSecretName: "occ-repository-service-config",
    appKeySecretName: "occ-repository-app-key",
    tlsSecretName: "occ-repository-tls",
    publicCaSecretName: "occ-repository-public-ca",
    upstreamCidrs,
  };
}

export function withGoogleSignIn(input: SiteInput, google: InputRecord): SiteInput {
  const controlPlane = input.controlPlane;
  return {
    ...input,
    controlPlane: { ...controlPlane, recoveryUserId: "recovery-admin_1", google },
  };
}

export function externalSignInInput(signIn: InputRecord = {}) {
  const controlPlane = baseInput().controlPlane;
  return baseInput({
    controlPlane: {
      ...controlPlane,
      recoveryUserId: "recovery-admin_1",
      google: { egressCidrs: ["140.82.112.0/20"] },
      ...signIn,
    },
  });
}
