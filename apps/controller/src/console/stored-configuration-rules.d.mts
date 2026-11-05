// console-assets.ts serves OCC's packages/occ/src/stored-configuration-rules.ts at
// /console/stored-configuration-rules.mjs. These declarations repeat the signatures the Console uses.
export type StoredConfigurationRule =
  | "include"
  | "secretProviderDefaults"
  | "gatewayPassword"
  | "workspaceBootstrap"
  | "retiredSetting"
  | "openClawSandbox"
  | "pluginEntryKey"
  | "providerKey"
  | "pluginPolicyList";
export declare function storedConfigurationProblem(
  values: unknown,
): { readonly rule: StoredConfigurationRule; readonly message: string } | undefined;
