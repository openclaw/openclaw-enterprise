import type {
  SecretBinding,
  SecretMetadata,
  SecretReference,
} from "@openclaw-enterprise/contracts";
import {
  ADMINISTRATOR_PATH,
  refusedAsNonAdministrator,
  requestFailure,
  responseFields,
} from "../api-client.mjs";
import type { AgentAccessContext } from "./credential-access.mjs";
import {
  dismissOnBackdrop,
  element,
  field as formField,
  revealStatus,
  setFieldError,
  setStatusTone,
  statusBlock,
  validateFields,
} from "../dom.mjs";
import {
  ASK_INSTALLATION_ADMINISTRATOR,
  askForGrant,
  NO_SECRETS_CREATE_DENIED,
  SECRET_CREATE_DENIED,
  SECRET_OPERATE_NEEDED,
} from "./access-reasons.mjs";
import {
  describeFailure,
  NAMESPACE_NOT_READY_MESSAGE,
  explainedConflict,
  message,
  namespaceListNeed,
  namespacePath,
} from "./list.mjs";
import { NAME_MAX_CHARACTERS, namespaceNameProblem } from "../namespaces.mjs";
import { secretValueControl } from "../secrets.mjs";

// A preview can show an existing reference without a live Namespace or request function.
type SecretContext = Partial<AgentAccessContext> & {
  // The selected Namespace when this session can read it (the console's Namespace list has it),
  // so its Secret list answers without an audited refusal; undefined otherwise.
  namespace?: { id: string } | undefined;
  operatorId?: string;
  installationAdmin?: boolean | null;
  // The Namespace permission answer's secrets.create: undefined when it is unknown.
  secretsCreateAllowed?: (() => Promise<boolean | undefined>) | undefined;
};

// A bound Secret the caller's readable Secret list leaves out (finding 2619).
export const SECRET_UNLISTED =
  "A Secret is bound. Its name is unavailable: your access does not include reading it, or it was deleted.";
// A disabled field's hint for a bound Secret the caller may read.
const BOUND_SECRET_METADATA = "Secret metadata is bound. Values are never shown.";

// Shown on a listed Secret the caller may read but not operate: a save that binds it would be
// refused (finding 2453).
export const SECRET_OPERATE_DENIED = `Binding it needs Secret operate, which your access does not include. ${SECRET_OPERATE_NEEDED}`;
// A new Secret gets no Secret operate grant of its own. A caller denied operate on a readable
// Secret holds it per Secret, not across the Namespace, so Agent create would refuse a new one
// after it was saved (finding 2492).
export const NEW_SECRET_OPERATE_DENIED =
  "Your access includes Secret operate on only some Secrets in this Namespace, so an Agent cannot use a new Secret you create here.";
// What works instead. Namespace Roles grant Secret operate on one exact Secret, never across the
// Namespace, so the remedy names that grant (finding 2507).
export const NEW_SECRET_OPERATE_REMEDY = `To use a new Secret, create it on the Secrets page, then ${ASK_INSTALLATION_ADMINISTRATOR} for Secret operate on it.`;

// The API's Name length for Secrets, in code points: the Name rule namespaces.mts mirrors.
export const SECRET_NAME_MAX_CHARACTERS = NAME_MAX_CHARACTERS;
// The suggested name's ending that shortening keeps: what the Secret is for, such as
// "harness authentication" or "Slack bot token".
const SUGGESTED_NAME_KEPT_ENDING = 40;

/**
 * A suggested Secret name within the API's Name length. Suggestions join the Agent name, which
 * may itself use every allowed character, with what the Secret is for, so a long one keeps that
 * ending and shortens the middle (finding 1809).
 */
export function suggestedSecretName(suggestion: string) {
  const characters = Array.from(suggestion.trim());
  if (characters.length <= SECRET_NAME_MAX_CHARACTERS) {
    return characters.join("");
  }
  const start = characters.slice(0, SECRET_NAME_MAX_CHARACTERS - SUGGESTED_NAME_KEPT_ENDING - 1);
  const ending = characters.slice(-SUGGESTED_NAME_KEPT_ENDING);
  return `${start.join("").trimEnd()}…${ending.join("").trimStart()}`;
}

export function secretIdForBinding(binding: unknown) {
  return secretSourceForBinding(binding)?.id ?? null;
}

export function secretSourceForBinding(binding: unknown) {
  return secretSource(responseFields(binding).source);
}

function secretSource(value: unknown): SecretReference | null {
  const { kind, namespaceId, id } = responseFields(value);
  return kind === "secret" && typeof namespaceId === "string" && typeof id === "string" && id
    ? { kind, namespaceId, id }
    : null;
}

export function secretBinding(secret: SecretMetadata): SecretBinding {
  return {
    source: secret.ref,
    delivery: { type: "env" },
  };
}

export function sameNamespaceSecretHref(value: unknown, namespaceId?: string) {
  const source = secretSource(value);
  return source && source.namespaceId === namespaceId
    ? secretMetadataPath(namespaceId, source.id)
    : null;
}

export function secretMetadataPath(namespaceId: string, secretId: string) {
  return `${namespacePath(namespaceId)}/secrets/${encodeURIComponent(secretId)}`;
}

