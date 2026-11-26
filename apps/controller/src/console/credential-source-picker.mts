import type { CredentialSourceReference } from "@openclaw-enterprise/contracts";
import { namedDenial, requestFailure } from "./api-client.mjs";
import {
  readCredentialSourceMetadata,
  type CredentialSourceSummary,
} from "./credential-source-metadata.mjs";
import { button, element, field, replaceChildrenIfChanged, setUnavailable } from "./dom.mjs";
import type { createDraftStore } from "./drafts.mjs";
import type { NamespacePageContext } from "./namespaces.mjs";

type PickerContext = Pick<NamespacePageContext, "request" | "isCurrent" | "onExpired"> & {
  namespaceId: string;
};

// A panel can render one picker for every referenced Slack credential. Share only the pending
// list read; a later explicit refresh must still make a fresh authorized request.
const pendingSourceLists = new WeakMap<
  PickerContext,
  { namespaceId: string; read: Promise<unknown> }
>();
function readSourceList(context: PickerContext) {
  const pending = pendingSourceLists.get(context);
  if (pending?.namespaceId === context.namespaceId) {
    return pending.read;
  }
  const namespaceId = context.namespaceId;
  const read = context
    .request(`/namespaces/${encodeURIComponent(namespaceId)}/credential-sources`)
    .finally(() => {
      if (pendingSourceLists.get(context)?.read === read) {
        pendingSourceLists.delete(context);
      }
    });
  pendingSourceLists.set(context, { namespaceId, read });
  return read;
}

/** Readable static Sources are candidates; the consuming operation checks exact authority and owner support. */
export const staticCredentialSourceSelection = {
  eligible: (source: CredentialSourceSummary) =>
    source.type === "static" && source.state === "ready",
  listStatus: (hasEligible: boolean) =>
    hasEligible
      ? "Listing confirms read access. Using this Source requires exact Credential Source operate permission."
      : "No ready static Credential Sources are readable in this Namespace. Create a Credential Source in Credentials first.",
  listFailure: (cause: unknown) =>
    namedDenial(cause) ??
    requestFailure(cause).serverMessage ??
    "Could not load Credential Sources. Retry the Source list.",
};

