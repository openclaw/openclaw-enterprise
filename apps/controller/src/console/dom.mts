type Child = Node | string | null | undefined;
type Attributes = Record<string, string | number | boolean | null | undefined>;

// Every value received from the API is inserted as text, never as HTML.
export function element<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  attributes: Attributes = {},
  ...children: Child[]
): HTMLElementTagNameMap[Tag] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "className") {
      node.className = String(value);
    } else if (
      typeof value === "boolean" &&
      ["disabled", "checked", "selected", "hidden", "required", "readonly"].includes(key)
    ) {
      node.toggleAttribute(key, value);
    } else {
      node.setAttribute(key, String(value));
    }
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

// Polls usually read back what is already shown. Rewriting it anyway repaints, and makes screen
// readers announce live regions again (findings 1420, 1424), so these write only real changes.
export function setText(node: Node, text: string) {
  if (node.textContent !== text) {
    node.textContent = text;
  }
}

/** Sets `hidden` only when it changes: rewriting the same value is still a DOM mutation. */
export function setHidden(node: HTMLElement, hidden: boolean) {
  if (node.hidden !== hidden) {
    node.hidden = hidden;
  }
}

/** Replaces `parent`'s children with `children` (elements) unless they render the same markup. */
export function replaceChildrenIfChanged(parent: Element, children: readonly Element[]) {
  if (parent.innerHTML !== children.map((child) => child.outerHTML).join("")) {
    parent.replaceChildren(...children);
  }
}

// A live region or alert announces reliably when it is inserted, not when an existing node takes
// its role, so a node whose role (or the kind of a role node, a status block's tone included)
// changes is replaced instead.
function sameRole(shown: Element, child: Element) {
  const role = child.getAttribute("role");
  return (
    shown.getAttribute("role") === role &&
    (role === null ||
      (shown.className === child.className &&
        shown.getAttribute("data-tone") === child.getAttribute("data-tone")))
  );
}

function isElement(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE;
}

/**
 * Makes `parent`'s children match `children` (nodes; null and undefined skipped), changing only
 * what differs: an unchanged render touches no node, and a changed one rewrites only the changed
 * text and attributes, position by position (finding 1598). A kept node keeps its listeners, so
 * use this only where a rebuilt node would get the same handlers. Returns whether it changed
 * anything.
 */
export function patchChildren(parent: Element, children: readonly (Node | null | undefined)[]) {
  const next = children.filter((child) => child !== null && child !== undefined);
  let changed = false;
  for (const [index, child] of next.entries()) {
    const shown = parent.childNodes[index];
    if (!shown) {
      parent.append(child);
      changed = true;
    } else if (
      shown.nodeType !== child.nodeType ||
      shown.nodeName !== child.nodeName ||
      (isElement(shown) && isElement(child) && !sameRole(shown, child))
    ) {
      shown.replaceWith(child);
      changed = true;
    } else if (!isElement(shown) || !isElement(child)) {
      if (shown.nodeValue !== child.nodeValue) {
        shown.nodeValue = child.nodeValue;
        changed = true;
      }
    } else if (!shown.isEqualNode(child)) {
      changed = true;
      for (const name of shown.getAttributeNames()) {
        if (!child.hasAttribute(name)) {
          shown.removeAttribute(name);
        }
      }
      for (const { name, value } of child.attributes) {
        if (shown.getAttribute(name) !== value) {
          shown.setAttribute(name, value);
        }
      }
      patchChildren(shown, [...child.childNodes]);
    }
  }
  while (parent.childNodes.length > next.length) {
    parent.lastChild?.remove();
    changed = true;
  }
  return changed;
}

type ButtonAttributes = Attributes & {
  /** Use at most one primary button per view. */
  tone?: "primary" | "secondary" | "ghost" | "danger" | "link";
  size?: "sm";
  className?: string;
};

/** A button in the shared hierarchy. Use `size: "sm"` for a toolbar button. */
export function button(
  label: Child,
  action: (event: HTMLElementEventMap["click"]) => void,
  { tone, size, ...attributes }: ButtonAttributes = {},
) {
  const className = [
    ...(tone || size ? ["button"] : []),
    ...(tone ? [`button--${tone}`] : []),
    ...(size ? [`button--${size}`] : []),
    ...(attributes.className ? [attributes.className] : []),
  ].join(" ");
  const node = element(
    "button",
    { type: "button", ...attributes, ...(className ? { className } : {}) },
    label,
  );
  node.addEventListener("click", action);
  return node;
}

