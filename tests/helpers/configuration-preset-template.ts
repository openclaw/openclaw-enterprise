import type {
  OpenClawConfigurationDocument,
  PresetDraftTemplate,
  PresetVariable,
} from "@openclaw-enterprise/contracts";

type Declaration = Extract<PresetVariable, { readonly type: "string" | "boolean" }>;

export function presetVariableTemplate(
  variableName: string,
  values: OpenClawConfigurationDocument,
): (declaration: Declaration) => PresetDraftTemplate {
  return (declaration) => ({
    variables: { [variableName]: declaration },
    configuration: { values },
  });
}
