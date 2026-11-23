import { isDeepStrictEqual } from "node:util";

import type {
  DeploymentCredentialBinding,
  CredentialInjectionPolicy,
  CredentialDeploymentConfiguration,
  CredentialDeploymentRef,
  CredentialDeploymentContext,
  CredentialSourceReference,
  ResolvedCredential,
} from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError } from "@openclaw-enterprise/occ";
import { asRecord } from "@openclaw-enterprise/utils";
import {
  MANAGED_BY,
  MANAGED_BY_LABEL,
  SOURCE_ID_LABEL,
  openShellProviderName,
} from "../../backends/openshell.ts";
import {
  OpenShellProviderAlreadyExistsError,
  type OpenShellGatewayClient,
  type OpenShellProviderProfile,
  type OpenShellProviderResponse,
  type OpenShellStoredProviderProfile,
  type OpenShellSandboxResponse,
} from "../sandbox/openshell-gateway-client.ts";
import {
  openShellNetworkRouteMayOverlap,
  sameOpenShellPolicy,
} from "../sandbox/openshell-policy.ts";
import { statusCode } from "../sandbox/openshell-gateway-errors.ts";
import {
  openShellCredentialProviderName,
  openShellCredentialPathsOverlap,
  openShellProjectedCredentialProviderName,
  type OpenShellCredentialRoute,
} from "../sandbox/openshell-credential-policy.ts";

const NAMESPACE_ID = "openclaw.dev/namespace-id";
const GRPC_FAILED_PRECONDITION = 9;
const DELIVERY_OWNER = "openclaw.dev/credential-proxy-delivery";
const STATIC_DELIVERY = "static";
const TOKEN_SERVICE_OWNER = "openclaw.dev/token-service";
const SOURCE_VERSION = "oce_source_version";

/** The nonsecret identity of the delivery resource, including the source version it holds. */
interface OpenShellPushedProvider {
  readonly workspace: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly id: string;
  readonly resourceVersion: string;
  readonly profileVersion: string;
  readonly sourceVersion: string;
}

export class OpenShellCredentialDeliveryRefusedError extends DependencyUnavailableError {
  constructor() {
    super("The OpenShell credential delivery Provider or target is unavailable or incompatible.");
  }
}

function refuse(): never {
  throw new OpenShellCredentialDeliveryRefusedError();
}

function deliveryOwnership(source: CredentialSourceReference): Record<string, string> {
  return {
    [MANAGED_BY_LABEL]: MANAGED_BY,
    [SOURCE_ID_LABEL]: source.id,
    [NAMESPACE_ID]: source.namespaceId,
    [DELIVERY_OWNER]: STATIC_DELIVERY,
  };
}

function profileFor(binding: DeploymentCredentialBinding): OpenShellProviderProfile {
  if (
    (binding.consumer.kind !== "model" && binding.consumer.kind !== "plugin") ||
    binding.projection.presentation !== "bearer" ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.projection.environment)
  ) {
    refuse();
  }
  return profileForSource(
    binding.sourceRef,
    binding.projection.environment,
    openShellCredentialProviderName(binding),
  );
}

function profileForSource(
  sourceRef: CredentialSourceReference,
  environment: string,
  name: string,
): OpenShellProviderProfile {
  return {
    id: name,
    displayName: "OCC credential delivery",
    category: "PROVIDER_PROFILE_CATEGORY_OTHER",
    credentials: [
      {
        name: environment,
        envVars: [environment],
        required: true,
        authStyle: "bearer",
        headerName: "authorization",
        stablePlaceholder: true,
      },
    ],
    endpoints: [],
    binaries: [],
    inferenceCapable: false,
    annotations: deliveryOwnership(sourceRef),
  };
}