export function dismissOnBackdrop(dialog: HTMLDialogElement) {
  let startedOnBackdrop = false;
  const isBackdrop = (event: MouseEvent) => {
    const bounds = dialog.getBoundingClientRect();
    return (
      event.target === dialog &&
      (event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom)
    );
  };
  dialog.addEventListener("pointerdown", (event) => {
    startedOnBackdrop = event.button === 0 && isBackdrop(event);
  });
  dialog.addEventListener("click", (event) => {
    const dismiss = startedOnBackdrop && isBackdrop(event);
    startedOnBackdrop = false;
    // Reuse Escape's cancellation guards and cleanup; dragging out is not dismissal.
    if (dismiss && dialog.dispatchEvent(new Event("cancel", { cancelable: true }))) {
      dialog.close();
    }
  });
}

/**
 * A phone's on-screen keyboard shrinks the visual viewport, not the layout viewport a modal
 * dialog sits in, so a bottom sheet's actions ended up under the keyboard (finding 1957). This
 * mirrors how far the visible area is inset from the layout viewport's top and bottom
 * (`innerHeight`, the layout viewport, not the initial containing block) into
 * `--visual-viewport-top` and `--visual-viewport-bottom`, which the phone sheet places itself
 * with (console.css). Both are 0 while no keyboard or zoom is up, so a value one frame stale
 * after a window resize still places the sheet right. It writes at most once per frame, and only
 * values that changed.
 */
export function trackVisualViewport(root = document.documentElement) {
  const viewport = globalThis.visualViewport;
  if (!viewport) {
    return;
  }
  const written: Partial<Record<"top" | "bottom", string>> = {};
  let frame = 0;
  const inset = (value: number) => `${value < 1 ? 0 : value}px`;
  const write = () => {
    frame = 0;
    const top = viewport.offsetTop;
    const bottom = globalThis.innerHeight - top - viewport.height;
    for (const [key, value] of [
      ["top", inset(top)],
      ["bottom", inset(bottom)],
    ] as const) {
      if (written[key] !== value) {
        written[key] = value;
        root.style.setProperty(`--visual-viewport-${key}`, value);
      }
    }
  };
  const schedule = () => {
    frame ||= globalThis.requestAnimationFrame(write);
  };
  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  write();
}

let describedFocusIds = 0;

/**
 * After a save the pressed button is disabled or rebuilt, so focus falls to body. Unless the
 * reader has moved on (focus left `root`), put it on the first enabled `controls` entry,
 * described by `message`, or on `message` itself (findings 1446, 1481).
 */
export function focusSaveOutcome(
  root: Element,
  controls: readonly ((HTMLElement & { disabled?: boolean }) | null | undefined)[],
  message: HTMLElement | null | undefined,
) {
  const active = document.activeElement;
  if (active && active !== document.body && !root.contains(active)) {
    return;
  }
  const control = controls.find((node) => node?.isConnected && !node.disabled);
  if (message?.isConnected && message.textContent) {
    if (!control) {
      message.tabIndex = -1;
      message.focus();
      return;
    }
    message.id ||= `save-outcome-${++describedFocusIds}`;
    const described = control.getAttribute("aria-describedby")?.split(/\s+/) ?? [];
    if (!described.includes(message.id)) {
      control.setAttribute("aria-describedby", [...described, message.id].join(" ").trim());
    }
  }
  control?.focus();
}

// Why `text` is not a JSON object, or undefined when it is one. A parse error names the line and
// column where the text stops being JSON, so a long Configuration can be fixed in place
// (findings 1903, 1939).
export function jsonObjectProblem(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (!text.trim()) {
      return "Enter a valid JSON object.";
    }
    const offset = jsonErrorOffset(text);
    if (offset === undefined) {
      return "Invalid JSON. Enter a valid JSON object.";
    }
    // A character pasted from a file or a document can be invisible, or look like a space, so a
    // bare position would point at nothing wrong; the message names it.
    const unseen = UNSEEN_CHARACTERS[text.charAt(offset)];
    if (offset === 0 && unseen) {
      return `Invalid JSON: remove the ${unseen} at the start. Enter a valid JSON object.`;
    }
    const lines = text.slice(0, offset).split(/\r\n?|\n/);
    const where = `line ${lines.length}, column ${visibleLength(lines.at(-1) ?? "") + 1}`;
    return unseen
      ? `Invalid JSON at ${where}: remove the ${unseen} there. Enter a valid JSON object.`
      : `Invalid JSON at ${where}. Enter a valid JSON object.`;
  }
  return parsed === null || Array.isArray(parsed) || typeof parsed !== "object"
    ? "Enter a valid JSON object, not an array or a single value."
    : undefined;
}

