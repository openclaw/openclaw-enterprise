import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import type { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type {
  HarnessWorkloadRequirements,
  SandboxEnvironmentVariable,
  SandboxNamespaceContext,
  SandboxWorkloadIdentity,
  SandboxWorkspaceMount,
} from "../../packages/contracts/src/index.ts";
import type { WorkspaceNodeSetupEnvelope } from "../../packages/utils/src/index.ts";
import {
  codexAppServerEnvironment,
  codexManagedRuntimeFiles,
  defaultCodexConfig,
  defaultCodexRuntimeManifest,
} from "./sandbox-driver-codex-workload-fixture.ts";
import type { SandboxFixtureRevision } from "./sandbox-driver-revision-fixture.ts";
import {
  workspaceNodeSetupSecret,
  workspaceNodeSetupSecretData,
  type WorkspaceNodeSecretReference,
} from "./sandbox-driver-workspace-node-setup-fixture.ts";

type KubernetesSdk = Awaited<ReturnType<typeof createKubernetesClientConfiguration>>["sdk"];
type KubernetesApi = InstanceType<KubernetesSdk["KubernetesObjectApi"]>;
type KubernetesObject = Parameters<KubernetesApi["create"]>[0];
type SetupReader = { read: (resource: WorkspaceNodeSecretReference) => Promise<KubernetesObject> };
type NativePreparationClient = SetupReader & {
  create: (resource: KubernetesObject) => Promise<unknown>;
  delete: (...args: Parameters<KubernetesApi["delete"]>) => Promise<void>;
  list: (...args: Parameters<KubernetesApi["list"]>) => Promise<{ items: KubernetesObject[] }>;
};
type NamespaceContext = Omit<SandboxNamespaceContext, "kubernetes"> & { kubernetes: object };
type RuntimeOptions = {
  harnessId?: string;
  runtimeManifest?: string;
  codexConfig?: string;
  files?: HarnessWorkloadRequirements["files"];
  nodeSetupUrl?: (revision: SandboxFixtureRevision, context: NamespaceContext) => string;
};
type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
type MutableWorkloadRequirements = Omit<
  Mutable<HarnessWorkloadRequirements>,
  "command" | "workspaceMounts" | "credentialAttachments" | "environment"
> & {
  command: string[];
  workspaceMounts: SandboxWorkspaceMount[];
  credentialAttachments: HarnessWorkloadRequirements["credentialAttachments"][number][];
  environment: Mutable<SandboxEnvironmentVariable>[];
};

type RuntimeFixture<Client extends SetupReader = SetupReader> = {
  context: Omit<NamespaceContext, "kubernetes"> & { kubernetes: Client };
  revision: SandboxFixtureRevision;
  requirements: MutableWorkloadRequirements;
  runtimeManifest: string;
  codexConfig: string;
  nodeSetup: WorkspaceNodeSetupEnvelope & { tlsFingerprint: string };
  prepared: readonly KubernetesObject[];
};

type WorkloadFixtureDependencies = {
  kubernetesPrototype: KubernetesApi;
  harnessRuntimeCommand: (program: string) => string[];
  namespaceContext: () => NamespaceContext;
  prepareNative: (client: SetupReader) => {
    client: NativePreparationClient;
    prepared: readonly KubernetesObject[];
  };
};

function codexWorkspaceMount(): SandboxWorkspaceMount {
  return {
    claimName: "harness-workspace-codex",
    subPath: "workspace",
    mountPath: "/home/node/workspace",
    readOnly: false,
  };
}

export function createSandboxDriverWorkloadFixtures({
  kubernetesPrototype,
  harnessRuntimeCommand,
  namespaceContext,
  prepareNative,
}: WorkloadFixtureDependencies) {
  function codexRequirements(
    revision: Pick<SandboxFixtureRevision, "id">,
    environment: readonly SandboxEnvironmentVariable[] = [],
  ): MutableWorkloadRequirements & {
    serviceAccountName: string;
    serviceAccountToken: SandboxWorkloadIdentity["token"];
  } {
    return {
      loginMode: "api_key",
      image: "codex-runtime@sha256:synthetic",
      command: harnessRuntimeCommand('console.error("codex runtime");'),
      serviceAccountName: "agent-codex",
      serviceAccountToken: {
        audience: "openclaw-enterprise",
        expirationSeconds: 900,
        mountPath: "/var/run/secrets/openclaw-enterprise",
        path: "token",
        readOnly: true,
      },
      workspaceMounts: [codexWorkspaceMount()],
      credentialAttachments: [],
      environment: [...codexAppServerEnvironment(), ...environment],
      files: codexManagedRuntimeFiles(),
      labels: { "openclaw.dev/revision": revision.id },
    };
  }

  function runtimeSandboxFixture(
    driver: Pick<OpenShellSandboxDriver, "id">,
    options: RuntimeOptions & { harnessId: "openclaw" },
  ): RuntimeFixture<NativePreparationClient>;
  function runtimeSandboxFixture(
    driver: Pick<OpenShellSandboxDriver, "id">,
    options?: RuntimeOptions,
  ): RuntimeFixture;
  function runtimeSandboxFixture(
    driver: Pick<OpenShellSandboxDriver, "id">,
    {
      harnessId = "codex",
      runtimeManifest = defaultCodexRuntimeManifest,
      codexConfig = defaultCodexConfig,
      files,
      nodeSetupUrl = () => "wss://gateway.example.test/node",
    }: RuntimeOptions = {},
  ): RuntimeFixture {
    const context = namespaceContext();
    const revision = {
      id: "rev_00000000-0000-4000-8000-000000000003",
      namespaceId: context.namespace.id,
      agentId: "agt_00000000-0000-4000-8000-000000000003",
      harness: {
        id: harnessId,
        version: "1.0.0",
        mode: "dedicated",
        overrides: {},
        configuration: {},
      },
      sandboxDriverId: driver.id,
    } satisfies SandboxFixtureRevision;
    const nodeSetup = {
      url: nodeSetupUrl(revision, context),
      bootstrapToken: "one-shot-node-setup",
      expiresAtMs: Date.now() + 600_000,
      tlsFingerprint: "ab".repeat(32),
    } satisfies WorkspaceNodeSetupEnvelope;
    const data = workspaceNodeSetupSecretData(nodeSetup);
    const reader: SetupReader = {
      read: async ({ metadata }) =>
        workspaceNodeSetupSecret(metadata, context.namespace.id, revision.agentId, data),
    };
    Object.setPrototypeOf(reader, kubernetesPrototype);
    context.kubernetes = reader;
    const requirements: MutableWorkloadRequirements = {
      loginMode: "api_key",
      image: "openclaw-runtime@sha256:synthetic",
      command: harnessRuntimeCommand('console.error("harness runtime");'),
      workspaceMounts: [
        codexWorkspaceMount(),
        {
          claimName: "harness-workspace-codex",
          subPath: "workspace-node-codex",
          mountPath: "/home/node/.openclaw-node",
          readOnly: false,
        },
        ...(harnessId === "codex"
          ? [
              {
                claimName: "harness-workspace-codex",
                subPath: "codex-sessions",
                mountPath: "/home/node/.codex/sessions",
                readOnly: false,
              },
            ]
          : []),
      ],
      credentialAttachments: [{ sourceId: "cs_test", ref: `oce-cs-${"b".repeat(24)}` }],
      environment: [
        { name: "HOME", value: "/home/node" },
        ...(harnessId === "codex" ? [{ name: "CODEX_HOME", value: "/home/node/.codex" }] : []),
        { name: "NODE_PATH", value: "/home/node_modules" },
        { name: "OPENCLAW_NODE_STATE_DIR", value: "/home/node/.openclaw-node" },
        { name: "OPENCLAW_WORKSPACE_DIR", value: "/home/node/workspace" },
        {
          name: "OPENCLAW_NODE_CA_PEM",
          value: "-----BEGIN CERTIFICATE-----\npublic-ca\n-----END CERTIFICATE-----\n",
        },
        ...(harnessId === "codex" ? codexAppServerEnvironment() : []),
        {
          name: "OPENCLAW_NODE_SETUP_CODE",
          valueFrom: { secretKeyRef: { name: "workspace-node", key: "setupCode" } },
        },
      ],
      files:
        files ??
        (harnessId === "codex" ? codexManagedRuntimeFiles(runtimeManifest, codexConfig) : []),
      labels: { "openclaw.dev/revision": revision.id },
    };
    const { client, prepared } =
      harnessId === "openclaw" ? prepareNative(reader) : { client: reader, prepared: [] };
    return {
      context: Object.assign(context, { kubernetes: client }),
      revision,
      requirements,
      runtimeManifest,
      codexConfig,
      nodeSetup,
      prepared,
    };
  }
  return { codexRequirements, runtimeSandboxFixture };
}
