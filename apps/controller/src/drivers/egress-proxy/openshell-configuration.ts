import type { OpenShellBackendDefinition } from "@openclaw-enterprise/contracts";
import {
  closed,
  nonempty,
  object,
  egressAuthorityConfiguration,
} from "../../composition/installation-fields.ts";
import { preparedGitHubConfiguration } from "../repo/github/credentials/prepared-configuration.ts";
import type { OpenShellGitRuntimeConfiguration } from "./openshell-git-runtime.ts";

export { openShellRepositoryConfiguration } from "../../composition/installation-fields.ts";

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
    authority: egressAuthorityConfiguration(authority, mode),
    prepared:
      preparedGitHub === undefined ? undefined : preparedGitHubConfiguration(preparedGitHub, false),
  };
}

export function validateOpenShellRepositoryTransport(
  configuration: OpenShellGitRuntimeConfiguration | undefined,
  input: {
    prepared: boolean;
    repository: boolean;
    backend: OpenShellBackendDefinition | undefined;
    sandbox: boolean;
    external: boolean;
    kubernetes: boolean;
  },
): void {
  if (
    configuration &&
    (!input.prepared ||
      !input.repository ||
      !input.backend ||
      !input.sandbox ||
      input.external ||
      !input.kubernetes ||
      input.backend.configuration.endpoint?.startsWith("https://") !== true ||
      (configuration.observedHookPreviewWorkspace
        ? input.backend.configuration.auth?.mode !== "mtls"
        : !["bearerTokenFile", "mtls"].includes(input.backend.configuration.auth?.mode ?? "")))
  ) {
    throw new Error(
      "OpenShell Git requires prepared GitHub custody, the bundled Kubernetes/OpenShell pair and an authenticated HTTPS gateway.",
    );
  }
}
