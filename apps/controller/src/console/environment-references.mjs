// Direct Node consumers import the same OCC module the Console serves at this URL
// (console-assets.ts); browsers never load this file.
export {
  configIncludeProblem,
  configurationSettingMessage,
  environmentReferenceNames,
  gatewayPasswordRequirement,
  generatedGatewayPasswordReference,
  pluginEntryKeyVariantProblem,
  pluginPolicyId,
  secretInputShorthandName,
  secretProviderDefaultsProblem,
  unreadablePluginSecretInput,
  unsubstitutedReference,
  wholeEnvironmentReferenceName,
} from "@openclaw-enterprise/occ";
