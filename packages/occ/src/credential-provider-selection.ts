import { isDeepStrictEqual } from "node:util";
import type {
  CredentialProviderDefinition,
  LegacyCredentialSource,
  EgressRef,
} from "@openclaw-enterprise/contracts";
import { supportsStaticCredentials } from "./credential-proxy.ts";

export function registeredCredentialProvider(
  providers: readonly CredentialProviderDefinition[],
  ref: EgressRef,
): CredentialProviderDefinition | "ambiguous" | undefined {
  const matches = providers.filter(
    (provider) => provider.ref.id === ref.id && provider.ref.generation === ref.generation,
  );
  if (matches.length > 1) {
    return "ambiguous";
  }
  return matches.length === 1 && isDeepStrictEqual(matches[0]!.ref, ref) ? matches[0] : undefined;
}

export function matchesAdmittedSourceType(
  source: LegacyCredentialSource,
  provider: CredentialProviderDefinition,
) {
  return (
    source.egress?.adoption !== "live" ||
    (provider.sourceType.type === source.type && supportsStaticCredentials(provider.sourceType))
  );
}
