import { validateConfiguration } from "@openclaw-enterprise/contracts";
import { installedDriverReference, validateBackendDefinitions } from "@openclaw-enterprise/occ";
import { fileURLToPath } from "node:url";
import { resolveDriverPackage } from "../driver-package-resolution.ts";
import { externalProtectedDriverSelection } from "../external-protected-driver-selection.ts";
import { closed, nonempty, object } from "../installation-fields.ts";
import { startupConfiguration } from "../startup-file.ts";
import { selectRegisteredRepositoryGitCustody } from "./custody-selection.ts";
import {
  githubRepositoryAuthorityIdentity,
  githubRepositorySelection,
  selectGitHubRepositoryPolicy,
} from "./github-selection.ts";
import { loadRepositoryPolicyInputs } from "./policy.ts";

const unavailable = () => new Error("PREPARED_GIT_ISSUER_CONFIGURATION_INVALID");

/** Interpret just the remote GitHub route. The Worker owns external Driver validation and creation. */
export async function loadPreparedGitIssuerSelection(
  environment: Readonly<Record<string, string | undefined>>,
  packageRoot = fileURLToPath(new URL("../../../", import.meta.url)),
) {
  if (
    [
      "OCC_INSTALLATION_ID",
      "OCC_COMPUTE_DRIVER",
      "OCC_KUBERNETES_CONFIG_PATH",
      "OCC_NATIVE_IAM_DRIVER_ID",
      "OCC_PREPROVISIONED_NAMESPACE",
    ].some((name) => environment[name] !== undefined)
  ) {
    throw unavailable();
  }
  const { configuration } = await startupConfiguration({ mode: "production", environment }, true);
  const startup = object(configuration, "Installation startup configuration");
  const drivers = object(startup.drivers, "drivers");
  const compute = object(drivers.compute, "drivers.compute");
  if (
    drivers.repo !== undefined ||
    Object.hasOwn(compute, "package") ||
    compute.id === "compute-ssh"
  ) {
    throw unavailable();
  }

  const repository = githubRepositorySelection(startup.repository);
  if (
    !repository?.prepared ||
    !("issuerEndpoint" in repository.prepared) ||
    repository.nativeSender ||
    repository.openShell !== undefined
  ) {
    throw unavailable();
  }
  const selection = selectGitHubRepositoryPolicy(repository);
  const backends = validateBackendDefinitions(startup.backend ?? []);
  const backend = backends.find((item) => item.type === "github");
  if (
    !backend ||
    backend.drivers.repo !== selection.id ||
    backends.some((item) => item.type === "openshell")
  ) {
    throw unavailable();
  }

  const sandbox = object(drivers.sandbox, "drivers.sandbox");
  closed(sandbox, ["id", "package", "configuration"], "drivers.sandbox");
  const id = nonempty(sandbox.id, "drivers.sandbox.id");
  // Match the Worker's plain JSON input boundary without evaluating the package.
  const validated = validateConfiguration<ReturnType<typeof object>>(
    { type: "object", additionalProperties: true },
    sandbox.configuration,
  );
  if (!validated.success) {
    throw unavailable();
  }
  const configurationValues = validated.data;
  const proxy = object(drivers.credential_proxy, "drivers.credential_proxy");
  closed(proxy, ["id", "configuration", "requestCapacity"], "drivers.credential_proxy");
  closed(
    object(proxy.configuration, "drivers.credential_proxy.configuration"),
    [],
    "drivers.credential_proxy.configuration",
  );
  if (proxy.id !== id) {
    throw unavailable();
  }
  if (drivers.credential_gateway !== undefined || drivers.credential_refresh !== undefined) {
    throw unavailable();
  }

  const installed = await resolveDriverPackage(sandbox, "sandbox", packageRoot, false);
  if (!installed) {
    throw unavailable();
  }
  const { repositoryOwner, registry } = await loadRepositoryPolicyInputs({ backend, selection });
  // Match the Worker's complete installed registration reference, including its
  // configuration digest. Custody compares this reference with durable release
  // and material evidence; package metadata alone grants no repository use.
  const { openShell: _openShell, ...portable } = repository;
  const authorityIdentity = githubRepositoryAuthorityIdentity(selection, backend, registry, {
    ...portable,
    transport: undefined,
  });
  const driver = installedDriverReference(
    externalProtectedDriverSelection(
      { id, implementation: installed.implementation, configuration: configurationValues },
      authorityIdentity,
    ),
  );
  return {
    repositoryOwner,
    registry,
    repositoryGitCustody: selectRegisteredRepositoryGitCustody(driver),
  };
}
