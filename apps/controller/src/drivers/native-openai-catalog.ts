import { asRecord, splitModelRef } from "@openclaw-enterprise/utils";

/** A model reference a Dedicated OpenClaw Configuration selects, split at its first slash. */
export interface NativeOpenAiModelSelection {
  readonly provider: string;
  readonly id: string | undefined;
  /** The `models.providers.openai.models` entries whose id is the model ID or the reference. */
  readonly matches: readonly {
    readonly entry: Readonly<Record<string, unknown>>;
    readonly index: number;
  }[];
}

/**
 * The models a Dedicated OpenClaw Configuration selects (`agents.defaults.model` and every
 * `agents.entries.*.model`, primary and fallbacks, once each) and the catalog entries each
 * names. Compute renders only these entries into the native worker's catalog, so the
 * Credential Gateway checks only their endpoints (finding 1686). Undefined when a selection
 * is not a nonblank string.
 */
export function nativeOpenAiModelSelections(
  configuration: Readonly<Record<string, unknown>>,
): readonly NativeOpenAiModelSelection[] | undefined {
  const agents = asRecord(configuration.agents);
  const selections = [
    asRecord(agents?.defaults)?.model,
    ...Object.values(asRecord(agents?.entries) ?? {}).map((entry) => asRecord(entry)?.model),
  ].filter((value) => value !== undefined);
  const references = selections.flatMap((selection) => {
    const value = asRecord(selection);
    return typeof selection === "string"
      ? [selection]
      : [value?.primary, ...(Array.isArray(value?.fallbacks) ? value.fallbacks : [])];
  });
  if (
    references.some((reference) => typeof reference !== "string" || reference.trim().length === 0)
  ) {
    return undefined;
  }
  const catalog = asRecord(asRecord(asRecord(configuration.models)?.providers)?.openai)?.models;
  const entries = Array.isArray(catalog) ? catalog.map((value) => asRecord(value)) : [];
  return [...new Set(references as string[])].map((reference) => {
    const { provider, id } = splitModelRef(reference);
    return {
      provider,
      id,
      matches: entries.flatMap((entry, index) =>
        entry !== undefined && ((id !== undefined && entry.id === id) || entry.id === reference)
          ? [{ entry, index }]
          : [],
      ),
    };
  });
}
