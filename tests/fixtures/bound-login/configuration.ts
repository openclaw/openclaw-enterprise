import { createKubernetesInstallationConfiguration } from "../../helpers/kubernetes-real.mjs";
import { createCredentialProxyInstallationConfiguration } from "../../helpers/installation-driver-configuration.mjs";

type Driver = { id: string; configuration: Record<string, unknown> };
type GatewayRouting = { gatewayName: string; gatewayNamespace: string; envoyNamespace: string };
interface InstallationFixtureConfiguration {
  occ: { cluster: string };
  backend?: CredentialProfile["backend"];
  drivers: Record<string, Driver> & {
    compute: Driver & {
      configuration: {
        network: { gatewayClients?: unknown; [key: string]: unknown };
        gatewayRouting?: GatewayRouting;
        [key: string]: unknown;
      };
    };
  };
}
interface CredentialProfile {
  backend: {
    id: string;
    type: string;
    configuration: Record<string, unknown>;
    drivers: Record<string, string>;
  }[];
  drivers: {
    sandbox: Driver & {
      configuration: { gateway: Record<string, unknown>; kubernetes: Record<string, unknown> };
    };
    credential_gateway: Driver;
    credential_proxy: Driver & { configuration: { authority: Record<string, unknown> } };
  };
}

export function createInitialInstallationConfiguration(input: {
  system: string;
  gatewayName: string;
  envoyNamespace: string;
  runtimeImage: string;
  cluster: string;
}) {
  const configuration: InstallationFixtureConfiguration = createKubernetesInstallationConfiguration(
    {
      authentication: { mode: "inCluster" },
      platformNamespace: input.system,
      gatewayImage: input.runtimeImage,
      codexImage: input.runtimeImage,
      cluster: input.cluster,
      codexSeccompProfile: undefined,
    },
  );
  delete configuration.drivers.compute.configuration.network.gatewayClients;
  configuration.drivers.compute.configuration.gatewayRouting = {
    gatewayName: input.gatewayName,
    gatewayNamespace: input.system,
    envoyNamespace: input.envoyNamespace,
  };
  return configuration;
}

export function bindInstallationConfiguration(
  configuration: ReturnType<typeof createInitialInstallationConfiguration>,
  input: {
    tenant: string;
    shellName: string;
    runtimeClass: string;
    issuerKid: string;
  },
): void {
  // The JavaScript helper adds these drivers after creating its initial object.
  const configured =
    createCredentialProxyInstallationConfiguration() as unknown as CredentialProfile;
  configuration.backend = configured.backend;
  configuration.backend[0]!.configuration = {
    endpoint: `https://${input.shellName}.${input.tenant}.svc:8080`,
    rootCertificatePath: "/bound-openshell/ca.crt",
    auth: {
      mode: "mtls",
      certificatePath: "/bound-openshell/tls.crt",
      privateKeyPath: "/bound-openshell/tls.key",
    },
  };
  for (const capability of ["sandbox", "credential_gateway", "credential_proxy"] as const) {
    configuration.drivers[capability] = configured.drivers[capability];
  }
  configured.drivers.sandbox.configuration.gateway.readiness = {
    serviceName: input.shellName,
    podSelector: { "app.kubernetes.io/instance": input.shellName },
    timeoutMs: 120000,
  };
  configured.drivers.sandbox.configuration.kubernetes.runtimeClassName = input.runtimeClass;
  configured.drivers.credential_proxy.configuration.authority.host = "0.0.0.0";
  configured.drivers.credential_proxy.configuration.authority.keyId = input.issuerKid;
}
