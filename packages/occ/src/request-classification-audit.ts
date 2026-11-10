import type {
  CredentialProviderDefinition,
  EgressRequest,
  EgressRoute,
} from "@openclaw-enterprise/contracts";

const providerStages = [
  "route",
  "method",
  "media_type",
  "headers",
  "json",
  "grant_model",
  "body_schema",
] as const;
type ProviderStage = (typeof providerStages)[number];
export type ClassificationStage = ProviderStage | "target";

// Only this synchronous online-request classification is observed. Other provider
// callers use the same classification and retain their ordinary undefined result.
const observed = new WeakMap<EgressRequest, { stage?: ProviderStage }>();

export function rejectRequestClassification(
  request: EgressRequest,
  stage: ProviderStage,
): undefined {
  const observation = observed.get(request);
  if (observation && providerStages.includes(stage)) {
    observation.stage = stage;
  }
  return undefined;
}

export function classifyForRequestAudit(
  classify: CredentialProviderDefinition["classify"],
  provider: CredentialProviderDefinition,
  route: EgressRoute,
  request: EgressRequest,
) {
  const observation: { stage?: ProviderStage } = {};
  observed.set(request, observation);
  try {
    const operation = Reflect.apply(classify, provider, [route, request]);
    return { operation, stage: observation.stage };
  } finally {
    observed.delete(request);
  }
}
