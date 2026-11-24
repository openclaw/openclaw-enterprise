import type { SecretReference } from "../../packages/contracts/src/index.ts";

export type Kubectl = (...args: string[]) => Promise<string>;
export type Checkpoint = (
  phase: string,
  details?: object,
  privateDetails?: object,
) => Promise<void>;
export type ConnectedApi = (method: string, path: string, body?: unknown) => Promise<unknown>;

export type UpgradeSetup = {
  input: {
    controllerNamespace: string;
    controllerSelector: string;
    openShellGatewayNamespace: string;
    openShellGatewaySelector: string;
    oceCommit: string;
    images: { controller: string };
    controllerUpgrade: { fromCommit: string; fromImage: string; timeoutMs: number };
  };
  controller: { providerOrigin: string };
  f: { kubectl: Kubectl };
};

type QueryPool = {
  query(sql: string, parameters: string[]): Promise<{ rows: readonly Record<string, unknown>[] }>;
};

export type UpgradeStack = {
  pool: QueryPool;
  namespace: { id: string };
  namespacePath: string;
  installation: { id: string };
  supplierPods: readonly unknown[];
};

export type UpgradeDeployment = {
  agent: { id: string };
  revision: { id: string };
  secret: { ref: SecretReference };
};

export type UpgradeEvidence = {
  api: ConnectedApi;
  runId: string;
  credentials: { initial: string };
  checkpoint: Checkpoint;
};

type ResourceOwnership = {
  pendingCreate?: { kind: string; name?: string | undefined };
  pendingDeploy?: { agentId: string; path: string };
  resources: { kind: string; id: string; name?: string | undefined }[];
};

export type ConnectedApiOperation = {
  operationId: string;
  method: string;
  phase: string;
  outcome: string;
  status: number | null;
  code: string | null;
  requestId: string | null;
};

export type ConnectedEvidenceLedger = ResourceOwnership & {
  runId: string;
  startedAt: string;
  oceCommit?: string | undefined;
  harnessCommit?: string | undefined;
  supplierCommit?: string | undefined;
  images: Partial<ConnectedStackInputs["images"]>;
  controllerUpgrade?: ConnectedStackInputs["controllerUpgrade"];
  namespaceId?: string | undefined;
  apiOperations: ConnectedApiOperation[];
  lastApi?: ConnectedApiOperation;
  phases: { phase: string; at: string; [field: string]: unknown }[];
  failure?: Parameters<
    NonNullable<Parameters<typeof import("./egress-connected-failure.ts").safeConnectedFailure>[2]>
  >[0];
  gatewayExecTarget?: { phase: string; outcome: string };
  cleanup: "pending" | "complete" | "incomplete";
};

export type RetirementEvidence = UpgradeEvidence & {
  ledger: ResourceOwnership;
  request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body?: unknown }>;
};

export type ProviderCounters = {
  observations: readonly unknown[];
  tcpConnections: number;
};

export type UpgradeResources = {
  create(kind: "secrets" | "credential-sources", body: unknown): Promise<unknown>;
  provider: ProviderCounters;
};

/** Manifest fields used to observe an already installed connected stack. */
export type ConnectedStackInputs = {
  apiOrigin: string;
  namespaceId: string;
  model: string;
  kubeconfigPath: string;
  kubernetesContext: string;
  controllerNamespace: string;
  controllerSelector: unknown;
  openShellGatewayNamespace: string;
  openShellGatewaySelector: unknown;
  oceCommit: string;
  harnessCommit: string;
  supplierCommit: string;
  images: Record<
    "agent" | "controller" | "gateway" | "openShellGateway" | "sandbox" | "supervisor",
    string
  >;
  provider: {
    origin: string;
    bindHost: string;
    bindPort: number;
    certificatePath: string;
    privateKeyPath: string;
  };
  openShellBackend: {
    endpoint: string;
    rootCertificatePath: string;
    auth:
      | { mode: "bearerTokenFile"; path: string }
      | { mode: "mtls"; certificatePath: string; privateKeyPath: string };
  };
  authorityProfile?: "fresh-whole-execution";
  credentialConnector?: {
    path: string;
    image: string;
    sha256: string;
    verification: "operator-verified-image-executable";
  };
  controllerUpgrade?: UpgradeSetup["input"]["controllerUpgrade"];
};