function checkProfile(
  stored: OpenShellStoredProviderProfile | undefined,
  profile: OpenShellProviderProfile,
): string {
  const definition = stored?.definition;
  const credentials = Array.isArray(definition?.credentials) ? definition.credentials : [];
  const credential = asRecord(credentials[0]);
  const expected = profile.credentials[0]!;
  if (
    !stored ||
    stored.id !== profile.id ||
    !/^[1-9]\d*$/.test(stored.resourceVersion) ||
    !isDeepStrictEqual(stored.annotations, profile.annotations) ||
    !definition ||
    definition.inference_capable === true ||
    (Array.isArray(definition.endpoints) && definition.endpoints.length !== 0) ||
    (Array.isArray(definition.binaries) && definition.binaries.length !== 0) ||
    (Array.isArray(definition.files) && definition.files.length !== 0) ||
    credentials.length !== 1 ||
    !credential ||
    credential.name !== expected.name ||
    !isDeepStrictEqual(credential.env_vars, expected.envVars) ||
    credential.required !== true ||
    credential.auth_style !== expected.authStyle ||
    credential.header_name !== expected.headerName ||
    credential.stable_placeholder !== true ||
    credential.refresh !== undefined
  ) {
    refuse();
  }
  return stored.resourceVersion;
}

function ownsDeliveryProvider(
  provider: OpenShellProviderResponse | undefined,
  sourceRef: CredentialSourceReference,
  workspace: string,
  name: string,
): provider is OpenShellProviderResponse {
  return (
    !!provider &&
    provider.name === name &&
    provider.workspace === workspace &&
    provider.labels[MANAGED_BY_LABEL] === MANAGED_BY &&
    provider.labels[SOURCE_ID_LABEL] === sourceRef.id &&
    provider.labels[NAMESPACE_ID] === sourceRef.namespaceId &&
    provider.labels[DELIVERY_OWNER] === STATIC_DELIVERY &&
    provider.labels[TOKEN_SERVICE_OWNER] === undefined
  );
}

/** Source lifecycle operations include all owned projection copies and the retained model name. */
export function openShellDeliveryProviderNames(
  source: CredentialSourceReference,
  providers: readonly OpenShellProviderResponse[],
  profiles: readonly OpenShellStoredProviderProfile[] = [],
): readonly string[] {
  const legacy = openShellProviderName(source.id);
  const projected = new RegExp(`^${legacy}-[a-f0-9]{24}$`);
  return [
    ...new Set([
      legacy,
      ...providers.map(({ name }) => name).filter((name) => projected.test(name)),
      ...profiles.map(({ id }) => id).filter((name) => projected.test(name)),
    ]),
  ];
}

function checkProvider(
  provider: OpenShellProviderResponse | undefined,
  sourceRef: CredentialSourceReference,
  name: string,
  workspace: string,
  workspaceId: string,
  profileVersion: string,
): OpenShellPushedProvider {
  const version = provider?.config[SOURCE_VERSION];
  // Native TokenService sources can use the same source-derived name. Mixed ownership is unsafe.
  if (
    !ownsDeliveryProvider(provider, sourceRef, workspace, name) ||
    provider.type !== name ||
    provider.profileWorkspace !== workspace ||
    !provider.id ||
    !/^[1-9]\d*$/.test(provider.resourceVersion) ||
    !version ||
    Object.keys(provider.config).length !== 1
  ) {
    refuse();
  }
  return Object.freeze({
    workspace,
    workspaceId,
    name: provider.name,
    id: provider.id,
    resourceVersion: provider.resourceVersion,
    profileVersion,
    sourceVersion: version,
  });
}

/** Cleanup depends on ownership, not on whether this Provider passed readiness. */
export async function readOwnedOpenShellPushedProvider(input: {
  readonly client: Pick<OpenShellGatewayClient, "getProvider">;
  readonly workspace: string;
  readonly binding: DeploymentCredentialBinding;
  readonly signal: AbortSignal;
}): Promise<OpenShellProviderResponse> {
  const name = openShellCredentialProviderName(input.binding);
  const provider = await input.client.getProvider(input.workspace, name, input.signal);
  if (!ownsDeliveryProvider(provider, input.binding.sourceRef, input.workspace, name)) {
    refuse();
  }
  return provider;
}