/** Discover readable Sources and let the caller define which ones it can bind. */
export function createCredentialSourcePicker<Criteria>(
  context: PickerContext,
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
  let currentId = options.currentId;
  let selectionBeforeCreate: CredentialSourceReference | null = null;
  let confirmedCreated: CredentialSourceSummary | null = null;
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
  let disabledReason: HTMLElement | null = null;
  let required = true;
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
  const knownSelection = () =>
    selected && (selected.id === currentId || selected.id === confirmedCreated?.id);
  const availableSources = () => {
    const eligible = sources.filter(eligibleSource);
    const created = confirmedCreated;
    return created &&
      eligibleSource(created) &&
      !eligible.some((source) => source.id === created.id)
      ? [...eligible, created]
      : eligible;
  };
  function acceptedSelection() {
    return selected &&
      (knownSelection() ||
        (loaded && sources.some((source) => source.id === selected!.id && eligibleSource(source))))
      ? selected
      : null;
  }
  function showListStatus() {
    hint.textContent = options.listStatus(sources.some(eligibleSource), criteria);
  }
  function renderOptions() {
    const eligible = availableSources();
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
      selected.id === currentId &&
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
    setUnavailable(
      select,
      disabled || (!loaded && !selected && addNewLabel === undefined),
      disabled ? disabledReason : hint,
    );
    select.required = active && required && !creating;
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
      const result = await readSourceList(context);
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
      if (selected && !knownSelection()) {
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
        if (selected && !knownSelection()) {
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
    const previousSelection = selected ?? selectionBeforeCreate;
    creating = addNewLabel !== undefined && select.value === addNewValue;
    if (creating) {
      selectionBeforeCreate = selected;
    }
    selected = creating
      ? null
      : (availableSources().find((source) => source.id === select.value)?.ref ??
        (previousSelection?.id === select.value ? previousSelection : null));
    if (!creating) {
      selectionBeforeCreate = null;
    }
    select.required = active && required && !creating;
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
    setDisabled(value: boolean, reason: HTMLElement | null = null) {
      disabled = value;
      disabledReason = reason;
      retry.disabled = value;
      renderOptions();
    },
    setRequired(value: boolean) {
      required = value;
      renderOptions();
    },
    setCurrent(source: CredentialSourceReference | null) {
      currentId = source?.id;
      selected = source;
      selectionBeforeCreate = null;
      creating = false;
      renderOptions();
      options.onChange(selected);
    },
    reset() {
      selected = null;
      creating = false;
      renderOptions();
    },
    cancelCreating() {
      selected = selectionBeforeCreate;
      selectionBeforeCreate = null;
      creating = false;
      renderOptions();
      options.onChange(selected);
    },
    selectCreated(source: CredentialSourceSummary) {
      if (source.namespaceId !== context.namespaceId || !eligibleSource(source)) {
        throw new Error("The created Credential Source is not eligible for this field.");
      }
      confirmedCreated = source;
      selected = source.ref;
      selectionBeforeCreate = null;
      creating = false;
      renderOptions();
      options.onChange(selected);
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

/** Select or enroll a ready static Source without coupling enrollment to its consumer. */
export function createInlineStaticCredentialSourcePicker(
  context: PickerContext & { drafts?: ReturnType<ReturnType<typeof createDraftStore>["scope"]> },
  body: HTMLElement,
  options: {
    id: string;
    label: string;
    initial: CredentialSourceReference | null;
    inputClassName: string;
    deliveryHint: string;
    onChange(source: CredentialSourceReference | null): void;
    onPending(pending: boolean): void;
  },
) {
  const { id, label, initial } = options;
  const enrollmentKey = `credential-source-create-${id}`;
  const retained = context.drafts?.get(enrollmentKey);
  let unresolvedName = typeof retained === "string" ? retained : undefined;
  const picker = createCredentialSourcePicker(context, {
    ...staticCredentialSourceSelection,
    listStatus: (hasEligible) =>
      hasEligible
        ? staticCredentialSourceSelection.listStatus(true)
        : "No ready static Credential Sources are readable in this Namespace. Select Add new credential… to create one here.",
    id,
    label,
    addNew: { label: "Add new credential…" },
    initial,
    ...(initial ? { currentId: initial.id } : {}),
    onChange: (source) => {
      options.onChange(source);
      feedback.textContent = "";
      renderEnrollment();
    },
  });
  const sourceName = element("input", {
    id: `${id}-name`,
    autocomplete: "off",
    maxlength: "200",
    "data-credential-enrollment": "",
  });
  const token = element("input", {
    id: `${id}-value`,
    type: "password",
    autocomplete: "new-password",
  });
  const feedback = element("p", { className: "hint", role: "status" });
  const create = button("Create credential", () => void enroll(), { tone: "secondary" });
  const cancel = button("Cancel", () => picker.cancelCreating());
  const enrollment = element(
    "div",
    { className: "credential-enrollment", hidden: true },
    element(
      "p",
      { className: "hint" },
      `This creates a reusable Source with the Installation’s selected TokenService. It remains in Credentials if you cancel. ${options.deliveryHint}`,
    ),
    field({
      label: `${label} Source name`,
      control: sourceName,
      className: options.inputClassName,
    }),
    field({ label: `${label} value`, control: token, className: options.inputClassName }),
    element("div", { className: "dialog-actions" }, cancel, create),
  );
  picker.field.append(enrollment, feedback);
  function renderEnrollment() {
    const blocked = unresolvedName !== undefined;
    enrollment.hidden = !picker.creating;
    if (!picker.creating) {
      sourceName.value = "";
      token.value = "";
    }
    sourceName.required = picker.creating;
    token.required = picker.creating;
    create.disabled = blocked;
    picker.setAddNewDisabled(blocked);
    if (blocked) {
      feedback.textContent = `The credential save for "${unresolvedName}" could not be confirmed. Check Credential Sources and the credential owner, then reload this page before creating another Source.`;
    }
  }
  async function enroll() {
    if (unresolvedName !== undefined || !sourceName.reportValidity() || !token.reportValidity()) {
      return;
    }
    const requestedName = sourceName.value.trim();
    if (!requestedName) {
      sourceName.setCustomValidity("Enter a Source name.");
      sourceName.reportValidity();
      return;
    }
    sourceName.setCustomValidity("");
    const controls = [
      ...body.querySelectorAll<
        HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement
      >("input, button, select, textarea"),
    ];
    const disabled = controls.map((control) => control.disabled);
    for (const control of controls) {
      control.disabled = true;
    }
    options.onPending(true);
    const dialog = body.closest("dialog");
    const preventCancel = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    dialog?.addEventListener("cancel", preventCancel, true);
    feedback.textContent = "Creating credential…";
    try {
      const request = context.request(
        `/namespaces/${encodeURIComponent(context.namespaceId)}/credential-sources`,
        {
          method: "POST",
          expectedStatus: 201,
          body: { name: requestedName, type: "static", secret: token.value },
        },
      );
      token.value = "";
      const response = await request;
      const source = readCredentialSourceMetadata(response, context.namespaceId);
      if (
        !source ||
        source.name !== requestedName ||
        source.type !== "static" ||
        source.state !== "ready"
      ) {
        throw new Error("The create response did not confirm the requested Source.");
      }
      picker.selectCreated(source);
      sourceName.value = "";
      feedback.textContent = `Credential Source created: ${source.id}. Using it requires exact Source operate permission.`;
    } catch (cause) {
      token.value = "";
      const { status } = requestFailure(cause);
      if (status === 401) {
        context.onExpired();
      } else if (status === 403) {
        feedback.textContent =
          namedDenial(cause) ?? "You need Credential Source create on this Namespace.";
      } else if (status === 400 || status === 404) {
        feedback.textContent = "The Source was refused. Check its name and value.";
      } else if (status === 429) {
        feedback.textContent = "The request was rate limited. Try again later.";
      } else if (status === 501) {
        feedback.textContent = "The selected credential owner does not support this operation.";
      } else {
        // A 409 can occur after the owner has stored the value. As in Credentials, do not
        // submit another create until the inventory and owner have been checked.
        unresolvedName = requestedName;
        if (context.drafts) {
          const capture = () => requestedName;
          context.drafts.track(enrollmentKey, capture);
          context.drafts.unsavedWhen(enrollmentKey, () => false);
          context.drafts.record(enrollmentKey, capture);
        }
      }
    } finally {
      dialog?.removeEventListener("cancel", preventCancel, true);
      controls.forEach((control, index) => {
        control.disabled = disabled[index]!;
      });
      options.onPending(false);
      renderEnrollment();
      body.dispatchEvent(new Event("change"));
    }
  }
  sourceName.addEventListener("input", () => sourceName.setCustomValidity(""));
  enrollment.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.target === sourceName || event.target === token)) {
      event.preventDefault();
      create.click();
    }
  });
  renderEnrollment();
  return picker;
}
