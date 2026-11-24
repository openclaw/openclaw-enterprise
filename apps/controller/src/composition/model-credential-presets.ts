import {
  modelProviderRequestApproved,
  normalizeInferenceBaseUrl,
  type StaticKeyTemplateValues,
} from "@openclaw-enterprise/contracts";
import type { ControllerOptions, ModelCredentialPreset } from "@openclaw-enterprise/occ";
import { asRecord, splitModelRef } from "@openclaw-enterprise/utils";

import { OPEN_SHELL_CODEX_BINARIES } from "../drivers/sandbox/openshell-codex-artifacts.ts";

const openAiStaticTemplate = {
  mode: "static_bearer",
  destinations: [{ method: "POST", host: "api.openai.com", port: 443, path: "/v1/responses" }],
} as const satisfies StaticKeyTemplateValues;

// TODO: Remove this accepted transport limitation when OpenShell can require HTTPS during
// credential substitution. A matching plaintext request to port 443 can otherwise receive it.
const codexAccountDestinations = [
  { method: "POST", host: "chatgpt.com", port: 443, path: "/backend-api/codex/responses" },
  { method: "GET", host: "chatgpt.com", port: 443, path: "/backend-api/wham/accounts/check" },
  { method: "GET", host: "chatgpt.com", port: 443, path: "/backend-api/wham/config/bundle" },
] as const satisfies StaticKeyTemplateValues["destinations"];

/** The source preset chooses credential authority; the saved model selection chooses its consumer. */
export const resolveModelCredentialPreset: NonNullable<
  ControllerOptions["modelCredentialPreset"]
> = ({ presetId, configuration, harness }): ModelCredentialPreset | undefined => {
  if (harness.id !== "openclaw" && harness.id !== "codex") {
    return undefined;
  }
  const selection = asRecord(asRecord(configuration.agents)?.defaults)?.model;
  const primary = typeof selection === "string" ? selection : asRecord(selection)?.primary;
  if (typeof primary !== "string" || primary !== primary.trim()) {
    return undefined;
  }
  const selected = splitModelRef(primary);
  if (presetId === "builtin_codex") {
    if (
      harness.id !== "codex" ||
      harness.mode !== "dedicated" ||
      selected.provider !== "codex" ||
      !selected.id?.trim() ||
      Object.hasOwn(harness.overrides ?? {}, "modelProvider")
    ) {
      return undefined;
    }
    return {
      providerId: selected.provider,
      destinations: codexAccountDestinations,
      binaries: OPEN_SHELL_CODEX_BINARIES,
      projection: { environment: "CODEX_ACCESS_TOKEN", presentation: "bearer" },
    };
  }
  if (presetId !== "openai") {
    return undefined;
  }
  if (
    (selected.provider !== "openai" &&
      !(harness.id === "codex" && selected.provider === "codex")) ||
    !selected.id?.trim()
  ) {
    return undefined;
  }

  const providerSettings = asRecord(harness.configuration?.modelProvider);
  const protocol = providerSettings?.protocol;
  if (
    !providerSettings ||
    typeof providerSettings.baseUrl !== "string" ||
    (protocol !== "openai-responses" && protocol !== "openai-completions")
  ) {
    return undefined;
  }
  try {
    const provider: NonNullable<ModelCredentialPreset["provider"]> = {
      baseUrl: normalizeInferenceBaseUrl(providerSettings.baseUrl),
      protocol,
    };
    if (!modelProviderRequestApproved(provider, openAiStaticTemplate)) {
      return undefined;
    }
    const destinations =
      harness.id === "codex" &&
      harness.mode === "dedicated" &&
      providerSettings.supportsStandaloneWebSearch === true
        ? [
            ...openAiStaticTemplate.destinations,
            { method: "POST", host: "api.openai.com", port: 443, path: "/v1/alpha/search" },
          ]
        : openAiStaticTemplate.destinations;
    return {
      providerId: selected.provider,
      provider,
      destinations,
      ...(harness.id === "codex" ? { binaries: OPEN_SHELL_CODEX_BINARIES } : {}),
      projection: { environment: "OPENAI_API_KEY", presentation: "bearer" },
    };
  } catch {
    return undefined;
  }
};