// The offset of the first character that breaks the JSON grammar (RFC 8259), `text.length` when
// the text ends early, or undefined when the scan finds no error. Engines word their messages
// differently and some name no position (V8 for a bare word or a byte order mark, Safari for
// any error), so the position comes from this scan, not from the message (finding 1939). It
// keeps its own stack of open containers, so deep nesting cannot overflow the call stack.
export function jsonErrorOffset(text: string): number | undefined {
  const end = text.length;
  const containers: string[] = [];
  let i = 0;
  // "value", "key", "value-or-close" just after "[", "key-or-close" just after "{", or "after" a
  // complete value.
  let expect = "value";
  const skipWhitespace = () => {
    while (i < end && " \t\n\r".includes(text.charAt(i))) {
      i += 1;
    }
  };
  const digits = () => {
    const start = i;
    while (i < end && text.charAt(i) >= "0" && text.charAt(i) <= "9") {
      i += 1;
    }
    return i > start;
  };
  // Each part fails with `i` on the first character that breaks it.
  const string = () => {
    i += 1;
    while (i < end) {
      const code = text.charCodeAt(i);
      if (code === 0x22) {
        i += 1;
        return true;
      }
      if (code < 0x20) {
        return false;
      }
      i += 1;
      if (code === 0x5c) {
        if (text[i] === "u") {
          i += 1;
          for (const stop = i + 4; i < stop; i += 1) {
            if (!/^[0-9a-fA-F]$/.test(text[i] ?? "")) {
              return false;
            }
          }
        } else if (i < end && '"\\/bfnrt'.includes(text.charAt(i))) {
          i += 1;
        } else {
          return false;
        }
      }
    }
    return false;
  };
  const number = () => {
    if (text[i] === "-") {
      i += 1;
    }
    if (text[i] === "0") {
      i += 1;
    } else if (!digits()) {
      return false;
    }
    if (text[i] === ".") {
      i += 1;
      if (!digits()) {
        return false;
      }
    }
    if (text[i] === "e" || text[i] === "E") {
      i += 1;
      if (text[i] === "+" || text[i] === "-") {
        i += 1;
      }
      return digits();
    }
    return true;
  };
  // Matched character by character, so "tr}" fails at the "}".
  const literal = (word: string) => {
    for (const character of word) {
      if (text[i] !== character) {
        return false;
      }
      i += 1;
    }
    return true;
  };
  for (;;) {
    skipWhitespace();
    const character = text.charAt(i);
    const container = containers.at(-1);
    if (
      (expect === "value-or-close" && character === "]") ||
      (expect === "key-or-close" && character === "}")
    ) {
      containers.pop();
      i += 1;
      expect = "after";
    } else if (expect === "key" || expect === "key-or-close") {
      if (character !== '"' || !string()) {
        return i;
      }
      skipWhitespace();
      if (text[i] !== ":") {
        return i;
      }
      i += 1;
      expect = "value";
    } else if (expect !== "after") {
      if (character === "{" || character === "[") {
        containers.push(character);
        i += 1;
        expect = character === "{" ? "key-or-close" : "value-or-close";
        continue;
      }
      const word = JSON_LITERALS[character];
      const valid =
        character === '"'
          ? string()
          : character === "-" || (character >= "0" && character <= "9")
            ? number()
            : word !== undefined && literal(word);
      if (!valid) {
        return i;
      }
      expect = "after";
    } else if (container === undefined) {
      // Text after the top-level value fails at its first character.
      return i < end ? i : undefined;
    } else if (character === ",") {
      i += 1;
      expect = container === "{" ? "key" : "value";
    } else if (character === (container === "{" ? "}" : "]")) {
      containers.pop();
      i += 1;
    } else {
      return i;
    }
  }
}

const JSON_LITERALS: Record<string, string> = { t: "true", f: "false", n: "null" };
const UNSEEN_CHARACTERS: Record<string, string> = {
  "\uFEFF": "invisible byte order mark",
  "\u200B": "invisible zero-width space",
  "\u00A0": "non-breaking space",
};

const graphemes =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

