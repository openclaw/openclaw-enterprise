import type { CredentialSource, EgressRef } from "@openclaw-enterprise/contracts";

/** Exact bundled provider identity for the online-only Responses adapter. */
export const openAiRequestProviderRef: Readonly<EgressRef> = Object.freeze({
  id: "openai-online-request",
  generation: 1,
});

export function usesOpenAiRequestProvider(source: Readonly<CredentialSource>): boolean {
  const provider = source.egress?.key.provider;
  return (
    source.type === "openai" &&
    provider?.id === openAiRequestProviderRef.id &&
    provider.generation === openAiRequestProviderRef.generation
  );
}
