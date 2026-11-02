// Direct Node consumers import the same OCC module the Console serves at this URL
// (console-assets.ts); browsers never load this file.
export {
  codexPluginPolicyProblem,
  configIncludeProblem,
  configurationSettingMessage,
  environmentReferenceNames,
  gatewayPasswordRequirement,
  generatedGatewayPasswordReference,
  pluginEntryKeyVariantProblem,
  pluginPolicyId,
  secretInputShorthandName,
  secretProviderDefaultsProblem,
  trustedProxyIdentitiesProblem,
  unreadablePluginSecretInput,
  unsubstitutedReference,
  wholeEnvironmentReferenceName,
} from "@openclaw-enterprise/occ";
