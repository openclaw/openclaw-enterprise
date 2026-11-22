import {
  modelProviderRequestApproved,
  normalizeInferenceBaseUrl,
  type StaticKeyTemplateValues,
} from "@openclaw-enterprise/contracts";
import type { ControllerOptions, ModelCredentialPreset } from "@openclaw-enterprise/occ";
import { asRecord, splitModelRef } from "@openclaw-enterprise/utils";

const openAiStaticTemplate = {
  mode: "static_bearer",
  destinations: [{ method: "POST", host: "api.openai.com", port: 443, path: "/v1/responses" }],
} as const satisfies StaticKeyTemplateValues;

/** The source preset chooses credential authority; the saved model selection chooses its consumer. */
export const resolveModelCredentialPreset: NonNullable<
  ControllerOptions["modelCredentialPreset"]
> = ({ presetId, configuration, harness }): ModelCredentialPreset | undefined => {
  if (presetId !== "openai" || (harness.id !== "openclaw" && harness.id !== "codex")) {
    return undefined;
  }
  const selection = asRecord(asRecord(configuration.agents)?.defaults)?.model;
  const primary = typeof selection === "string" ? selection : asRecord(selection)?.primary;
  if (typeof primary !== "string" || primary !== primary.trim()) {
    return undefined;
  }
  const selected = splitModelRef(primary);
  if (selected.provider !== "openai" || !selected.id?.trim()) {
    return undefined;
  }

  const overridePresent = Object.hasOwn(harness.overrides ?? {}, "modelProvider");
  const providerSettings = overridePresent
    ? asRecord(harness.overrides?.modelProvider)
    : asRecord(asRecord(asRecord(configuration.models)?.providers)?.openai);
  const protocol = overridePresent
    ? providerSettings?.protocol
    : (providerSettings?.api ?? providerSettings?.protocol);
  if (
    !providerSettings ||
    typeof providerSettings.baseUrl !== "string" ||
    (protocol !== "openai-responses" && protocol !== "openai-completions") ||
    (!overridePresent &&
      providerSettings.api !== undefined &&
      providerSettings.protocol !== undefined &&
      providerSettings.api !== providerSettings.protocol)
  ) {
    return undefined;
  }
  try {
    const provider: ModelCredentialPreset["provider"] = {
      baseUrl: normalizeInferenceBaseUrl(providerSettings.baseUrl),
      protocol,
    };
    if (!modelProviderRequestApproved(provider, openAiStaticTemplate)) {
      return undefined;
    }
    return {
      providerId: selected.provider,
      provider,
      template: openAiStaticTemplate,
      projection: { environment: "OPENAI_API_KEY", presentation: "bearer" },
    };
  } catch {
    return undefined;
  }
};
