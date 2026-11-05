import type { ModelProviderConfiguration } from "../compute/model-provider.ts";
import type {
  Backend,
  CredentialProxyDriver,
  CredentialProviderDefinition,
  SandboxDriver,
} from "@openclaw-enterprise/contracts";
import type { OpenShellGateway } from "../../backends/openshell.ts";
import type { EgressAuthorityConfiguration } from "../../composition/egress-authority.ts";
import type { RepositoryTransportBinding } from "../../composition/repository-credentials/contracts.ts";
import type { RepositoryGitDeliveryResolver } from "../repo/credentials/delivery.ts";
import type { OpenShellSandboxDriverSelection } from "../sandbox/openshell.ts";
import { OpenShellCredentialProxyDriver, type OpenShellProxyOptions } from "./openshell.ts";
import {
  OpenShellGitRuntime,
  type OpenShellGitRuntimeConfiguration,
} from "./openshell-git-runtime.ts";

/** The installed OpenShell Driver owns its transport. Composition receives capability
 * views and one worker binding, not a separately managed Git lifecycle coordinator. */
export function createOpenShellCapabilities(input: {
  readonly sandbox: {
    readonly id: string;
    readonly implementation: string;
    readonly configuration: Readonly<Record<string, unknown>>;
  };
  readonly createSandbox: (
    configuration: Readonly<Record<string, unknown>>,
    selection: OpenShellSandboxDriverSelection,
  ) => SandboxDriver;
  readonly backend: Backend<OpenShellGateway>;
  readonly operatorOwnedKubernetesResources: boolean;
  readonly repository?: {
    readonly configuration: OpenShellGitRuntimeConfiguration | undefined;
    readonly resolveDelivery: RepositoryGitDeliveryResolver | undefined;
  };
  readonly proxy?: {
    readonly modelProvider?: ModelProviderConfiguration;
    readonly id: string;
    readonly configuration: OpenShellProxyOptions;
    readonly exchangeAuthority?: EgressAuthorityConfiguration;
    readonly preparedProviders: readonly CredentialProviderDefinition[];
  };
}) {
  const configuration = input.repository?.configuration;
  const resolveDelivery = input.repository?.resolveDelivery;
  if (configuration && !resolveDelivery) {
    throw new Error("OpenShell Git requires its Repo delivery binding.");
  }
  if (configuration && !input.proxy) {
    throw new Error("OpenShell Git requires its protected credential proxy.");
  }
  const git =
    configuration &&
    resolveDelivery &&
    new OpenShellGitRuntime({ ...configuration }, resolveDelivery);
  const sandbox = input.createSandbox(
    { ...input.sandbox.configuration, ...(input.proxy && { egress: input.proxy.configuration }) },
    {
      id: input.sandbox.id,
      implementation: input.sandbox.implementation,
      backend: input.backend,
      operatorOwnedKubernetesResources: input.operatorOwnedKubernetesResources,
      ...(git && { openShellGit: git }),
    },
  );
  const proxy: CredentialProxyDriver | undefined =
    input.proxy &&
    new OpenShellCredentialProxyDriver(input.proxy.configuration, {
      id: input.proxy.id,
      backend: input.backend,
      sandbox,
      preparedProviders: input.proxy.preparedProviders,
      ...(input.proxy.modelProvider === undefined
        ? {}
        : { modelProvider: input.proxy.modelProvider }),
      ...(input.proxy.exchangeAuthority && { exchangeAuthority: input.proxy.exchangeAuthority }),
      ...(git && {
        bindRepositoryGit: git.bindRepositoryGit.bind(git),
        previewEnforcement: git.previewEnforcement.bind(git),
        mandatoryEnforcement: git.mandatoryEnforcement.bind(git),
      }),
    });
  const repositoryTransport: RepositoryTransportBinding | undefined = git && {
    async bind(authority, pool, emit) {
      if (!authority || !proxy?.bindRepositoryGit) {
        throw new Error("Missing the selected Driver's protected repository Git authority.");
      }
      git.connectRouteStore(pool, emit);
      return proxy.bindRepositoryGit(authority);
    },
  };
  return {
    sandbox,
    proxy,
    repositoryTransport,
    async close() {
      await git?.close();
      await input.backend.client.close();
    },
  };
}
