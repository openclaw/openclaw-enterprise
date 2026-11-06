import type { OpenShellBackendDefinition } from "@openclaw-enterprise/contracts";
import {
  closed,
  nonempty,
  object,
  egressAuthorityConfiguration,
  InstallationFieldError,
  type InstallationFieldDetail,
} from "../../composition/installation-fields.ts";
import { preparedGitHubConfiguration } from "../repo/github/credentials/prepared-configuration.ts";
import type { OpenShellGitRuntimeConfiguration } from "./openshell-git-runtime.ts";

/** Existing Helm listener and mounted files for the OpenShell Git adapter. */
export const openShellGitChartListener = {
  path: "repository.openShell.authority",
  chart: "openshellGit",
  variable: "OCC_OPENSHELL_GIT_PORT",
  files: {
    certificatePath: ["/etc/openclaw/openshell-git/tls.crt", "openshellGit.tlsSecretName"],
    privateKeyPath: ["/etc/openclaw/openshell-git/tls.key", "openshellGit.tlsSecretName"],
    issuerPublicKeyPath: [
      "/etc/openclaw/openshell-git/gateway-public.pem",
      "openshellGit.issuerPublicKeyConfigMapName",
    ],
  },
} as const;

export function openShellRepositoryConfiguration(
  input: unknown,
  mode: "development" | "production",
) {
  if (input === undefined) {
    return undefined;
  }
  const value = object(input, "repository.openShell");
  closed(value, ["registrationName", "authority"], "repository.openShell");
  return {
    registrationName: nonempty(value.registrationName, "repository.openShell.registrationName"),
    authority: egressAuthorityConfiguration(
      value.authority,
      mode,
      "repository.openShell.authority",
    ),
  };
}

/** The adapter selects its discovery profile from its own repository transport configuration. */
export function openShellProxyConfiguration(
  input: unknown,
  mode: "development" | "production",
  repository: OpenShellGitRuntimeConfiguration | undefined,
) {
  const egress = object(input, "drivers.credential_proxy.configuration");
  if (repository) {
    closed(egress, ["observedHookPreviewWorkspace"], "drivers.credential_proxy.configuration");
    const preview =
      egress.observedHookPreviewWorkspace === undefined
        ? {}
        : {
            observedHookPreviewWorkspace: nonempty(
              egress.observedHookPreviewWorkspace,
              "observedHookPreviewWorkspace",
            ),
          };
    return {
      repository: { ...repository, ...preview },
      policy: {
        middlewareName: repository.registrationName,
        repositoryMiddlewareName: repository.registrationName,
        authorityScope: "execution",
        ...preview,
      },
    };
  }
  closed(
    egress,
    ["middlewareName", "authorityScope", "authority", "preparedGitHub"],
    "drivers.credential_proxy.configuration",
  );
  const { authority, preparedGitHub, ...policy } = egress;
  return {
    policy,
    authority: egressAuthorityConfiguration(
      authority,
      mode,
      "drivers.credential_proxy.configuration.authority",
    ),
    prepared:
      preparedGitHub === undefined ? undefined : preparedGitHubConfiguration(preparedGitHub, false),
  };
}

function isHttpsEndpoint(endpoint: string | undefined): boolean {
  return endpoint?.startsWith("https://") === true;
}

function isGatewayAuthMode(mode: string | undefined, preview = false): boolean {
  return mode === "mtls" || (!preview && mode === "bearerTokenFile");
}

export function isOpenShellGatewayEligible(
  backend: OpenShellBackendDefinition | undefined,
): boolean {
  return (
    isHttpsEndpoint(backend?.configuration.endpoint) &&
    isGatewayAuthMode(backend?.configuration.auth?.mode)
  );
}

/**
 * `repository.openShell` needs prepared custody, the bundled Kubernetes/OpenShell pair and an
 * authenticated HTTPS gateway. Each unmet requirement names its own field and never echoes a
 * value, so startup logs and the chart's upgrade check say which key to fix (finding 2216).
 */
export function validateOpenShellRepositoryTransport(
  configuration: OpenShellGitRuntimeConfiguration | undefined,
  input: {
    prepared: boolean;
    repository: boolean;
    backend: OpenShellBackendDefinition | undefined;
    /** The OpenShell Backend's position in `backend`, for its field pointers. */
    backendIndex: number;
    sandbox: boolean;
    external: boolean;
    kubernetes: boolean;
  },
): void {
  if (!configuration) {
    return;
  }
  const details: InstallationFieldDetail[] = [];
  const refuse = (path: string, code: InstallationFieldDetail["code"], message: string) =>
    details.push({ path, code, message: `repository.openShell requires ${message}.` });
  if (!input.prepared) {
    refuse("/repository/preparedGitHub", "REQUIRED", "repository.preparedGitHub");
  }
  if (!input.repository) {
    refuse("/backend", "REQUIRED", "a backend entry with type github");
  }
  if (!input.sandbox) {
    refuse("/drivers/sandbox", "REQUIRED", "the bundled OpenShell drivers.sandbox");
  } else if (input.external) {
    refuse(
      "/drivers/sandbox/package",
      "INVALID_VALUE",
      "the bundled OpenShell drivers.sandbox, not an installed package",
    );
  }
  if (!input.kubernetes) {
    refuse("/drivers/compute", "INVALID_VALUE", "the bundled Kubernetes Compute Driver");
  }
  const { backend } = input;
  if (!backend) {
    refuse("/backend", "REQUIRED", "a backend entry with type openshell");
  } else {
    const field = `/backend/${input.backendIndex}/configuration`;
    const { endpoint, auth } = backend.configuration;
    if (!isHttpsEndpoint(endpoint)) {
      refuse(
        `${field}/endpoint`,
        endpoint === undefined ? "REQUIRED" : "INVALID_VALUE",
        endpoint === undefined
          ? "the openshell backend configuration.endpoint, an https:// URL, rather than serviceName and port"
          : "the openshell backend configuration.endpoint to be an https:// URL",
      );
    }
    if (!isGatewayAuthMode(auth?.mode, !!configuration.observedHookPreviewWorkspace)) {
      refuse(
        `${field}/auth${auth === undefined ? "" : "/mode"}`,
        auth === undefined ? "REQUIRED" : "INVALID_VALUE",
        configuration.observedHookPreviewWorkspace
          ? "the openshell backend configuration.auth.mode to be mtls with observedHookPreviewWorkspace"
          : "the openshell backend configuration.auth.mode to be bearerTokenFile or mtls",
      );
    }
  }
  if (details.length > 0) {
    throw new InstallationFieldError(
      details as [InstallationFieldDetail, ...InstallationFieldDetail[]],
    );
  }
}
