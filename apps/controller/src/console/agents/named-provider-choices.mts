import type { CredentialSourceMetadata, ModelProvider } from "@openclaw-enterprise/contracts";
import { element, field } from "../dom.mjs";
import { requestFailure } from "../api-client.mjs";
import type { CreateAgentContext } from "./create.mjs";
import { namespacePath } from "./list.mjs";

const option = (value: string, text: string) => element("option", { value }, text);

export function namedProviderChoices(context: CreateAgentContext, picker: HTMLSelectElement) {
  let providers: ModelProvider[] = [];
  let requestNumber = 0;
  const status = element("p", { className: "hint", role: "status" });
  const credential = element("select", { id: "provider-key-credential" });
  const credentialField = field({ label: "Inference credential", control: credential });
  const help = element("p", { className: "hint", role: "status" });
  const section = element("div", { className: "form-field", hidden: true }, credentialField, help);
  const selected = () => providers.find((p) => p.id === picker.value);
  const named = () => picker.value !== "openai" && picker.value !== "anthropic";
  const ns = namespacePath(context.namespaceId);

  async function loadCredentials(id = "") {
    const request = ++requestNumber;
    const provider = selected();
    credential.replaceChildren(option("", "Choose a saved credential"));
    help.textContent = "";
    if (!provider) {
      return;
    }
    help.textContent = "Loading credentials…";
    try {
      const sources = (await context.request(
        ns + "/credential-sources",
      )) as CredentialSourceMetadata[];
      if (!context.isCurrent() || request !== requestNumber || picker.value !== provider.id) {
        return;
      }
      const eligible = sources.filter(
        (source) =>
          source.namespaceId === context.namespaceId &&
          source.state === "ready" &&
          source.staticKeyGrant?.connectionTemplateId === provider.connectionTemplateId &&
          source.staticKeyGrant.baseUrl === provider.baseUrl &&
          source.staticKeyGrant.protocol === provider.protocol,
      );
      credential.append(...eligible.map((source) => option(source.id, source.name)));
      credential.value = eligible.some((source) => source.id === id) ? id : "";
      help.textContent = eligible.length
        ? ""
        : "Register a key for this provider’s connection template in Credentials.";
    } catch (error) {
      if (context.isCurrent() && request === requestNumber) {
        help.textContent =
          requestFailure(error).serverMessage ||
          "Could not load inference credentials. Refresh to try again.";
      }
    }
  }
  async function load(restoreCredential: string | undefined, then: () => void) {
    try {
      providers = (await context.request(ns + "/model-providers")) as ModelProvider[];
      if (!context.isCurrent()) {
        return;
      }
      for (const provider of providers) {
        const prior = [...picker.options].find((entry) => entry.value === provider.id);
        if (prior) {
          prior.textContent = provider.displayName;
        } else {
          picker.append(option(provider.id, provider.displayName));
        }
      }
      if (named()) {
        status.textContent = selected()
          ? ""
          : "The saved provider is unavailable. Choose a provider.";
        await loadCredentials(restoreCredential);
      }
      if (context.isCurrent()) {
        then();
      }
    } catch (error) {
      if (context.isCurrent()) {
        status.textContent =
          requestFailure(error).serverMessage ||
          "Could not load saved providers. Refresh to try again.";
      }
    }
  }
  return { selected, named, section, status, credential, load, loadCredentials };
}

/** The checked models share one provider and credential. A radio selects the Agent's default. */
export function providerModelTable(
  change: (id: string, selected: boolean) => void,
  setDefault: (id: string) => void,
) {
  const label = element(
    "legend",
    { id: "provider-models-label" },
    "Models offered by this provider",
  );
  const hint = element("p", { className: "hint", id: "provider-models-hint" });
  const rows = element("tbody");
  const table = element(
    "table",
    { "aria-labelledby": label.id, "aria-describedby": hint.id },
    element(
      "thead",
      {},
      element(
        "tr",
        {},
        ...["Model", "Default"].map((heading) => element("th", { scope: "col" }, heading)),
      ),
    ),
    rows,
  );
  const fields = element(
    "fieldset",
    { className: "provider-model-table", hidden: true },
    label,
    hint,
    table,
  );
  let catalog: ModelProvider["models"] | undefined;
  const controls = new Map<string, { include: HTMLInputElement; primary: HTMLInputElement }>();
  return {
    fields,
    update(
      provider: ModelProvider | undefined,
      primary: string,
      selected: readonly string[],
      entryOnly: boolean,
    ) {
      fields.hidden = !provider;
      if (!provider) {
        return;
      }
      if (provider.models !== catalog) {
        catalog = provider.models;
        controls.clear();
        rows.replaceChildren(
          ...catalog.map((model) => {
            const include = element("input", { type: "checkbox", "aria-label": `Use ${model.id}` });
            const radio = element("input", {
              type: "radio",
              name: "provider-default-model",
              value: model.id,
              "aria-label": `Default ${model.id}`,
            });
            include.addEventListener("change", () => change(model.id, include.checked));
            radio.addEventListener("change", () => setDefault(model.id));
            controls.set(model.id, { include, primary: radio });
            return element(
              "tr",
              {},
              element(
                "th",
                { scope: "row" },
                element(
                  "label",
                  {},
                  include,
                  element(
                    "span",
                    {},
                    ...(model.name && model.name !== model.id
                      ? [model.name, element("span", { className: "hint" }, model.id)]
                      : [model.id]),
                  ),
                ),
              ),
              element("td", {}, radio),
            );
          }),
        );
      }
      const allowed = new Set(selected);
      for (const [id, control] of controls) {
        control.include.checked = id === primary || allowed.has(id);
        control.primary.checked = id === primary;
      }
      table.hidden = entryOnly;
      const first = controls.values().next().value;
      first?.include.setCustomValidity(
        entryOnly || controls.has(primary) ? "" : "Choose at least one model from this provider.",
      );
      if (entryOnly) {
        hint.textContent =
          "This Preset sets models on individual roster entries. Edit their model policies in Advanced settings.";
        return;
      }
      hint.textContent = controls.has(primary)
        ? "Choose the models this Agent can use. New sessions start with the default."
        : "Choose at least one model. The first model you select becomes the default.";
    },
  };
}