// The console's Secrets page with one Secret's metadata and consumers open. A link to the API
// path opened raw JSON, or a raw 403 body that was audited as a denial (finding D757).
export function secretPageHref(namespaceId: string, secretId: string) {
  const query = new URLSearchParams({ namespace: namespaceId, secret: secretId });
  return `/console/secrets?${query}`;
}

// Carry only the public identity, even if a response unexpectedly contains a value.
export function secretMetadata(
  value: unknown,
  namespaceId: string | undefined,
  expectedName?: string,
): SecretMetadata | null {
  const data = responseFields(value);
  const { id, name } = data;
  const ref = secretSource(data.ref);
  if (
    !ref ||
    ref.id !== id ||
    ref.namespaceId !== namespaceId ||
    data.namespaceId !== namespaceId ||
    typeof name !== "string" ||
    !name ||
    (expectedName !== undefined && name !== expectedName)
  ) {
    return null;
  }
  return { id: ref.id, name, namespaceId, ref };
}

// Secret names this page session resolved, per signed-in operator. A rebuilt summary shows the
// name it had while the reread runs, instead of the raw ID and "Loading metadata…" for a moment,
// which wrapped and moved the cards below (finding 1482).
const resolvedSecretNames = new Map<string, string>();
/** Forgets the resolved names, as sign-out forgets other private state. */
export function clearResolvedSecretNames() {
  resolvedSecretNames.clear();
}
const secretNameKey = (context: SecretContext, secretId: string) =>
  context.operatorId ? JSON.stringify([context.operatorId, context.namespaceId, secretId]) : null;

// Secret metadata reads per view, by path. A channel card re-renders its bindings many times per
// Configuration JSON edit and per submit, and each render asked again: about 386 reads per edit
// with two bound Secrets (finding 2601). The Console makes a request function per mounted view
// (and the Agent page one per tab), so keying by it scopes the answers to that view: a new view
// reads again. A failed read is dropped, so the next render asks again.
type SecretRequest = NonNullable<SecretContext["request"]>;
const secretMetadataReads = new WeakMap<SecretRequest, Map<string, Promise<unknown>>>();
// The IDs of the Secrets the caller may read, per view, from the readable Namespace's Secret
// list. The list returns only Secrets with exact read and audits nothing it leaves out, while each
// refused metadata read is audited as an authorization denial nobody attempted (finding 2619). A
// Secret the list leaves out is one the caller may not read, or one a historical version still
// names after it was deleted: it shows as unavailable without the read. Installation
// administrators read each Secret as before: no extra list read, and a deleted one still shows
// as missing. Null when the list is not used or unknown (no readable Namespace, or a failed read,
// which is dropped so the next render asks again); then each Secret is read.
const readableSecretLists = new WeakMap<SecretRequest, Promise<ReadonlySet<string> | null>>();
function readableSecretIds(context: SecretContext, request: SecretRequest, administrator: boolean) {
  const { namespaceId } = context;
  if (!namespaceId || context.namespace?.id !== namespaceId || administrator) {
    return Promise.resolve(null);
  }
  const known = readableSecretLists.get(request);
  if (known) {
    return known;
  }
  const read = request(`${namespacePath(namespaceId)}/secrets`).then(
    (items) =>
      Array.isArray(items)
        ? new Set(
            items
              .map((item: unknown) => secretMetadata(item, namespaceId)?.id)
              .filter((id) => id !== undefined),
          )
        : null,
    () => null,
  );
  readableSecretLists.set(request, read);
  void read.then((ids) => {
    if (ids === null && readableSecretLists.get(request) === read) {
      readableSecretLists.delete(request);
    }
  });
  return read;
}
function readSecretMetadata(
  context: SecretContext,
  request: SecretRequest,
  href: string,
  secretId: string,
) {
  let reads = secretMetadataReads.get(request);
  if (!reads) {
    reads = new Map();
    secretMetadataReads.set(request, reads);
  }
  const known = reads.get(href);
  if (known) {
    return known;
  }
  // An Installation administrator reads the Secret by ID. A refusal that settles the caller is
  // no administrator after all (finding D760) takes the member path instead: the readable list,
  // which audits nothing, then a read only of a listed Secret. Without the list it reads nothing.
  const attempt = (administrator: boolean, refused?: unknown): Promise<unknown> =>
    readableSecretIds(context, request, administrator).then((readable) =>
      readable === null && refused !== undefined
        ? Promise.reject(refused)
        : readable && !readable.has(secretId)
          ? Promise.reject(Object.assign(new Error("Secret not listed."), { unlisted: true }))
          : request(href, administrator ? ADMINISTRATOR_PATH : undefined),
    );
  const administrator = context.installationAdmin === true;
  const read = attempt(administrator).catch((cause: unknown) =>
    administrator && refusedAsNonAdministrator(cause)
      ? attempt(false, cause)
      : Promise.reject(cause),
  );
  reads.set(href, read);
  read.catch(() => {
    if (reads.get(href) === read) {
      reads.delete(href);
    }
  });
  return read;
}
/**
 * Drops the view's answer for a Secret a field just bound, so its summary reads it fresh, and
 * the view's Secret list, which predates a Secret created inline.
 */
