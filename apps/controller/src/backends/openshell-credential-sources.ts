import type {
  BackendCredentialSources,
  CredentialOperationContext,
  CredentialSourceContext,
  CredentialSourceInput,
  CredentialSourceStatus,
  CredentialSourceType,
} from "@openclaw-enterprise/contracts";
import {
  CredentialSourceConfigError,
  CredentialSourceRegistrationConfigError,
  ScopeViolationError,
} from "@openclaw-enterprise/occ";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import {
  CODEX_ACCOUNT_CONFIG,
  CODEX_OAUTH_TYPE,
} from "../drivers/credential-refresh/codex-device-authorization.ts";
import { OpenShellProviderAlreadyExistsError } from "../drivers/sandbox/openshell-gateway-client.ts";
import {
  openShellProviderName,
  openShellWorkspaceName,
  type OpenShellBackend,
} from "./openshell.ts";
import {
  knownSourceType,
  MANAGED_BY,
  MANAGED_BY_LABEL,
  NAMESPACE_ID_LABEL,
  ownedBy,
  SOURCE_ID_LABEL,
  type OpenShellCredentialProfiles,
  type OpenShellSourceType,
} from "./openshell-credential-profiles.ts";

/** Registers Namespace credential sources as providers in the Sandbox's OpenShell workspace. */
export class OpenShellCredentialSources implements BackendCredentialSources {
  readonly id: string;
  private readonly backend: OpenShellBackend;
  private readonly profiles: OpenShellCredentialProfiles;

  constructor(backend: OpenShellBackend, profiles: OpenShellCredentialProfiles) {
    if (backend.credentialSources.id !== profiles.id) {
      throw new Error("The OpenShell Backend does not declare this credential source owner.");
    }
    this.backend = backend;
    this.profiles = profiles;
    this.id = profiles.id;
  }

  async listSourceTypes(
    _context: CredentialOperationContext,
  ): Promise<readonly CredentialSourceType[]> {
    return this.profiles.catalog();
  }

  validateSourceConfig(
    input: Pick<CredentialSourceInput, "type" | "config">,
  ): Readonly<Record<string, string>> | void {
    // A gateway in each tenant namespace is known only with the tenant's Kubernetes namespace:
    // registration's profile check refuses those names before any gateway write.
    return this.profiles
      .sourceType(input.type)
      .validate(input.config, this.backend.client.placement());
  }

  async registerSource(
    context: CredentialSourceContext,
    input: CredentialSourceInput,
  ): Promise<CredentialSourceStatus> {
    const type = this.profiles.sourceType(input.type);
    const placement = this.backend.client.placement(context.namespace.name);
    // validateSourceConfig sees no tenant Namespace, so a gateway in each tenant namespace is
    // known only here. Refuse the request's own value before any gateway write, by field, as
    // validateSourceConfig does (400); OCC passes this ScopeViolationError through, while a
    // CredentialSourceConfigError would surface as a 503 (finding 2536).
    try {
      type.validate(input.config, placement);
    } catch (error) {
      if (error instanceof CredentialSourceConfigError) {
        throw new CredentialSourceRegistrationConfigError(error.field, error.message);
      }
      throw error;
    }
    const workspace = openShellWorkspaceName(context.namespace);
    const client = this.backend.client.clientForNamespace(context.namespace.name);
    const credentials = providerCredentials(type, input);
    const name = openShellProviderName(context.source.id);
    const existing = await client.getProvider(workspace, name, context.signal);
    if (existing !== undefined && !ownedBy(existing, context.source.id)) {
      throw new ScopeViolationError(
        "An OpenShell provider with this source's name is not owned by the source.",
      );
    }
    // Reject known collisions before changing the profile. These are separate RPCs:
    // orphan profiles and provider replacement after this read remain outside this check.
    await this.profiles.ensure(
      client,
      workspace,
      type,
      context.source.id,
      input.config,
      placement,
      context.signal,
    );
    try {
      await client.createProvider(
        {
          workspace,
          name,
          type: name,
          labels: {
            [MANAGED_BY_LABEL]: MANAGED_BY,
            [SOURCE_ID_LABEL]: context.source.id,
            [NAMESPACE_ID_LABEL]: context.namespace.id,
          },
          credentials,
        },
        context.signal,
      );
    } catch (error) {
      if (!(error instanceof OpenShellProviderAlreadyExistsError)) {
        throw error;
      }
      // Replay after an uncertain create adopts only this exact source's provider.
      const existing = await client.getProvider(workspace, name, context.signal);
      if (existing === undefined || !ownedBy(existing, context.source.id)) {
        throw new ScopeViolationError(
          "An OpenShell provider with this source's name is not owned by the source.",
        );
      }
    }
    return { state: input.type === CODEX_OAUTH_TYPE ? "pending" : "ready" };
  }

