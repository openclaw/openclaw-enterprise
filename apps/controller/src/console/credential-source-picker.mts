import type { CredentialSourceReference } from "@openclaw-enterprise/contracts";
import { requestFailure } from "./api-client.mjs";
import {
  readCredentialSourceMetadata,
  type CredentialSourceSummary,
} from "./credential-source-metadata.mjs";
import { button, element, replaceChildrenIfChanged } from "./dom.mjs";
import type { NamespacePageContext } from "./namespaces.mjs";

/** Discover readable Sources and let the caller define which ones it can bind. */
export function createCredentialSourcePicker<Criteria>(
  context: Pick<NamespacePageContext, "request" | "isCurrent" | "onExpired"> & {
    namespaceId: string;
  },
  options: {
    id: string;
    label?: string;
    initial?: CredentialSourceReference | null;
    currentId?: string;
    criteria?: Criteria;
    eligible(source: CredentialSourceSummary, criteria: Criteria | undefined): boolean;
    listStatus(hasEligible: boolean, criteria: Criteria | undefined): string;
    listFailure(cause: unknown): string;
    addNew?: { label: string; initial?: boolean };
    onChange(source: CredentialSourceReference | null): void;
  },
) {
  const addNewValue = "new";
  let selected = options.initial ?? null;
  let creating = Boolean(options.addNew?.initial && !selected);
  let addNewLabel = options.addNew?.label;
  let addNewDisabled = false;
  let criteria = options.criteria;
  let sources: CredentialSourceSummary[] = [];
  let loaded = false;
  let loading = false;
  let attempted = false;
  let active = false;
  let disabled = false;
  const select = element("select", { id: options.id });
  const hint = element("p", { className: "hint", role: "status" });
  const retry = button("Retry Source list", () => void load(true), { tone: "ghost", size: "sm" });
  retry.hidden = true;
  const field = element(
    "div",
    { className: "form-field", hidden: true },
    element("label", { for: select.id }, options.label ?? "Existing Credential Source"),
    select,
    hint,
    retry,
  );
  const eligibleSource = (source: CredentialSourceSummary) => options.eligible(source, criteria);
  function acceptedSelection() {
    return selected &&
      (selected.id === options.currentId ||
        (loaded && sources.some((source) => source.id === selected!.id && eligibleSource(source))))
      ? selected
      : null;
  }
  function showListStatus() {
    hint.textContent = options.listStatus(sources.some(eligibleSource), criteria);
  }
  function renderOptions() {
    const eligible = sources.filter(eligibleSource);
    const choices = [
      element(
        "option",
        { value: "" },
        options.addNew ? "Choose a saved credential" : "Choose a Credential Source",
      ),
      ...eligible.map((source) =>
        element("option", { value: source.id }, `${source.name} · ${source.id}`),
      ),
    ];
    if (
      selected &&
      selected.id === options.currentId &&
      !eligible.some((source) => source.id === selected!.id)
    ) {
      choices.push(
        element("option", { value: selected.id }, `Current Credential Source · ${selected.id}`),
      );
    }
    if (addNewLabel !== undefined) {
      const add = element("option", { value: addNewValue }, addNewLabel);
      add.disabled = addNewDisabled;
      choices.push(add);
    }
    replaceChildrenIfChanged(select, choices);
    select.value = creating ? addNewValue : (selected?.id ?? "");
    select.disabled = disabled || (!loaded && !selected && addNewLabel === undefined);
    select.required = active && !creating;
  }
  async function load(force = false) {
    if (loading || (!force && (loaded || attempted))) {
      return;
    }
    attempted = true;
    loading = true;
    const wasLoaded = loaded;
    if (force) {
      retry.textContent = "Refreshing Source list…";
      retry.setAttribute("aria-busy", "true");
    }
    hint.textContent = "Loading readable Credential Sources…";
    renderOptions();
    try {
      const result = await context.request(
        `/namespaces/${encodeURIComponent(context.namespaceId)}/credential-sources`,
      );
      if (!context.isCurrent()) {
        return;
      }
      if (!Array.isArray(result)) {
        throw new Error("The API did not return a Credential Source list.");
      }
      sources = result.flatMap((value) => {
        const source = readCredentialSourceMetadata(value, context.namespaceId);
        return source ? [source] : [];
      });
      loaded = true;
      if (selected && selected.id !== options.currentId) {
        const accepted = acceptedSelection();
        if (!wasLoaded || accepted?.id !== selected.id) {
          selected = accepted;
          options.onChange(selected);
        }
      }
      showListStatus();
      retry.textContent = "Refresh Source list";
      retry.hidden = false;
    } catch (error) {
      if (!context.isCurrent()) {
        return;
      }
      const status = requestFailure(error).status;
      if (status === 401) {
        context.onExpired();
        return;
      }
      if (status === 400 || status === 403 || status === 404) {
        sources = [];
        loaded = false;
        if (selected && selected.id !== options.currentId) {
          selected = null;
          options.onChange(null);
        }
      }
      retry.textContent = "Retry Source list";
      retry.hidden = false;
      hint.textContent = options.listFailure(error);
    } finally {
      loading = false;
      retry.removeAttribute("aria-busy");
      if (context.isCurrent()) {
        renderOptions();
      }
    }
  }
  select.addEventListener("change", () => {
    creating = addNewLabel !== undefined && select.value === addNewValue;
    selected = creating
      ? null
      : (sources.find((source) => source.id === select.value && eligibleSource(source))?.ref ??
        (selected?.id === select.value ? selected : null));
    select.required = active && !creating;
    options.onChange(selected);
  });
  renderOptions();
  return {
    field,
    control: select,
    setActive(value: boolean, nextCriteria = criteria) {
      active = value;
      field.hidden = !value;
      if (nextCriteria !== criteria) {
        criteria = nextCriteria;
        if (
          selected &&
          sources.some((source) => source.id === selected!.id && !eligibleSource(source))
        ) {
          selected = null;
          options.onChange(null);
        }
        if (loaded && !loading) {
          showListStatus();
        }
      }
      renderOptions();
      if (value) {
        void load();
      }
    },
    setDisabled(value: boolean) {
      disabled = value;
      retry.disabled = value;
      renderOptions();
    },
    reset() {
      selected = null;
      creating = false;
      renderOptions();
    },
    setAddNewLabel(label: string) {
      if (options.addNew && label !== addNewLabel) {
        addNewLabel = label;
        renderOptions();
      }
    },
    setAddNewDisabled(value: boolean) {
      if (addNewDisabled !== value) {
        addNewDisabled = value;
        renderOptions();
      }
    },
    get creating() {
      return creating;
    },
    get source() {
      return acceptedSelection();
    },
  };
}
