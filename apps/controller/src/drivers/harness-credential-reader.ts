import { isDeepStrictEqual } from "node:util";
import type {
  AgentRevision,
  CredentialGatewayDriver,
  CredentialProviderDefinition,
  CredentialProxyDriver,
  CredentialSource,
  CredentialSourceControl,
  CredentialSourceType,
  EgressRoute,
  HarnessAuthSnapshot,
} from "@openclaw-enterprise/contracts";

type HarnessCredentialSnapshot = Extract<HarnessAuthSnapshot, { method: "credential_source" }>;

/** Check the recorded pairing without treating malformed Proxy snapshots as Gateway ones. */
export function harnessCredentialOwnerMatches(
  auth: HarnessCredentialSnapshot,
  gateway: Pick<CredentialGatewayDriver, "id"> | undefined,
  proxy: Pick<CredentialProxyDriver, "id"> | undefined,
): boolean {
  if (auth.credentialProxyId !== undefined) {
    return (
      auth.credentialGatewayId === undefined &&
      auth.credentialProxyId === proxy?.id &&
      auth.sourceType === "openai" &&
      auth.loginMode === "api_key"
    );
  }
  return gateway !== undefined && auth.credentialGatewayId === gateway.id;
}

export function harnessCredentialTypeMatches(
  auth: HarnessCredentialSnapshot,
  sourceType: CredentialSourceType | undefined,
): boolean {
  return (
    sourceType?.type === auth.sourceType &&
    sourceType.harnessAuth?.modelProvider === "openai" &&
    sourceType.harnessAuth.loginMode === auth.loginMode
  );
}

/** Bind a Proxy source to its current provider and nonempty retained inference routes. */
export function resolveProxyHarnessBinding(
  auth: Extract<HarnessCredentialSnapshot, { credentialProxyId: string }>,
  source: Readonly<CredentialSource>,
  revision: Pick<AgentRevision, "executionAdmission" | "egressPlan">,
  proxy: Pick<CredentialProxyDriver, "sourceControl"> | undefined,
):
  | {
      readonly provider: CredentialProviderDefinition;
      readonly inferenceRoutes: readonly EgressRoute[];
    }
  | undefined {
  const egress = source.egress;
  if (
    egress === undefined ||
    egress.schemaVersion !== 1 ||
    revision.executionAdmission.mode !== "protected" ||
    revision.egressPlan?.egressDriverId !== auth.credentialProxyId
  ) {
    return undefined;
  }
  const inferenceRoutes = revision.egressPlan.routes.filter(
    (route) =>
      route.binding.grant.kind === "inference" &&
      isDeepStrictEqual(route.binding.source, egress.key),
  );
  if (inferenceRoutes.length === 0) {
    return undefined;
  }
  // Invalid admission must refuse before consulting even the installed catalog accessor.
  const provider = sourceEgressProvider(egress, proxy?.sourceControl);
  if (provider === undefined || !harnessCredentialTypeMatches(auth, provider.sourceType)) {
    return undefined;
  }
  return { provider, inferenceRoutes };
}

/** Apply the recorded provider's defaults before the Worker passes the source to Compute. */
export function projectHarnessCredentialSource(
  auth: HarnessCredentialSnapshot,
  source: Readonly<CredentialSource>,
  revision: Pick<AgentRevision, "executionAdmission" | "egressPlan">,
  proxy: Pick<CredentialProxyDriver, "sourceControl"> | undefined,
): Readonly<CredentialSource> | undefined {
  if (source.egress === undefined) {
    return auth.credentialProxyId === undefined ? source : undefined;
  }
  const provider =
    auth.credentialProxyId === undefined
      ? sourceEgressProvider(source.egress, proxy?.sourceControl)
      : resolveProxyHarnessBinding(auth, source, revision, proxy)?.provider;
  return provider === undefined
    ? undefined
    : { ...source, config: provider.normalizeConfig(source.config) };
}

function sourceEgressProvider(
  egress: NonNullable<CredentialSource["egress"]>,
  control: CredentialSourceControl | undefined,
): CredentialProviderDefinition | undefined {
  if (!isDeepStrictEqual(control?.backend, egress.key.backend)) {
    return undefined;
  }
  return control?.providers.find((provider) =>
    isDeepStrictEqual(provider.ref, egress.key.provider),
  );
}