/** Retire only the Proxy-owned copy and profile; OpenShell refuses a Provider still in use. */
export async function retireOccTokenServiceProviderCopy(input: {
  readonly client: Pick<
    OpenShellGatewayClient,
    | "getWorkspace"
    | "getProvider"
    | "getProviderProfile"
    | "deleteProvider"
    | "deleteProviderProfile"
  >;
  readonly workspace: string;
  readonly source: CredentialSourceReference;
  readonly name: string;
  readonly signal: AbortSignal;
  readonly retainIfAttached?: boolean;
}): Promise<void> {
  const { client, workspace, source, name, signal } = input;
  const owner = await client.getWorkspace(workspace, signal);
  if (!owner) {
    return;
  }
  if (
    owner.name !== workspace ||
    !owner.id ||
    owner.labels[MANAGED_BY_LABEL] !== MANAGED_BY ||
    owner.labels[NAMESPACE_ID] !== source.namespaceId
  ) {
    refuse();
  }
  const provider = await client.getProvider(workspace, name, signal);
  const profile = await client.getProviderProfile(workspace, name, signal);
  if (
    (provider && !ownsDeliveryProvider(provider, source, workspace, name)) ||
    (profile &&
      (profile.id !== name || !isDeepStrictEqual(profile.annotations, deliveryOwnership(source))))
  ) {
    refuse();
  }
  if (provider) {
    try {
      await client.deleteProvider(workspace, name, signal);
    } catch (error) {
      const details = asRecord(error)?.details;
      const attached = `provider '${name}' is attached to sandbox(es): `;
      if (
        input.retainIfAttached &&
        statusCode(error) === GRPC_FAILED_PRECONDITION &&
        typeof details === "string" &&
        details.startsWith(attached) &&
        details.slice(attached.length).trim().length > 0
      ) {
        return;
      }
      throw error;
    }
  }
  if (profile) {
    await client.deleteProviderProfile(workspace, name, signal);
  }
}

/** Reuse the Proxy's Provider copy, or initialize it from an authorized OCC TokenService Source. */
export async function prepareOccTokenServiceProviderCopy(input: {
  readonly client: Pick<
    OpenShellGatewayClient,
    | "getWorkspace"
    | "getProvider"
    | "getProviderProfile"
    | "importProviderProfile"
    | "createProvider"
  >;
  readonly workspace: string;
  readonly namespaceId: string;
  readonly binding: DeploymentCredentialBinding;
  readonly resolveCredential: () => Promise<ResolvedCredential>;
  readonly signal: AbortSignal;
}): Promise<OpenShellPushedProvider> {
  const { client, workspace, binding, signal } = input;
  if (
    binding.sourceRef.kind !== "credential_source" ||
    !binding.sourceRef.id ||
    binding.sourceRef.namespaceId !== input.namespaceId
  ) {
    refuse();
  }
  const owner = await client.getWorkspace(workspace, signal);
  if (
    owner?.name !== workspace ||
    !owner.id ||
    owner.labels[MANAGED_BY_LABEL] !== MANAGED_BY ||
    owner.labels[NAMESPACE_ID] !== input.namespaceId
  ) {
    refuse();
  }
  const profile = profileFor(binding);
  const existing = await client.getProvider(workspace, profile.id, signal);
  let stored = await client.getProviderProfile(workspace, profile.id, signal);
  if (!stored && !existing) {
    try {
      await client.importProviderProfile(workspace, profile, signal);
    } catch (error) {
      stored = await client.getProviderProfile(workspace, profile.id, signal);
      if (!stored) {
        throw error;
      }
    }
    stored ??= await client.getProviderProfile(workspace, profile.id, signal);
  }
  const profileVersion = checkProfile(stored, profile);
  // Another deployment may have completed initialization while the profile was being imported.
  const prior = existing ?? (await client.getProvider(workspace, profile.id, signal));
  if (prior) {
    return checkProvider(prior, binding.sourceRef, profile.id, workspace, owner.id, profileVersion);
  }
  let resolved: ResolvedCredential;
  try {
    resolved = await input.resolveCredential();
  } catch {
    signal.throwIfAborted();
    refuse();
  }
  if (!resolved.credential || !resolved.version) {
    refuse();
  }
  signal.throwIfAborted();
  const transfer = {
    workspace,
    name: profile.id,
    type: profile.id,
    labels: deliveryOwnership(binding.sourceRef),
    credentials: { [binding.projection.environment]: resolved.credential },
    config: { [SOURCE_VERSION]: resolved.version },
    ...(resolved.expiresAt && {
      credentialExpirationTimes: { [binding.projection.environment]: resolved.expiresAt },
    }),
  };
  let provider: OpenShellProviderResponse | undefined;
  try {
    provider = await client.createProvider(transfer, signal);
  } catch (error) {
    if (!(error instanceof OpenShellProviderAlreadyExistsError)) {
      signal.throwIfAborted();
      refuse();
    }
    provider = await client.getProvider(workspace, profile.id, signal);
  }
  const prepared = checkProvider(
    provider,
    binding.sourceRef,
    profile.id,
    workspace,
    owner.id,
    profileVersion,
  );
  if (prepared.sourceVersion !== resolved.version) {
    refuse();
  }
  return prepared;
}