  /**
   * Replaces the stored static values. OpenShell gives them only to processes started after
   * the update, so a running Harness keeps its value until its next deployment. Also rewrites
   * the source's profile when the configured binaries changed since it was written.
   */
  async updateSource(
    context: CredentialSourceContext,
    input: CredentialSourceInput,
  ): Promise<CredentialSourceStatus> {
    const type = this.profiles.sourceType(input.type);
    if (type.refresh !== undefined) {
      throw new ScopeViolationError(
        "A refresh-type source has no static value; reconfigure its refresh material instead.",
      );
    }
    const workspace = openShellWorkspaceName(context.namespace);
    const client = this.backend.client.clientForNamespace(context.namespace.name);
    const name = openShellProviderName(context.source.id);
    const existing = await client.getProvider(workspace, name, context.signal);
    if (existing === undefined) {
      return { state: "absent" };
    }
    if (!ownedBy(existing, context.source.id)) {
      throw new ScopeViolationError(
        "An OpenShell provider with this source's name is not owned by the source.",
      );
    }
    // The profile follows the current configuration, so a narrowed binary list applies here.
    // Narrow first: if the credential update then fails, the old token is only less reachable.
    await this.profiles.ensure(
      client,
      workspace,
      type,
      context.source.id,
      context.source.config,
      this.backend.client.placement(context.namespace.name),
      context.signal,
    );
    await client.updateProviderCredentials(
      workspace,
      name,
      providerCredentials(type, input),
      context.signal,
    );
    return { state: "ready" };
  }

  async sourceStatus(context: CredentialSourceContext): Promise<CredentialSourceStatus> {
    knownSourceType(context.source.type);
    const client = this.backend.client.clientForNamespace(context.namespace.name);
    const provider = await client.getProvider(
      openShellWorkspaceName(context.namespace),
      openShellProviderName(context.source.id),
      context.signal,
    );
    if (provider === undefined) {
      return { state: "absent" };
    }
    if (!ownedBy(provider, context.source.id)) {
      return { state: "failed", reason: "The OpenShell provider is not owned by this source." };
    }
    if (context.source.type === CODEX_OAUTH_TYPE && !provider.config[CODEX_ACCOUNT_CONFIG]) {
      return { state: "pending" };
    }
    return { state: "ready" };
  }

  async removeSource(context: CredentialSourceContext): Promise<void> {
    knownSourceType(context.source.type);
    const workspace = openShellWorkspaceName(context.namespace);
    const name = openShellProviderName(context.source.id);
    const client = this.backend.client.clientForNamespace(context.namespace.name);
    const existing = await client.getProvider(workspace, name, context.signal);
    if (existing !== undefined) {
      if (!ownedBy(existing, context.source.id)) {
        throw new ScopeViolationError(
          "An OpenShell provider with this source's name is not owned by the source.",
        );
      }
      await client.deleteProvider(workspace, name, context.signal);
      if ((await client.getProvider(workspace, name, context.signal)) !== undefined) {
        throw new Error("The OpenShell provider was not deleted.");
      }
    }
    // Workspace deletion requires no profiles, and each source's profile goes with it.
    await client.deleteProviderProfile(workspace, name, context.signal);
  }
}

function providerCredentials(
  type: OpenShellSourceType,
  input: CredentialSourceInput,
): Record<string, string> {
  // OpenShell mints a refresh type's token; its secrets are refresh material, not credentials.
  if (type.refresh !== undefined) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(type.credentials(input.config)).map(([field, key]) => {
      const value = input.secrets[field];
      if (!isNonEmptyString(value)) {
        throw new ScopeViolationError(`The credential source secret ${field} is required.`);
      }
      return [key, value];
    }),
  );
}