// Characters that render as nothing: zero-width spaces and joiners, direction marks, the soft
// hyphen, the word joiner, a byte order mark (finding 1949). The Hangul fillers U+115F, U+1160,
// U+3164 and U+FFA0 are default-ignorable too, but fonts draw them as blank cells that advance the
// text, so they keep a column.
const INVISIBLE = /^(?:(?![\u115F\u1160\u3164\uFFA0])\p{Default_Ignorable_Code_Point})+$/u;

// Columns count characters as the reader sees them: an emoji, or a letter with a combining
// accent, is one column, not the two UTF-16 units the engine's own column counts, and an
// invisible character is none. Create Agent checks the JSON on every keystroke, so a plain ASCII
// line skips the segmenter.
function visibleLength(line: string) {
  if (/^[\t -~]*$/.test(line)) {
    return line.length;
  }
  const pieces = graphemes
    ? Array.from(graphemes.segment(line), ({ segment }) => segment)
    : Array.from(line);
  return pieces.filter((piece) => !INVISIBLE.test(piece)).length;
}

let fieldIds = 0;
const controlId = (control: Element) => (control.id ||= `field-${++fieldIds}`);

function describe(control: Element, id: string, first = false) {
  const others = (control.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter((value) => value && value !== id);
  control.setAttribute("aria-describedby", (first ? [id, ...others] : [...others, id]).join(" "));
}

function undescribe(control: Element, id: string) {
  const others = (control.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter((value) => value && value !== id);
  if (others.length) {
    control.setAttribute("aria-describedby", others.join(" "));
  } else {
    control.removeAttribute("aria-describedby");
  }
}

let reasonIds = 0;

/**
 * Links a disabled control to the sentence that says why (finding D749), so assistive technology
 * reads the reason with the control, as a sighted reader sees it nearby. Call it wherever the
 * control's disabled state or the reason changes: while the control is disabled (or
 * aria-disabled) and `reason` shows text, the reason joins the control's description; otherwise
 * the link is removed. A reason given by ID may render later, such as a page panel under the
 * header's selector. Other descriptions, such as a field's help or error, are kept.
 */
export function describeDisabled(
  control: HTMLElement,
  reason: HTMLElement | string | null | undefined,
) {
  const disabled =
    (control as HTMLElement & { disabled?: boolean }).disabled === true ||
    control.getAttribute("aria-disabled") === "true";
  let id: string | undefined;
  if (!disabled || !reason) {
    id = undefined;
  } else if (typeof reason === "string") {
    id = reason;
  } else if (!reason.hidden && reason.textContent?.trim()) {
    id = reason.id ||= `disabled-reason-${++reasonIds}`;
  }
  const linked = control.dataset.disabledReason;
  if (linked && linked !== id) {
    undescribe(control, linked);
    delete control.dataset.disabledReason;
  }
  if (id && !(control.getAttribute("aria-describedby") ?? "").split(/\s+/).includes(id)) {
    describe(control, id);
  }
  if (id && linked !== id) {
    control.dataset.disabledReason = id;
  }
}

/**
 * A form field (UX plan C3, console.css "Form field"): a label, the control, then its help. The
 * control is described by the help, and by its error while one shows (setFieldError), which sits
 * between the two, under the control. `help` is text or nodes; `className` adds a component's own
 * class (".form-field" and ".channel-field" are the older names).
 */
export function field({
  label,
  control,
  help,
  error,
  className,
}: {
  label: string;
  control: HTMLElement;
  help?: Child | Child[];
  error?: string | null;
  className?: string;
}) {
  const id = controlId(control);
  const helpNode =
    help === undefined || help === null || help === ""
      ? null
      : element("p", { id: `${id}-hint`, className: "hint field-help" }, ...[help].flat());
  const node = element(
    "div",
    { className: ["field", className].filter(Boolean).join(" ") },
    element("label", { for: id }, label),
    control,
    helpNode,
  );
  if (helpNode) {
    describe(control, helpNode.id);
  }
  if (error) {
    setFieldError(control, error);
  }
  return node;
}

const fieldErrors = new WeakMap<HTMLElement, HTMLParagraphElement>();

// Where a control's error goes: under the control (or the wrapper holding it) in its field, or
// after the label a checkbox sits in.
function placeFieldError(control: HTMLElement, node: HTMLElement) {
  const container = control.closest(".field, .form-field, .channel-field");
  if (container) {
    let child = control;
    while (child.parentElement && child.parentElement !== container) {
      child = child.parentElement;
    }
    child.after(node);
  } else {
    (control.closest("label") ?? control).after(node);
  }
}

/**
 * Shows `text` as `control`'s error, linked with aria-describedby and aria-invalid, in place of
 * the browser's transient validation bubble (finding 1903); empty text clears it.
 */
export function setFieldError(control: HTMLElement, text: string | null | undefined) {
  let node = fieldErrors.get(control);
  if (!text) {
    if (node && !node.hidden) {
      node.textContent = "";
      node.hidden = true;
      control.removeAttribute("aria-invalid");
      undescribe(control, node.id);
    }
    return;
  }
  if (!node) {
    node = element("p", { className: "field-error", id: `${controlId(control)}-error` });
    fieldErrors.set(control, node);
  }
  if (!node.parentNode) {
    placeFieldError(control, node);
  }
  node.textContent = text;
  node.hidden = false;
  control.setAttribute("aria-invalid", "true");
  describe(control, node.id, true);
}

/** A persistent error under `input` whose node the caller places (finding 1903). */
export function fieldError(input: HTMLElement) {
  const node = element("p", { className: "field-error", id: `${controlId(input)}-error` });
  node.hidden = true;
  fieldErrors.set(input, node);
  return {
    node,
    show: (text: string) => setFieldError(input, text),
    clear: () => setFieldError(input, ""),
  };
}

type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement;

function fieldName(control: FormControl) {
  const labelledBy = (control.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/)
    .map((id) => (id ? document.getElementById(id)?.textContent : ""))
    .join(" ");
  const label =
    control.labels?.[0]?.textContent || labelledBy || control.getAttribute("aria-label") || "";
  return label.trim().replace(/\s+/g, " ") || "This field";
}

const TEXT_TYPES = new Set(["text", "search", "email", "url", "tel"]);

// The console's own sentence for a control the browser's checks refuse, or "" when it passes.
// A required control marked data-trim (a name or an identifier, which the API trims) also
// refuses text that is only spaces, which checkValidity() accepts: gate a form on
// validateFields, not on both. Other text, such as a Preset string, keeps its spaces.
function fieldProblem(control: FormControl) {
  const blank =
    "required" in control &&
    control.required &&
    control.hasAttribute("data-trim") &&
    (control.tagName === "TEXTAREA" || TEXT_TYPES.has(control.type)) &&
    !control.value.trim();
  const { validity } = control;
  if (validity.customError) {
    return control.validationMessage;
  }
  if (validity.valueMissing || blank) {
    return control.type === "checkbox"
      ? "Check this box to continue."
      : `${fieldName(control)} is required.`;
  }
  return validity.valid ? "" : `Enter a valid value for ${fieldName(control)}.`;
}

// Controls whose error a check showed. After any edit, one that now passes, or is no longer
// checked (disabled, or no longer required after another field changed), loses its error. One
// document listener runs after the form's own input handlers, which may reset custom validity or
// toggle `required`.
const checkedControls = new Set<FormControl>();
let clearsOnEdit = false;
function clearFixedErrors() {
  for (const control of checkedControls) {
    if (!control.isConnected) {
      checkedControls.delete(control);
    } else if (!control.willValidate || !fieldProblem(control)) {
      checkedControls.delete(control);
      setFieldError(control, "");
    }
  }
}

/**
 * Checks `controls` as the browser would on submit, without its bubble: each one that fails
 * shows the console's error under it (opening a collapsed section around it), and focus moves to
 * the first. Errors an earlier check showed clear once their control passes. Returns whether
 * every control passed. Use with `novalidate` on the form.
 */
export function validateFields(controls: Iterable<Element | null | undefined>) {
  if (!clearsOnEdit) {
    clearsOnEdit = true;
    document.addEventListener("input", clearFixedErrors);
    document.addEventListener("change", clearFixedErrors);
  }
  let first;
  for (const control of controls) {
    if (!willValidate(control)) {
      continue;
    }
    const problem = fieldProblem(control);
    if (problem) {
      setFieldError(control, problem);
      checkedControls.add(control);
      first ??= control;
      const details = control.closest("details");
      if (details) {
        details.open = true;
      }
    } else if (checkedControls.delete(control)) {
      setFieldError(control, "");
    }
  }
  first?.focus();
  return !first;
}

// Form.elements can include fieldsets and other elements that do not participate in validation.
function willValidate(control: Element | null | undefined): control is FormControl {
  return !!control && "willValidate" in control && control.willValidate === true;
}

/**
 * Turns off `form`'s browser validation and checks it with validateFields before any other
 * submit handler runs; a form that fails does not submit.
 */
export function validateOnSubmit(form: HTMLFormElement) {
  form.noValidate = true;
  form.addEventListener(
    "submit",
    (event) => {
      if (!validateFields(form.elements)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    { capture: true },
  );
}

type StatusTone = "info" | "success" | "warning" | "danger";

function statusRole(tone: StatusTone | null | undefined) {
  return tone === "danger" || tone === "warning" ? "alert" : "status";
}

/**
 * A status block (UX plan C1, console.css "Status block"): an error, warning or notice. `tone` is
 * "info", "success", "warning" or "danger". `label` is an optional short heading (text, or a
 * heading node to keep the outline), `body` text or nodes, and `actions` optional buttons or
 * links shown beneath. Danger and warning blocks are alerts, info and success ones statuses;
 * `attributes.role` overrides that (null for no role), and `attributes.className` adds a
 * component's own class. With no label or actions it is one `p` whose text is the body, so a
 * caller can still set its textContent.
 */
export function statusBlock(
  tone: StatusTone,
  label: string | HTMLElement | null | undefined,
  body: Child | Child[],
  actions: readonly Child[] = [],
  { className, role, ...attributes }: Attributes & { role?: string | null } = {},
) {
  const shownRole = role === undefined ? statusRole(tone) : role;
  const shared = {
    className: ["status", className].filter(Boolean).join(" "),
    "data-tone": tone,
    ...(shownRole ? { role: shownRole } : {}),
    ...attributes,
  };
  const bodyNodes = (Array.isArray(body) ? body : [body]).filter(
    (child) => child !== null && child !== undefined,
  );
  if (!label && !actions.length) {
    return element("p", shared, ...bodyNodes);
  }
  if (label && typeof label !== "string") {
    label.classList.add("status-label");
  }
  return element(
    "div",
    shared,
    label
      ? typeof label === "string"
        ? element("p", { className: "status-label" }, label)
        : label
      : null,
    ...bodyNodes.map((child) =>
      typeof child === "string" ? element("p", { className: "status-body" }, child) : child,
    ),
    actions.length ? element("div", { className: "status-actions" }, ...actions) : null,
  );
}

// One way to show a request ID (finding 2538): the words "Request ID:" and the ID, on their own
// line under a failure that has room for one, otherwise after its one line of text.
export const requestIdText = (requestId: string) => `Request ID: ${requestId}`;
export const requestIdLine = (requestId: string) =>
  element("p", { className: "request-id" }, requestIdText(requestId));
export const withRequestId = (text: string, requestId: string | undefined) =>
  requestId ? `${text} ${requestIdText(requestId)}` : text;

/**
 * Gives a feedback line that switches between a quiet hint and a refusal its look: a status
 * block in `tone`, or `fallback` (the hint class) when `tone` is null. It replaces the whole
 * class list, so use it only on a line with no component class of its own. A line that
 * announces (role status or alert) becomes an alert in the danger and warning tones and a status
 * otherwise, as `statusBlock` does; set the tone before writing the text, so the text arrives in
 * an alert (finding 2005).
 */
export function setStatusTone(node: HTMLElement, tone: StatusTone | null, fallback = "hint") {
  const role = node.getAttribute("role");
  if (role === "status" || role === "alert") {
    const shownRole = statusRole(tone);
    if (role !== shownRole) {
      node.setAttribute("role", shownRole);
    }
  }
  const className = tone ? "status" : fallback;
  if (node.className !== className) {
    node.className = className;
  }
  if (tone) {
    if (node.dataset.tone !== tone) {
      node.dataset.tone = tone;
    }
  } else if (node.hasAttribute("data-tone")) {
    node.removeAttribute("data-tone");
  }
}

/**
 * A refusal after a request: the block takes focus and scrolls into view, so it is not read as
 * progress below the fold (findings 1862, 1864). Focus the reader moved elsewhere stays there.
 */
export function revealStatus(node: HTMLElement | null | undefined, root: Element = document.body) {
  const active = document.activeElement;
  if (
    !node?.isConnected ||
    !node.textContent ||
    (active && active !== document.body && !root.contains(active))
  ) {
    return;
  }
  node.tabIndex = -1;
  node.focus({ preventScroll: true });
  node.scrollIntoView({ block: "nearest" });
}