/** Push a committed OCC TokenService version into the existing, Proxy-owned delivery copy. */
export async function updateOccTokenServiceProviderCopy(input: {
  readonly client: Pick<
    OpenShellGatewayClient,
    "getWorkspace" | "getProvider" | "getProviderProfile" | "updateProviderCredentialsConditionally"
  >;
  readonly workspace: string;
  readonly sourceRef: CredentialSourceReference;
  readonly name: string;
  readonly version?: string;
  readonly resolveCredential: () => Promise<ResolvedCredential>;
  readonly signal: AbortSignal;
}): Promise<
  | {
      readonly provider: OpenShellPushedProvider;
      readonly update: OpenShellProviderResponse;
    }
  | undefined
> {
  const { client, workspace, sourceRef, name, signal } = input;
  signal.throwIfAborted();
  const owner = await client.getWorkspace(workspace, signal);
  if (
    owner?.name !== workspace ||
    !owner.id ||
    owner.labels[MANAGED_BY_LABEL] !== MANAGED_BY ||
    owner.labels[NAMESPACE_ID] !== sourceRef.namespaceId
  ) {
    refuse();
  }
  const existing = await client.getProvider(workspace, name, signal);
  if (!existing) {
    return undefined;
  }
  if (!ownsDeliveryProvider(existing, sourceRef, workspace, name)) {
    refuse();
  }
  const stored = await client.getProviderProfile(workspace, name, signal);
  const credentials = stored?.definition?.credentials;
  const credential = Array.isArray(credentials) ? asRecord(credentials[0]) : undefined;
  const environment = credential?.name;
  if (
    typeof environment !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(environment) ||
    (name !== openShellProviderName(sourceRef.id) &&
      name !== openShellProjectedCredentialProviderName(sourceRef.id, environment))
  ) {
    refuse();
  }
  const profileVersion = checkProfile(stored, profileForSource(sourceRef, environment, name));
  const current = checkProvider(existing, sourceRef, name, workspace, owner.id, profileVersion);
  if (input.version === current.sourceVersion) {
    // TODO(manual retry): observe a persisted push without retransferring credential material.
    refuse();
  }
  if (!client.updateProviderCredentialsConditionally) {
    refuse();
  }
  const resolved = await input.resolveCredential();
  signal.throwIfAborted();
  if (!resolved.credential || !resolved.version) {
    refuse();
  }
  if (resolved.version === current.sourceVersion) {
    refuse();
  }
  const updated = await client.updateProviderCredentialsConditionally(
    {
      workspace,
      name,
      type: existing.type,
      labels: existing.labels,
      credentials: { [environment]: resolved.credential },
      config: { [SOURCE_VERSION]: resolved.version },
      ...(resolved.expiresAt && {
        credentialExpirationTimes: { [environment]: resolved.expiresAt },
      }),
    },
    current.resourceVersion,
    signal,
  );
  const provider = checkProvider(updated, sourceRef, name, workspace, owner.id, profileVersion);
  if (
    provider.id !== current.id ||
    BigInt(provider.resourceVersion) <= BigInt(current.resourceVersion) ||
    provider.sourceVersion !== resolved.version
  ) {
    refuse();
  }
  return { provider, update: updated };
}

// The staged Sandbox and its final policy revision use the same nonsecret configuration identity.
const OPENSHELL_CONFIGURATION_ANNOTATION = "openclaw.dev/configuration-id";

