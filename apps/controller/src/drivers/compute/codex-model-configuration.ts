import type { OpenClawConfigurationDocument } from "@openclaw-enterprise/contracts";
import { asRecord, splitModelRef } from "@openclaw-enterprise/utils";

import type { CodexModelEndpoint } from "./plugin-runtime.ts";

/** Compile the admitted selection into stock OpenClaw's explicit native-provider syntax. */
export function codexGatewayModelConfiguration(
  configuration: OpenClawConfigurationDocument,
  endpoint: CodexModelEndpoint,
): OpenClawConfigurationDocument {
  const document = structuredClone(configuration);
  const agents = asRecord(document.agents);
  const defaults = asRecord(agents?.defaults);
  const entries = Object.values(asRecord(agents?.entries) ?? {}).map(asRecord);
  const primary =
    typeof defaults?.model === "string" ? defaults.model : asRecord(defaults?.model)?.primary;
  const entryPrimary = entries
    .map((entry) =>
      typeof entry?.model === "string" ? entry.model : asRecord(entry?.model)?.primary,
    )
    .find((value) => typeof value === "string");
  const selected = typeof primary === "string" ? primary : entryPrimary;
  if (typeof selected !== "string") {
    throw new Error("Dedicated Codex model selection is missing.");
  }
  const sourceProvider = splitModelRef(selected).provider;
  const references = new Map<string, string>();
  const selections = new Set<string>();
  const qualify = (reference: string): string => {
    const { provider, id } = splitModelRef(reference);
    if (provider !== sourceProvider) {
      return reference;
    }
    if (id === undefined) {
      throw new Error("Dedicated Codex model reference must include its provider.");
    }
    references.set(reference, id);
    return `codex/${endpoint.modelProvider}/${id}`;
  };
  const select = (reference: string): string => {
    // Subagent aliases remain native aliases, even when named like the source provider.
    if (!reference.includes("/")) {
      return reference;
    }
    selections.add(reference);
    return qualify(reference);
  };
  for (const settings of [defaults, ...entries]) {
    if (settings === undefined) {
      continue;
    }
    for (const scope of [settings, asRecord(settings.subagents)]) {
      if (scope === undefined) {
        continue;
      }
      if (typeof scope.model === "string") {
        scope.model = select(scope.model);
      } else {
        const selection = asRecord(scope.model);
        if (typeof selection?.primary === "string") {
          selection.primary = select(selection.primary);
        }
        if (Array.isArray(selection?.fallbacks)) {
          selection.fallbacks = selection.fallbacks.map((reference) => select(reference));
        }
      }
    }
    const policies = asRecord(settings.models);
    if (policies !== undefined) {
      settings.models = Object.fromEntries(
        Object.entries(policies).map(([reference, policy]) => [qualify(reference), policy]),
      );
    }
  }
  const models = asRecord(document.models) ?? {};
  const providers = asRecord(models.providers) ?? {};
  const source = asRecord(providers[sourceProvider]) ?? {};
  const catalog = Array.isArray(source.models) ? source.models.map(asRecord) : [];
  // Match each declared ref, not a prefix heuristic: a native ID may itself
  // start with "codex/", while a catalog may also contain full OCE refs.
  const projected = new Map<string, Record<string, unknown>>();
  for (const [reference, id] of references) {
    const row = catalog.find((entry) => entry?.id === reference || entry?.id === id);
    // Policy selectors can name wildcards or discovery hints, not catalog rows.
    if (row === undefined && !selections.has(reference)) {
      continue;
    }
    projected.set(id, {
      ...(row ?? { name: id }),
      id: `${endpoint.modelProvider}/${id}`,
    });
  }
  if (sourceProvider !== "codex") {
    delete providers[sourceProvider];
  }
  providers.codex = { ...source, models: [...projected.values()] };
  models.providers = providers;
  return { ...document, models: models as OpenClawConfigurationDocument };
}