function forgetSecretMetadata(context: SecretContext, secretId: string) {
  if (typeof context.request === "function" && context.namespaceId) {
    readableSecretLists.delete(context.request);
    secretMetadataReads
      .get(context.request)
      ?.delete(secretMetadataPath(context.namespaceId, secretId));
  }
}

function secretMetadataLink(namespaceId: string, secretId: string, name: string) {
  return element(
    "a",
    {
      href: secretPageHref(namespaceId, secretId),
      target: "_blank",
      rel: "noopener",
      title: "View Secret metadata (opens in new tab)",
    },
    name,
  );
}

// Resolve only the referenced resource: list permission is not required to read a binding.
export function renderSecretReference(context: SecretContext, source?: SecretReference | null) {
  const node = element("span", { className: "secret-reference", role: "status" });
  if (source == null) {
    node.textContent = "No Secret bound";
    return node;
  }
  const href = sameNamespaceSecretHref(source, context.namespaceId);
  if (!href) {
    node.textContent = "Bound Secret · reference unavailable in this Namespace";
    return node;
  }
  const bound = `Bound Secret · ${source.id}`;
  if (typeof context.request !== "function") {
    node.textContent = `${bound} · Metadata unavailable`;
    return node;
  }
  const key = secretNameKey(context, source.id);
  const known = key === null ? undefined : resolvedSecretNames.get(key);
  if (known === undefined) {
    node.textContent = `${bound} · Loading metadata…`;
  } else {
    node.replaceChildren(secretMetadataLink(source.namespaceId, source.id, known));
  }
  readSecretMetadata(context, context.request, href, source.id)
    .then((value) => {
      if (context.isCurrent && !context.isCurrent()) {
        return;
      }
      const secret = secretMetadata(value, context.namespaceId);
      if (secret?.id !== source.id) {
        if (key !== null) {
          resolvedSecretNames.delete(key);
        }
        node.textContent = `${bound} · Metadata unavailable`;
        return;
      }
      const { name } = secret;
      if (key !== null) {
        resolvedSecretNames.set(key, name);
      }
      if (name !== known) {
        node.replaceChildren(secretMetadataLink(source.namespaceId, source.id, name));
      }
    })
    .catch((cause: unknown) => {
      if (context.isCurrent && !context.isCurrent()) {
        return;
      }
      if (key !== null) {
        resolvedSecretNames.delete(key);
      }
      const { status } = requestFailure(cause);
      // A refused read hides the Secret's name; the ID stays in the title for the administrator
      // who grants read on it (finding 2549). A Secret the readable list leaves out was not read:
      // it is unreadable, or deleted after a historical version bound it (finding 2619). A caller
      // just found to be no administrator gets the same sentence as any member (finding D760).
      if (responseFields(cause).unlisted === true || refusedAsNonAdministrator(cause)) {
        node.textContent = `${SECRET_UNLISTED} ${askForGrant("Secret read on it")}`;
        node.title = source.id;
      } else if (status === 403) {
        node.textContent = `A Secret is bound. Its name is hidden because your access does not include reading it. ${askForGrant("Secret read on it")}`;
        node.title = source.id;
      } else {
        node.textContent = `${bound} · Metadata unavailable`;
      }
      if (status === 401) {
        context.onExpired?.();
      }
    });
  return node;
}

function credentialLink(href: string, label: string) {
  return element("a", { href, target: "_blank", rel: "noopener" }, `${label} (opens in new tab)`);
}

// A Create Secret refusal other than a conflict: the API's 400 sentence names the field to fix.
function secretCreateRefusal(cause: unknown) {
  const { status } = requestFailure(cause);
  if (status === 403) {
    return SECRET_CREATE_DENIED;
  }
  if (status === 404) {
    return "This Namespace is no longer available. Close this dialog and refresh the page.";
  }
  return describeFailure(cause, { mutation: true, form: true });
}

