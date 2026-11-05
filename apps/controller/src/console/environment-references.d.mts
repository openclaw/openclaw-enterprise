// console-assets.ts serves OCC's packages/occ/src/environment-references.ts at
// /console/environment-references.mjs. These declarations repeat the signatures the Console uses.
export declare function wholeEnvironmentReferenceName(text: string): string | undefined;
export declare function environmentReferenceNames(
  text: string,
  options?: { readonly fallbacks?: boolean },
): string[];
export declare function unsubstitutedReference(text: string): string | undefined;
export declare function secretInputShorthandName(text: string): string | undefined;
export declare function gatewayPasswordRequirement(
  password: unknown,
  secrets: unknown,
  options?: { readonly step?: boolean },
): string | undefined;
export declare function generatedGatewayPasswordReference(secrets: unknown): {
  readonly source: "env";
  readonly provider: string;
  readonly id: "OPENCLAW_GATEWAY_PASSWORD";
};
export declare function secretProviderDefaultsProblem(
  secrets: unknown,
): { readonly setting: string; readonly requirement: string } | undefined;
export declare function unreadablePluginSecretInput(
  values: unknown,
): { readonly setting: string; readonly requirement: string } | undefined;
export declare function configurationSettingMessage(setting: string, requirement: string): string;
export declare function pluginPolicyId(name: unknown): string | undefined;
export declare function codexPluginPolicyProblem(
  plugins: Readonly<Record<string, unknown>>,
): { readonly setting: string; readonly requirement: string } | undefined;
export declare function configIncludeProblem(
  values: unknown,
): { readonly setting: string; readonly requirement: string } | undefined;
export declare function pluginEntryKeyVariantProblem(
  values: unknown,
  plugins?: readonly string[],
): { readonly setting: string; readonly requirement: string } | undefined;
export declare function trustedProxyIdentitiesProblem(
  trustedProxy: Readonly<Record<string, unknown>>,
): { readonly setting: string; readonly requirement: string } | undefined;
