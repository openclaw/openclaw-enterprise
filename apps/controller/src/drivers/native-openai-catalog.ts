import { asRecord, selectableCatalogModels, splitModelRef } from "@openclaw-enterprise/utils";

/** A model reference a Dedicated OpenClaw Configuration selects, split at its first slash. */
export interface NativeOpenAiModelSelection {
  /** The model reference as written. */
  readonly reference: string;
  readonly provider: string;
  readonly id: string | undefined;
  /** The `models.providers.openai.models` entries whose trimmed id is the model ID or reference. */
  readonly matches: readonly {
    readonly entry: Readonly<Record<string, unknown>>;
    readonly index: number;
  }[];
}

/**
 * The models a Dedicated OpenClaw Configuration selects (`agents.defaults.model` and every
 * `agents.entries.*.model`, their fallbacks and concrete session model choices) and the catalog entries each
 * names. Compute renders only these entries into the native worker's catalog, so the
 * Credential Gateway checks only their endpoints (finding 1686). Undefined when a selection
 * is not a nonblank string.
 */
export function nativeOpenAiModelSelections(
  configuration: Readonly<Record<string, unknown>>,
): readonly NativeOpenAiModelSelection[] | undefined {
  const agents = asRecord(configuration.agents);
  const scopes = [agents?.defaults, ...Object.values(asRecord(agents?.entries) ?? {})];
  const selections = scopes
    .map((scope) => asRecord(scope)?.model)
    .filter((value) => value !== undefined);
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
  // OpenClaw trims catalog ids and merges rows whose trimmed ids collide, the earlier row's
  // fields first, so such a row also names the model: it counts as a match, and two matches
  // are refused.
  const sameId = (value: unknown, expected: string) =>
    typeof value === "string" && value.trim() === expected.trim();
  const catalog = asRecord(asRecord(asRecord(configuration.models)?.providers)?.openai)?.models;
  const entries = Array.isArray(catalog) ? catalog.map((value) => asRecord(value)) : [];
  // The same selections drive native metadata rendering and the credential destination check.
  const selected = new Set([
    ...(references as string[]),
    ...scopes.flatMap(selectableCatalogModels),
  ]);
  return [...selected].map((reference) => {
    const { provider, id } = splitModelRef(reference);
    return {
      reference,
      provider,
      id,
      matches: entries.flatMap((entry, index) =>
        entry !== undefined &&
        ((id !== undefined && sameId(entry.id, id)) || sameId(entry.id, reference))
          ? [{ entry, index }]
          : [],
      ),
    };
  });
}