export function createSecretReferenceField({
  context,
  id,
  label,
  getCurrentSource,
  onSecretSelected,
  createSecretName,
  createDialogTitle,
  createFixedKey,
  metadataLabel = `View ${label} Secret metadata`,
  noSecretLabel = "No Secret bound",
  // Callers whose form applies the binding with another control name it here.
  stagedHint = "Secret binding staged. Save changes to apply it.",
  fieldClassName = "form-field",
  selectClassName,
  disabled = false,
  required = false,
}: {
  context: SecretContext;
  id: string;
  label: string;
  getCurrentSource(): unknown;
  onSecretSelected(secret: SecretMetadata): void | Promise<void>;
  createSecretName(): string;
  createDialogTitle?: string;
  createFixedKey?: { label: string; value: string; hint: string };
  metadataLabel?: string;
  noSecretLabel?: string;
  stagedHint?: string;
  fieldClassName?: string;
  selectClassName?: string;
  disabled?: boolean;
  required?: boolean;
}) {
  const inputClassName = ["secret-typeahead-input", selectClassName].filter(Boolean).join(" ");
  const input = element("input", {
    id,
    type: "text",
    role: "combobox",
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: "false",
    placeholder: noSecretLabel,
    ...(inputClassName ? { className: inputClassName } : {}),
    "aria-describedby": `${id}-status`,
    "aria-controls": `${id}-listbox`,
    "aria-expanded": "false",
    "aria-autocomplete": "list",
  });
  const listbox = element("div", {
    id: `${id}-listbox`,
    className: "secret-typeahead-listbox",
    role: "listbox",
    "aria-label": "Available Secrets",
    // The combobox keeps DOM focus and points at options with aria-activedescendant. A
    // scrolling list is otherwise a Tab stop that hides on blur and drops focus (finding 1919).
    tabindex: "-1",
    hidden: "",
  });
  const status = element("p", { id: `${id}-status`, className: "hint", role: "status" });
  // Forms rename the field by method (API key or Service account token Secret); its required
  // error names the label the page shows (finding 1987).
  const labelNode = element("label", { for: id }, label);
  const metadataLink = credentialLink("#", metadataLabel);
  const secrets: SecretMetadata[] = [];
  // Whether the list read settled: `secrets` then holds every Secret the field knows the caller
  // may read (none after a refused read). Until it settles, nothing is known to be unlisted, and
  // the link stays as it was first drawn.
  let secretsListed = false;
  // Set once a binding is staged, so a Secret list that arrives later keeps its hint.
  let staged = false;
  // Set while the hint describes the loaded Secret list, which follows the field's state.
  let listedHint = false;
  let manuallyDisabled = disabled;
  let requiredWhenEnabled = required;
  let listboxOpen = false;
  let activeOptionIndex = -1;
  let searchQuery = "";
  // Closing the create dialog returns focus to the input; that must not reopen the listbox.
  let suppressFocusOpen = false;
  // Set when the permission answer denies Secret create: the inline create action stays listed,
  // disabled with the reason, so no dialog is filled in only to be refused (finding 2442). An
  // unknown answer keeps the action.
  let createDenied = false;
  // Listed Secrets the permission answer says the caller may not operate. They stay listed,
  // disabled with the reason, and are never staged: a save binding one answers 403 (finding
  // 2453). An unknown answer marks none, and a Secret it does not list stays choosable.
  let operateDenied: ReadonlySet<string> = new Set();
  let operateRead: Promise<void> | null = null;
  function readOperateAnswer(options?: { fresh?: boolean }) {
    const read = (context.secretsOperateDenied?.(options) ?? Promise.resolve(undefined)).then(
      (denied) => {
        if (!isCurrent() || read !== operateRead) {
          return;
        }
        operateDenied = denied ?? new Set();
        if (listboxOpen) {
          renderListbox();
        }
        if (listedHint && !staged) {
          status.textContent = listedStatus();
        }
      },
      () => {},
    );
    operateRead = read;
    return read;
  }
  const secretOperateDenied = (secret: SecretMetadata) => operateDenied.has(secret.id);
  // Why the inline create action is disabled, if it is. A caller denied operate on a listed
  // Secret holds Secret operate per Secret, so a new Secret would get none and could not be
  // chosen: the action is disabled before the Secret is created, as the Preset's Create new Secret
  // choice is (finding 2500). An empty answer cannot tell, so the create is checked afterwards.
  const newSecretDenied = () =>
    createDenied ? SECRET_CREATE_DENIED : operateDenied.size ? NEW_SECRET_OPERATE_DENIED : null;
  function readCreateAnswer() {
    void context.secretsCreateAllowed?.().then((allowed) => {
      if (!isCurrent() || createDenied === (allowed === false)) {
        return;
      }
      createDenied = allowed === false;
      if (listboxOpen) {
        renderListbox();
      }
      if (listedHint && !staged) {
        status.textContent = listedStatus();
      }
    });
  }

  function isCurrent() {
    return typeof context.isCurrent !== "function" || context.isCurrent();
  }

  function currentSecretId() {
    const source = secretSource(getCurrentSource());
    return source && source.namespaceId === context.namespaceId ? source.id : null;
  }

  // A Secret the caller's list leaves out gets no link: the Secrets page shows nothing for one
  // they may not read (finding D757).
  function updateMetadataLink() {
    const selectedSecretId = currentSecretId();
    if (!context.namespaceId || selectedSecretId === null || unlisted(selectedSecretId)) {
      metadataLink.hidden = true;
      metadataLink.removeAttribute("href");
      return;
    }
    metadataLink.hidden = false;
    metadataLink.href = secretPageHref(context.namespaceId, selectedSecretId);
  }
  // A bound Secret the loaded list leaves out: the caller may not read it, or it was deleted.
  // The field says so as Secret summaries do, instead of "Secret metadata is bound" (finding
  // D757).
  function unlistedBinding() {
    const selectedSecretId = currentSecretId();
    return selectedSecretId !== null && unlisted(selectedSecretId)
      ? `${SECRET_UNLISTED} ${askForGrant("Secret read on it")}`
      : null;
  }
  function unlisted(secretId: string) {
    return secretsListed && !secrets.some((secret) => secret.id === secretId);
  }

  function currentSecretLabel() {
    const selectedSecretId = currentSecretId();
    const readableSelected = secrets.find((secret) => secret.id === selectedSecretId);
    if (selectedSecretId === null) {
      return "";
    }
    return readableSelected?.name ?? "Bound Secret";
  }

  function allSecretOptions() {
    const selectedSecretId = currentSecretId();
    const readableSelected = secrets.find((secret) => secret.id === selectedSecretId);
    const options: (SecretOption & { label: string; searchText: string })[] = [];
    // Accessible names collapse whitespace, so compare synthetic labels the same way.
    const normalizeLabel = (label: string) => label.trim().replace(/\s+/g, " ");
    const usedLabels = new Set(secrets.map((secret) => normalizeLabel(secret.name)));
    function syntheticLabel(label: string, qualifier: string) {
      let candidate = label;
      while (usedLabels.has(normalizeLabel(candidate))) {
        candidate += ` (${qualifier})`;
      }
      usedLabels.add(normalizeLabel(candidate));
      return candidate;
    }
    if (selectedSecretId === null) {
      options.push({
        kind: "none",
        label: syntheticLabel(noSecretLabel, "no binding"),
        searchText: noSecretLabel,
      });
    } else if (readableSelected === undefined) {
      options.push({
        kind: "current",
        label: syntheticLabel("Bound Secret", "current binding"),
        searchText: selectedSecretId,
      });
    }
    for (const secret of secrets) {
      options.push({
        kind: "secret",
        label: secret.name,
        searchText: `${secret.name} ${secret.id}`,
        secret,
      });
    }
    options.push({
      kind: "create",
      label: syntheticLabel("Create new Secret...", "action"),
      searchText: "create new secret",
    });
    return options;
  }

  function filteredSecretOptions() {
    const query = searchQuery.trim().toLowerCase();
    return allSecretOptions().filter((option) => {
      return (
        option.kind === "create" || query === "" || option.searchText.toLowerCase().includes(query)
      );
    });
  }

  function setActiveOption(index: number) {
    activeOptionIndex = index;
    for (const [optionIndex, option] of [
      ...listbox.querySelectorAll("[role='option']"),
    ].entries()) {
      const active = optionIndex === activeOptionIndex;
      option.classList.toggle("secret-typeahead-active", active);
      if (active) {
        input.setAttribute("aria-activedescendant", option.id);
        option.scrollIntoView?.({ block: "nearest" });
      }
    }
    if (activeOptionIndex < 0) {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function closeListbox({ restoreSelection = true } = {}) {
    listboxOpen = false;
    listbox.hidden = true;
    input.setAttribute("aria-expanded", "false");
    setActiveOption(-1);
    if (restoreSelection) {
      searchQuery = "";
      input.value = currentSecretLabel();
    }
  }

  function renderListbox() {
    const options = filteredSecretOptions();
    const selectedSecretId = currentSecretId();
    const hasReadableMatches = options.some((option) => option.kind !== "create");
    const nodes = [
      ...(hasReadableMatches || input.value.trim() === ""
        ? []
        : [element("div", { className: "secret-typeahead-empty" }, "No matching Secrets.")]),
      ...options.map((option, index) => {
        const selected =
          (option.kind === "secret" && option.secret.id === selectedSecretId) ||
          (option.kind === "current" && selectedSecretId !== null);
        const reason =
          option.kind === "create"
            ? newSecretDenied()
            : option.kind === "secret" && secretOperateDenied(option.secret)
              ? SECRET_OPERATE_DENIED
              : null;
        const node = element(
          "div",
          {
            id: `${id}-option-${index}`,
            role: "option",
            className: option.kind === "create" ? "secret-typeahead-create" : "",
            "aria-selected": selected ? "true" : "false",
            ...(reason ? { "aria-disabled": "true" } : {}),
          },
          option.label,
          // The space keeps the reason a separate sentence in the option's accessible name.
          reason ? " " : null,
          reason ? element("small", {}, reason) : null,
        );
        node.addEventListener("pointerdown", (event) => event.preventDefault());
        node.addEventListener("click", () => selectOption(option));
        return node;
      }),
    ];
    listbox.replaceChildren(...nodes);
    if (activeOptionIndex >= options.length) {
      activeOptionIndex = options.length - 1;
    }
    setActiveOption(activeOptionIndex);
  }

  function openListbox() {
    if (manuallyDisabled) {
      return;
    }
    // Opening the list asks for the answer again. Create Agent rereads it in place, so a grant or
    // revocation since the field was drawn applies here; the Agent page caches it for the page
    // load, so there it applies after a page reload.
    if (!listboxOpen) {
      readCreateAnswer();
      void readOperateAnswer();
    }
    listboxOpen = true;
    listbox.hidden = false;
    input.setAttribute("aria-expanded", "true");
    renderListbox();
  }

  function setSecretOptions({ preserveSearch = false } = {}) {
    if (!preserveSearch || !listboxOpen) {
      searchQuery = "";
      input.value = currentSecretLabel();
    }
    if (listboxOpen) {
      renderListbox();
    }
    updateMetadataLink();
  }

  function updateValidity() {
    input.required = requiredWhenEnabled;
    input.disabled = manuallyDisabled;
    const missing = `${labelNode.textContent.trim() || label} is required.`;
    input.setCustomValidity(
      requiredWhenEnabled && !manuallyDisabled && currentSecretId() === null ? missing : "",
    );
    // A binding is chosen without an input event; its "is required" error goes with it.
    if (input.validity.valid) {
      setFieldError(input, "");
    } else if (input.getAttribute("aria-invalid") === "true") {
      // A shown error follows a renamed label.
      setFieldError(input, missing);
    }
    if (manuallyDisabled) {
      closeListbox({ restoreSelection: true });
    }
    if (listedHint && !staged) {
      status.textContent = listedStatus();
    }
  }

  function listedStatus() {
    const unlisted = unlistedBinding();
    // A disabled field offers no choice: it says what is bound, not how to choose or create a
    // Secret (finding 2438).
    if (manuallyDisabled) {
      return currentSecretId() === null
        ? "No Secret is bound."
        : (unlisted ?? BOUND_SECRET_METADATA);
    }
    return unlisted ? `${unlisted} ${choiceStatus()}` : choiceStatus();
  }

  function choiceStatus() {
    // The list holds only the Secrets this account may read. Someone the session knows is not
    // an Installation administrator may not see Secrets that exist (finding 2111).
    if (createDenied) {
      return secrets.length
        ? `Choose an existing Secret. ${SECRET_CREATE_DENIED}`
        : NO_SECRETS_CREATE_DENIED;
    }
    if (operateDenied.size) {
      return `Choose an existing Secret. ${NEW_SECRET_OPERATE_DENIED} ${NEW_SECRET_OPERATE_REMEDY}`;
    }
    return secrets.length
      ? "Choose an existing Secret or create a new one."
      : context.installationAdmin === false
        ? `No Secrets you can read in this Namespace. Create a new Secret to bind this field, or ${ASK_INSTALLATION_ADMINISTRATOR} for Secret read and operate on an existing one.`
        : "No readable Secrets yet. Create a new Secret to bind this field.";
  }

  async function bindSecret(secret: SecretMetadata) {
    if (!isCurrent()) {
      return;
    }
    if (secret.id === currentSecretId()) {
      return;
    }
    input.disabled = true;
    closeListbox({ restoreSelection: false });
    setStatusTone(status, null);
    try {
      // A choice made before the answer arrived waits for it, so no refused binding is staged.
      await (operateRead ?? readOperateAnswer());
      if (!isCurrent()) {
        return;
      }
      if (secretOperateDenied(secret)) {
        // A Secret created here is listed, disabled, until the list is read again.
        if (!secrets.some((item) => item.id === secret.id)) {
          secrets.push(secret);
        }
        input.value = currentSecretLabel();
        setStatusTone(status, "danger");
        status.textContent = `${secret.name} cannot be chosen. ${SECRET_OPERATE_DENIED}`;
        listedHint = false;
        return;
      }
      forgetSecretMetadata(context, secret.id);
      await onSecretSelected(secret);
      if (!isCurrent()) {
        return;
      }
      if (!secrets.some((item) => item.id === secret.id)) {
        secrets.push(secret);
      }
      setSecretOptions();
      staged = true;
      status.textContent = stagedHint;
    } finally {
      updateValidity();
    }
  }

  // Typing a Secret's exact name selects it, as clicking its suggestion would; names are
  // unique in a Namespace. Anything else still restores the current binding.
  function typedSecret() {
    const query = searchQuery.trim();
    return query === ""
      ? undefined
      : secrets.find((secret) => secret.name === query && !secretOperateDenied(secret));
  }

  type SecretOption =
    { kind: "create" | "current" | "none" } | { kind: "secret"; secret: SecretMetadata };

  function selectOption(option: SecretOption) {
    if (option.kind === "create") {
      if (newSecretDenied()) {
        return;
      }
      closeListbox({ restoreSelection: true });
      openCreateSecretDialog();
      return;
    }
    if (option.kind === "secret") {
      if (secretOperateDenied(option.secret)) {
        return;
      }
      closeListbox({ restoreSelection: true });
      void bindSecret(option.secret);
      return;
    }
    closeListbox({ restoreSelection: true });
    updateValidity();
  }

  function openCreateSecretDialog() {
    const { namespaceId, request } = context;
    if (!namespaceId || !request || !isCurrent()) {
      return;
    }
    const dialog = element("dialog", {
      className: "dialog credential-secret-dialog",
      "aria-label": createDialogTitle ?? `Create ${label} Secret`,
    });
    const name = element("input", {
      id: `create-${id}-name`,
      type: "text",
      required: "",
      "data-trim": "",
      autocomplete: "off",
      value: suggestedSecretName(createSecretName()),
    });
    // The API's Name rule, checked as the Secrets page checks it (finding 2339).
    name.addEventListener("input", () => name.setCustomValidity(namespaceNameProblem(name.value)));
    // The Secrets page's value control: a multiline value is kept exactly, and a value the API
    // would refuse is named under the field before any request.
    const { value, reveal, multiline } = secretValueControl(`create-${id}-value`);
    const valueField = formField({
      label: "Value",
      control: value,
      help: `Stored as a Namespace Secret. The value is never read back. ${
        multiline ? "Spaces kept; line breaks normalized." : "Enter a single-line value."
      }`,
      className: "form-field secret-value-field",
    });
    value.before(reveal);
    const feedback = statusBlock("danger", null, null);
    const cancel = element("button", { type: "button" }, "Cancel");
    const submit = element(
      "button",
      { type: "submit", className: "button button--primary" },
      "Create Secret",
    );
    let creating = false;
    let outcomeUnknown = false;
    const closeButton = element("button", { type: "button" }, "Close");
    const form = element(
      "form",
      { method: "dialog", className: "channel-drawer-form", novalidate: "" },
      element(
        "div",
        { className: "channel-drawer-head" },
        element("h2", {}, createDialogTitle ?? `Create ${label} Secret`),
        closeButton,
      ),
      createFixedKey
        ? formField({
            label: createFixedKey.label,
            control: element("input", {
              id: `create-${id}-key`,
              value: createFixedKey.value,
              readonly: "",
            }),
            help: createFixedKey.hint,
            className: "form-field",
          })
        : null,
      formField({
        label: "Name",
        control: name,
        help: "Unique within this Namespace.",
        className: "form-field",
      }),
      valueField,
      feedback,
      element("div", { className: "dialog-actions" }, cancel, submit),
    );
    const dismiss = () => {
      value.value = "";
      suppressFocusOpen = true;
      dialog.close();
      dialog.remove();
      setTimeout(() => {
        suppressFocusOpen = false;
      }, 0);
    };
    const close = () => {
      if (creating) {
        return;
      }
      dismiss();
      input.value = currentSecretLabel();
    };
    closeButton.addEventListener("click", close);
    cancel.addEventListener("click", close);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      // The suggested name arrives without an input event, and may carry what the Agent name does.
      name.setCustomValidity(namespaceNameProblem(name.value));
      // The console checks the fields, so no browser bubble shows; a Name of only spaces is
      // missing too (UX plan C3).
      if (
        creating ||
        outcomeUnknown ||
        !dialog.open ||
        !isCurrent() ||
        !validateFields(form.elements)
      ) {
        return;
      }
      const secretName = name.value.trim();
      creating = true;
      submit.disabled = true;
      cancel.disabled = true;
      name.disabled = true;
      value.disabled = true;
      reveal.disabled = true;
      feedback.textContent = "";
      let created = false;
      try {
        const result = await request(`${namespacePath(namespaceId)}/secrets`, {
          method: "POST",
          body: { name: secretName, value: value.value },
          expectedStatus: 201,
        });
        created = true;
        value.value = "";
        if (!dialog.open || !isCurrent()) {
          return;
        }
        const createdSecret = secretMetadata(result, namespaceId, secretName);
        if (!createdSecret) {
          throw new Error("The create response did not identify the requested Secret.");
        }
        // The operate answer read when the list opened predates this Secret, so it never names
        // it: read the answer again, dropping the page's cached copy, before binding it. A Secret
        // the caller may create but not operate is then refused here, not by the save's 403
        // (finding 2486).
        await readOperateAnswer({ fresh: true });
        if (!dialog.open || !isCurrent()) {
          return;
        }
        await bindSecret(createdSecret);
        if (!dialog.open || !isCurrent()) {
          return;
        }
        // A created Secret the answer says the caller may not operate is kept but not chosen;
        // the field says why (finding 2453).
        if (currentSecretId() === createdSecret.id || secretOperateDenied(createdSecret)) {
          dismiss();
          return;
        }
        // The create succeeded. If the choice did not stick, another submit would create again.
        throw new Error("The created Secret could not be selected.");
      } catch (cause) {
        if (!dialog.open || !isCurrent()) {
          value.value = "";
          return;
        }
        const { code, status } = requestFailure(cause);
        outcomeUnknown =
          created || status === undefined || ![400, 403, 404, 409, 429].includes(status);
        if (outcomeUnknown) {
          feedback.textContent =
            "Secret creation outcome could not be confirmed. Refresh before trying again.";
        } else if (status === 409 && code === "NAMESPACE_NOT_READY") {
          feedback.textContent = NAMESPACE_NOT_READY_MESSAGE;
        } else if (status === 409 && explainedConflict(cause) !== undefined) {
          // A typed conflict names the state that refused the create.
          feedback.textContent = describeFailure(cause, { mutation: true });
        } else if (status === 409) {
          feedback.textContent =
            "Secret creation conflicted. A Secret with this name may already exist in this Namespace. Check the name and Namespace state before trying again.";
        } else {
          feedback.textContent = secretCreateRefusal(cause);
        }
        submit.disabled = outcomeUnknown;
        cancel.disabled = false;
        name.disabled = outcomeUnknown;
        value.disabled = outcomeUnknown;
        reveal.disabled = outcomeUnknown;
        if (status === 409 && code !== "NAMESPACE_NOT_READY") {
          name.focus();
        } else {
          // The disabled submit dropped focus to the page behind the open dialog; the refusal
          // takes it, in view (finding 1989).
          revealStatus(feedback, dialog);
        }
      } finally {
        creating = false;
        if (outcomeUnknown) {
          value.value = "";
        }
      }
    });
    dialog.append(form);
    dismissOnBackdrop(dialog);
    document.body.append(dialog);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (!creating) {
        close();
      }
    });
    // Session expiry closes the dialog from the shell, without going through Cancel.
    dialog.addEventListener(
      "close",
      () => {
        value.value = "";
        dialog.remove();
      },
      { once: true },
    );
    dialog.showModal();
    name.focus();
  }

  if (!context.namespaceId || typeof context.request !== "function") {
    setSecretOptions();
    status.textContent = currentSecretId() === null ? "No Secret is bound." : BOUND_SECRET_METADATA;
    manuallyDisabled = true;
    updateValidity();
  } else {
    setSecretOptions();
    readCreateAnswer();
    status.textContent = "Loading available Secrets...";
    context
      .request(`${namespacePath(context.namespaceId)}/secrets`)
      .then((items) => {
        if (!isCurrent()) {
          return;
        }
        const listed = Array.isArray(items)
          ? items
              .map((item: unknown) => secretMetadata(item, context.namespaceId))
              .filter((secret) => secret !== null)
          : [];
        // A Secret created or chosen while this read was pending is newer than the list.
        const added = secrets.filter((secret) => !listed.some((item) => item.id === secret.id));
        secrets.splice(0, secrets.length, ...listed, ...added);
        secretsListed = true;
        setSecretOptions({ preserveSearch: true });
        if (!staged) {
          setStatusTone(status, null);
          listedHint = true;
        }
        updateValidity();
      })
      .catch((error: unknown) => {
        if (!isCurrent()) {
          return;
        }
        const expired = requestFailure(error).status === 401;
        // A binding staged while this read was pending keeps its hint, as on success: Save
        // still applies it (finding 1748). A lost session is still reported.
        if (staged && !expired) {
          return;
        }
        listedHint = false;
        // A refused list shows no Secret as readable, so none gets a link.
        secretsListed = true;
        updateMetadataLink();
        setStatusTone(status, "danger");
        status.textContent = expired
          ? "Your session has expired."
          : `Secrets unavailable. ${message(error, false, namespaceListNeed("Secrets"))}`;
        if (expired) {
          context.onExpired?.();
        }
      });
  }

  const withinListbox = (node: EventTarget | null) =>
    node instanceof Node && listbox.contains(node);
  // Pressing the list's scrollbar can still focus it; hand focus back without closing the list.
  listbox.addEventListener("focus", () => {
    if (input.disabled) {
      closeListbox({ restoreSelection: true });
    } else {
      input.focus();
    }
  });
  input.addEventListener("focus", (event) => {
    // Focus coming back from the picker's own list keeps the search and the open list.
    if (withinListbox(event.relatedTarget)) {
      return;
    }
    searchQuery = "";
    input.select();
    // A field showing its error opens on click, typing or ArrowDown, not on focus: the console's
    // own check focuses it, and the open list covered the error under it (finding 1988).
    if (suppressFocusOpen || input.getAttribute("aria-invalid") === "true") {
      suppressFocusOpen = false;
      return;
    }
    openListbox();
  });
  input.addEventListener("click", () => {
    if (!listboxOpen) {
      openListbox();
    }
  });
  input.addEventListener("input", () => {
    searchQuery = input.value;
    activeOptionIndex = -1;
    openListbox();
    updateValidity();
  });
  input.addEventListener("keydown", (event) => {
    const options = filteredSecretOptions();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!listboxOpen) {
        openListbox();
      }
      setActiveOption(options.length ? Math.min(activeOptionIndex + 1, options.length - 1) : -1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!listboxOpen) {
        openListbox();
      }
      setActiveOption(options.length ? Math.max(activeOptionIndex - 1, 0) : -1);
      return;
    }
    if (event.key === "Enter" && listboxOpen) {
      event.preventDefault();
      const option = options[activeOptionIndex];
      if (option) {
        selectOption(option);
      } else {
        const secret = typedSecret();
        if (secret) {
          selectOption({ kind: "secret", secret });
        }
      }
      return;
    }
    if (event.key === "Escape" && listboxOpen) {
      event.preventDefault();
      event.stopPropagation();
      closeListbox({ restoreSelection: true });
    }
  });
  input.addEventListener("blur", (event) => {
    // Focus moving into the open list stays within the picker; only leaving it closes the list.
    if (withinListbox(event.relatedTarget)) {
      return;
    }
    const typed = listboxOpen && !manuallyDisabled ? typedSecret() : undefined;
    if (typed !== undefined) {
      selectOption({ kind: "secret", secret: typed });
      return;
    }
    closeListbox({ restoreSelection: true });
  });

  const field = element(
    "div",
    { className: fieldClassName },
    labelNode,
    element("div", { className: "secret-typeahead" }, input, listbox),
    metadataLink,
    status,
  );
  updateMetadataLink();
  updateValidity();

  return {
    field,
    setDisabled(value: boolean) {
      manuallyDisabled = value;
      updateValidity();
    },
    setRequired(value: boolean) {
      requiredWhenEnabled = value;
      updateValidity();
    },
    refresh() {
      setSecretOptions();
      updateValidity();
    },
  };
}
