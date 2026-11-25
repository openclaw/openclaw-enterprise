import { execFile } from "node:child_process";
import { promisify } from "node:util";

type GatewayRoutingValues = {
  releaseName: string;
  releaseNamespace: string;
  envoyNamespace: string;
  issuerName: string;
  apiKeySecretName: string;
  gatewayClassName: string;
  hostname: string;
  sandbox?:
    | {
        enabled: boolean;
        domain: string;
        tlsSecretName: string;
        listenerPort: number;
        ingressPeers: readonly {
          namespaceSelector: { matchLabels: Readonly<Record<string, string>> };
          podSelector: { matchLabels: Readonly<Record<string, string>> };
        }[];
      }
    | undefined;
};

const executeFile = promisify(execFile);
const helmBin = process.env.OCC_HELM_BIN ?? "helm";
const helmEnvironment = {
  ...process.env,
  HELM_CACHE_HOME: process.env.HELM_CACHE_HOME ?? "/tmp/oce-helm-cache",
  HELM_CONFIG_HOME: process.env.HELM_CONFIG_HOME ?? "/tmp/oce-helm-config",
  HELM_DATA_HOME: process.env.HELM_DATA_HOME ?? "/tmp/oce-helm-data",
};

export async function renderGatewayRoutingManifests({
  releaseName,
  releaseNamespace,
  envoyNamespace,
  issuerName,
  apiKeySecretName,
  gatewayClassName,
  hostname,
  sandbox,
}: GatewayRoutingValues): Promise<string> {
  const args = [
    "template",
    releaseName,
    "deploy/helm/openclaw-enterprise",
    "--namespace",
    releaseNamespace,
    "--values",
    "deploy/examples/production/values.yaml",
    // The disposable fixture has one node; production role isolation is verified separately.
    "--set-json",
    'controlPlane.nodeSelector={"kubernetes.io/os":"linux"}',
    "--show-only",
    "templates/gateway-routing.yaml",
    "--set",
    "gatewayRouting.enabled=true",
    "--set",
    `gatewayRouting.gatewayClassName=${gatewayClassName}`,
    "--set",
    `gatewayRouting.envoyNamespace=${envoyNamespace}`,
    "--set",
    `gatewayRouting.hostname=${hostname}`,
    "--set",
    `gatewayRouting.apiKeySecretName=${apiKeySecretName}`,
    "--set",
    `gatewayRouting.issuerRef.name=${issuerName}`,
    "--set",
    "gatewayRouting.issuerRef.kind=Issuer",
    "--set",
    "gatewayRouting.issuerRef.group=cert-manager.io",
    ...(sandbox === undefined
      ? []
      : ["--set-json", `gatewayRouting.sandbox=${JSON.stringify(sandbox)}`]),
  ];
  try {
    const { stdout } = await executeFile(helmBin, args, {
      env: helmEnvironment,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const failure = error instanceof Error ? error : {};
    const code = "code" in failure ? failure.code : undefined;
    const stdout = "stdout" in failure ? failure.stdout : undefined;
    const stderr = "stderr" in failure ? failure.stderr : undefined;
    throw new Error(
      `${helmBin} ${args.join(" ")} failed with exit ${String(code ?? "unknown")}.\n${String(stdout ?? "")}${String(stderr ?? "")}`,
      { cause: error },
    );
  }
}

export function registerRenderedExternalCleanup(
  context: { after(cleanup: () => Promise<void>): void },
  manifests: string,
  releaseNamespace: string,
  { kubectl }: { kubectl(...args: string[]): Promise<unknown> },
): void {
  for (const object of renderedNamespacedObjects(manifests)) {
    if (object.kind !== "NetworkPolicy" || object.namespace === releaseNamespace) {
      continue;
    }
    context.after(async () => {
      await kubectl(
        "delete",
        "networkpolicy",
        object.name,
        "--namespace",
        object.namespace,
        "--ignore-not-found=true",
      );
    });
  }
}

function renderedNamespacedObjects(manifests: string) {
  return manifests
    .split(/^---$/mu)
    .map((document) => {
      const kind = /^kind:\s*(\S+)\s*$/mu.exec(document)?.[1];
      const metadataStart = document.search(/^metadata:\s*$/mu);
      if (kind === undefined || metadataStart < 0) {
        return undefined;
      }
      const metadata = document.slice(metadataStart);
      const name = /^ {2}name:\s*(\S+)\s*$/mu.exec(metadata)?.[1];
      const namespace = /^ {2}namespace:\s*(\S+)\s*$/mu.exec(metadata)?.[1];
      return name === undefined || namespace === undefined
        ? undefined
        : { kind, name: unquoteYaml(name), namespace: unquoteYaml(namespace) };
    })
    .filter((object) => object !== undefined);
}

function unquoteYaml(value: string) {
  return value.replace(/^"|"$/g, "");
}