export function assertOpenShellDeploymentContext(
  context: CredentialDeploymentContext,
  sandboxDriverId: string,
): void {
  context.signal.throwIfAborted();
  const { namespace, revision } = context;
  if (
    !namespace.id ||
    namespace.id !== revision.namespaceId ||
    !revision.agentId ||
    !revision.id ||
    !revision.configurationId ||
    revision.sandboxDriverId !== sandboxDriverId ||
    revision.harness.mode !== "dedicated"
  ) {
    refuse();
  }
}

function withoutDisjointPaths(
  networks: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(networks).map(([name, value]) => {
      const rule = asRecord(value);
      if (!rule || !Array.isArray(rule.endpoints)) {
        return [name, value];
      }
      return [
        name,
        {
          ...rule,
          endpoints: rule.endpoints.filter((endpoint) => {
            const endpointPath = asRecord(endpoint)?.path;
            return (
              typeof endpointPath !== "string" ||
              openShellCredentialPathsOverlap(endpointPath, path)
            );
          }),
        },
      ];
    }),
  );
}

// TODO(native policy): require leaf-only executable rules (#4943) and Bearer-only
// placeholder substitution when OpenShell provides those enforcement capabilities.
/** Check the Gateway's effective policy, including its derived credential marker. */
export function openShellPushedPolicyMatches(
  source: unknown,
  effective: unknown,
  routes: readonly OpenShellCredentialRoute[],
): boolean {
  const sourceNetworks = asRecord(asRecord(source)?.network_policies);
  const networks = asRecord(asRecord(effective)?.network_policies);
  if (!sourceNetworks || !networks || routes.length === 0) {
    return false;
  }
  const matched = new Map<OpenShellCredentialRoute, string>();
  for (const [name, value] of Object.entries(networks)) {
    const rule = asRecord(value);
    if (!rule) {
      return false;
    }
    if (rule.endpoints === undefined) {
      continue;
    }
    if (!Array.isArray(rule.endpoints)) {
      return false;
    }
    for (const value of rule.endpoints) {
      const endpoint = asRecord(value);
      const binding = asRecord(endpoint?.credential_binding);
      if (!binding) {
        continue;
      }
      const ports =
        Array.isArray(endpoint?.ports) && endpoint.ports.length
          ? endpoint.ports
          : typeof endpoint?.port === "number" && endpoint.port > 0
            ? [endpoint.port]
            : [];
      const route = routes.find(
        (candidate) =>
          candidate.provider === binding.provider &&
          typeof endpoint?.host === "string" &&
          candidate.host.toLowerCase() === endpoint.host.toLowerCase() &&
          (candidate.endpointPath === undefined
            ? endpoint.path === undefined || endpoint.path === ""
            : candidate.endpointPath === endpoint.path) &&
          sameOpenShellPolicy(rule.binaries, [{ path: candidate.binary }]) &&
          sameOpenShellPolicy(ports, [candidate.port]),
      );
      if (
        !endpoint ||
        !route ||
        matched.has(route) ||
        rule.name !== name ||
        rule.endpoints.length !== 1 ||
        !sameOpenShellPolicy(sourceNetworks[name], {
          ...rule,
          endpoints: [{ ...endpoint, provider_credentialed: undefined }],
        }) ||
        !sameOpenShellPolicy(
          {
            ...endpoint,
            port: undefined,
            ports,
            enforcement:
              endpoint.enforcement === 1
                ? "NETWORK_ENFORCEMENT_MODE_ENFORCE"
                : endpoint.enforcement,
          },
          {
            host: route.host,
            path: route.endpointPath,
            ports: [route.port],
            protocol: "rest",
            enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
            rules: route.rules,
            credential_binding: { provider: route.provider },
            provider_credentialed: true,
          },
        )
      ) {
        return false;
      }
      matched.set(route, name);
    }
  }
  const names = [...matched.values()];
  return (
    matched.size === routes.length &&
    routes.every(
      (route) =>
        !openShellNetworkRouteMayOverlap(withoutDisjointPaths(networks, route.path), route, names),
    )
  );
}

