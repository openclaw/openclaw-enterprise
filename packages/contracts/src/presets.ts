import { Type } from "typebox";
import { Check } from "typebox/value";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { SecretId, ServiceAccountId } from "./api/common.ts";
import { isAllowedSecretBindingDestination } from "./secret-bindings.ts";
import {
  PresetValidationError,
  presetTemplateDefaults,
  unresolvedPresetVariableTypes,
  validatePresetTemplate,
} from "./preset-variables.mjs";

export type PresetVariable =
  | { readonly type: "string"; readonly description?: string; readonly default?: string }
  | { readonly type: "number"; readonly description?: string; readonly default?: number }
  | { readonly type: "boolean"; readonly description?: string; readonly default?: boolean };

// Rendering produces an editable draft; ordinary creation APIs validate launch fields.
export type PresetLaunchSettings = Omit<PresetTemplate, "variables">;

// Typed launch fields may contain string tokens until rendering and admission.
export interface PresetTemplate {
  readonly variables?: Readonly<Record<string, PresetVariable>>;
  readonly agent?: Readonly<Record<string, unknown>>;
  readonly configuration?: {
    readonly values?: Readonly<Record<string, unknown>>;
    readonly secretBindings?: Readonly<Record<string, unknown>>;
  };
}

export interface Preset {
  readonly id: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly template: PresetTemplate;
  readonly createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasFields(value: unknown, fields: string[]): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

/** Only credential bindings are admitted here; draft launch fields may be unfinished. */
function validateCredentials(template: PresetTemplate, namespaceId: string) {
  const resolved = presetTemplateDefaults(template);
  const definitions = template.variables ?? {};
  const scalar = (original: unknown, value: unknown, schema: Type.TSchema): boolean => {
    const missing = unresolvedPresetVariableTypes(original, definitions);
    return missing.length
      ? missing.every((type: string) => type === "string")
      : Check(schema, value);
  };
  const reference = (original: unknown, value: unknown): boolean =>
    hasFields(original, ["kind", "namespaceId", "id"]) &&
    isRecord(value) &&
    scalar(original.kind, value.kind, Type.Literal("secret")) &&
    scalar(original.namespaceId, value.namespaceId, Type.Literal(namespaceId)) &&
    scalar(original.id, value.id, SecretId);
  const bindings = template.configuration?.secretBindings;
  if (bindings !== undefined) {
    if (!isRecord(bindings) || Object.keys(bindings).length > 64) {
      throw new PresetValidationError(
        "Preset Secret bindings must be a map of at most 64 bindings.",
      );
    }
    for (const [name, binding] of Object.entries(bindings)) {
      if (!isAllowedSecretBindingDestination(name)) {
        throw new PresetValidationError(
          "A preset Secret binding uses a reserved or invalid environment destination.",
        );
      }
      const value = resolved.configuration?.secretBindings?.[name];
      if (
        !isRecord(binding) ||
        !isRecord(value) ||
        !hasFields(
          binding,
          Object.hasOwn(binding, "delivery") ? ["source", "delivery"] : ["source"],
        ) ||
        !reference(binding.source, value.source) ||
        (Object.hasOwn(binding, "delivery") &&
          (!hasFields(binding.delivery, ["type"]) ||
            !isRecord(value.delivery) ||
            !scalar(binding.delivery.type, value.delivery.type, Type.Literal("env"))))
      ) {
        throw new PresetValidationError(
          "Preset Secret bindings require exact same-Namespace references and environment delivery.",
        );
      }
    }
  }
  const auth = template.agent?.harnessAuth;
  if (auth === undefined || auth === null) {
    return;
  }
  const value = resolved.agent?.harnessAuth;
  if (
    isRecord(auth) &&
    isRecord(value) &&
    ((hasFields(auth, ["method"]) && scalar(auth.method, value.method, Type.Literal("runtime"))) ||
      (hasFields(auth, ["method", "source"]) &&
        scalar(
          auth.method,
          value.method,
          Type.Union([Type.Literal("api_key"), Type.Literal("codex_pat")]),
        ) &&
        reference(auth.source, value.source)) ||
      (hasFields(auth, ["method", "serviceAccountId"]) &&
        scalar(auth.method, value.method, Type.Literal("chatgpt_service_account")) &&
        scalar(auth.serviceAccountId, value.serviceAccountId, ServiceAccountId)))
  ) {
    return;
  }
  throw new PresetValidationError(
    "Preset Harness authentication requires a supported binding with same-Namespace Secret references.",
  );
}

/** Store a safe template; ordinary create/deploy admission owns concrete launch settings. */
export function normalizePresetTemplate(input: unknown, namespaceId: string): PresetTemplate {
  const template = validatePresetTemplate(input);
  validateCredentials(template, namespaceId);
  return immutableCopy(template);
}
