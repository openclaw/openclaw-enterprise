import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { goToolEnvironment, renderProductionChart } from "./production-chart.mjs";

export type ChartValues = Readonly<Record<string, string | number | boolean>>;

export type ChartRenderOptions = {
  release?: string;
  namespace?: string;
  isUpgrade?: boolean;
  valuesFiles?: readonly string[];
  omit?: readonly string[];
  strings?: ChartValues;
};

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const helm = process.env.OCC_HELM_BIN ?? "helm";

export const repositoryCredentialValues = {
  "repositoryCredentials.authority": "prepared-git",
  "repositoryCredentials.preparedCustodySecretName": "repository-custody",
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

export const protectedRepositoryValues = {
  "repositoryCredentials.enabled": "false",
  "repositoryCredentials.registryConfigMapName": "repository-registry-v1",
  "repositoryCredentials.appKeySecretName": "repository-app-key",
  "repositoryCredentials.upstreamCidrs[0]": "198.51.100.23/32",
  "repositoryCredentials.preparedProviderCaConfigMapName": "git-provider-ca",
  "repositoryCredentials.authority": "prepared-git",
  "repositoryCredentials.preparedCustodySecretName": "git-custody",
};

export const gatewayRoutingValues = {
  "gatewayRouting.enabled": "true",
  "gatewayRouting.gatewayClassName": "private-envoy-gateway",
  "gatewayRouting.apiKeySecretName": "occ-gateway-api-key",
};

export const gatewaySandboxValues = {
  ...gatewayRoutingValues,
  "gatewayRouting.sandbox.enabled": "true",
  "gatewayRouting.sandbox.domain": "previews.example.test",
  "gatewayRouting.sandbox.tlsSecretName": "preview-wildcard",
  "gatewayRouting.sandbox.ingressPeers[0].namespaceSelector.matchLabels.kubernetes\\.io/metadata\\.name":
    "public-ingress",
};

export const stringNameMessage =
  "must be a string: quote a value YAML reads as a number or boolean, or pass it with --set-string";

export const render = (
  overrides: ChartValues = {},
  options: ChartRenderOptions = {},
): Promise<{ stdout: string; stderr: string }> =>
  renderProductionChart(
    {
      "database.cidrs[1]": "10.45.0.13/32",
      "cluster.cidrs[1]": "10.43.0.2/32",
      ...overrides,
    },
    options,
  );

async function checkChartTooling(): Promise<{ skip: boolean | string }> {
  try {
    await execute(helm, ["version", "--short"], { cwd: repository, env: goToolEnvironment() });
    await execute("yq", ["--version"], { cwd: repository });
    return { skip: false };
  } catch {
    return {
      skip: "Install Helm and yq, or set OCC_HELM_BIN, to verify the real rendered production chart.",
    };
  }
}

export const tooling = await checkChartTooling();