export function assertOpenShellPushedBinding(
  context: CredentialDeploymentContext,
  binding: DeploymentCredentialBinding,
  policies: readonly CredentialInjectionPolicy[],
): void {
  const admitted = context.revision.credentialDeployment;
  if (
    context.revision.executionAdmission.version !== 8 ||
    context.revision.executionAdmission.mode !== "standalone" ||
    !admitted ||
    !admitted.bindings.some((candidate) => isDeepStrictEqual(candidate, binding)) ||
    !isDeepStrictEqual(admitted.injectionPolicies, policies) ||
    !binding.bindingRef ||
    (binding.consumer.kind !== "model" && binding.consumer.kind !== "plugin") ||
    binding.sourceRef.kind !== "credential_source" ||
    !binding.sourceRef.id ||
    binding.sourceRef.namespaceId !== context.namespace.id ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.projection.environment) ||
    binding.projection.presentation !== "bearer"
  ) {
    refuse();
  }
}

export function assertOpenShellDeploymentRef(
  context: CredentialDeploymentContext,
  requested: CredentialDeploymentRef,
): void {
  if (
    requested.namespaceId !== context.namespace.id ||
    requested.agentId !== context.revision.agentId ||
    requested.revisionId !== context.revision.id
  ) {
    refuse();
  }
}

export function assertOpenShellDeploymentConfiguration(
  context: CredentialDeploymentContext,
  expected: CredentialDeploymentConfiguration,
): void {
  assertOpenShellDeploymentRef(context, expected.targetRef);
  if (
    !expected.targetRef.sandboxId ||
    expected.configurationId !== context.revision.configurationId
  ) {
    refuse();
  }
}

export async function readOpenShellPushedProvider(input: {
  readonly client: Pick<
    OpenShellGatewayClient,
    "getWorkspace" | "getProvider" | "getProviderProfile"
  >;
  readonly workspace: string;
  readonly namespaceId: string;
  readonly binding: DeploymentCredentialBinding;
  readonly signal: AbortSignal;
}): Promise<OpenShellPushedProvider> {
  const owner = await input.client.getWorkspace(input.workspace, input.signal);
  if (
    owner?.name !== input.workspace ||
    !owner.id ||
    owner.labels[MANAGED_BY_LABEL] !== MANAGED_BY ||
    owner.labels[NAMESPACE_ID] !== input.namespaceId
  ) {
    refuse();
  }
  const profile = profileFor(input.binding);
  const stored = await input.client.getProviderProfile(input.workspace, profile.id, input.signal);
  const version = checkProfile(stored, profile);
  return checkProvider(
    await input.client.getProvider(input.workspace, profile.id, input.signal),
    input.binding.sourceRef,
    profile.id,
    input.workspace,
    owner.id,
    version,
  );
}

export function assertOpenShellPushedTarget(
  sandbox: OpenShellSandboxResponse | undefined,
  workspace: string,
  name: string,
  expected: CredentialDeploymentConfiguration,
): asserts sandbox is OpenShellSandboxResponse & {
  readonly id: string;
  readonly resourceVersion: string;
} {
  if (
    !sandbox ||
    sandbox.id !== expected.targetRef.sandboxId ||
    sandbox.name !== name ||
    sandbox.workspace !== workspace ||
    !/^[1-9]\d*$/.test(sandbox.resourceVersion ?? "") ||
    sandbox.labels[MANAGED_BY_LABEL] !== MANAGED_BY ||
    sandbox.labels["openclaw.dev/namespace"] !== expected.targetRef.namespaceId ||
    sandbox.labels["openclaw.dev/agent"] !== expected.targetRef.agentId ||
    sandbox.labels["openclaw.dev/revision"] !== expected.targetRef.revisionId ||
    sandbox.annotations["openclaw.dev/namespace-id"] !== expected.targetRef.namespaceId ||
    sandbox.annotations["openclaw.dev/agent-id"] !== expected.targetRef.agentId ||
    sandbox.annotations["openclaw.dev/revision-id"] !== expected.targetRef.revisionId ||
    sandbox.annotations[OPENSHELL_CONFIGURATION_ANNOTATION] !== expected.configurationId
  ) {
    refuse();
  }
}
