// Direct Node consumers import the same OCC module the Console serves at this URL
// (console-assets.ts); browsers never load this file.
export {
  environmentReferenceNames,
  gatewayPasswordRequirement,
  generatedGatewayPasswordReference,
  secretInputShorthandName,
  unsubstitutedReference,
  wholeEnvironmentReferenceName,
} from "@openclaw-enterprise/occ";
