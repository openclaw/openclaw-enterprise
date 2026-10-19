// Every value received from the API is inserted as text, never as HTML.
export function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "className") {
      node.className = value;
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
export function setText(node, text) {
  if (node.textContent !== text) {
    node.textContent = text;
  }
}

/** Sets `hidden` only when it changes: rewriting the same value is still a DOM mutation. */
export function setHidden(node, hidden) {
  if (node.hidden !== hidden) {
    node.hidden = hidden;
  }
}

/** Replaces `parent`'s children with `children` (elements) unless they render the same markup. */
export function replaceChildrenIfChanged(parent, children) {
  if (parent.innerHTML !== children.map((child) => child.outerHTML).join("")) {
    parent.replaceChildren(...children);
  }
}

// A live region or alert announces reliably when it is inserted, not when an existing node takes
// its role, so a node whose role (or the kind of a role node) changes is replaced instead.
function sameRole(shown, child) {
  const role = child.getAttribute("role");
  return (
    shown.getAttribute("role") === role && (role === null || shown.className === child.className)
  );
}

/**
 * Makes `parent`'s children match `children` (nodes; null and undefined skipped), changing only
 * what differs: an unchanged render touches no node, and a changed one rewrites only the changed
 * text and attributes, position by position (finding 1598). A kept node keeps its listeners, so
 * use this only where a rebuilt node would get the same handlers. Returns whether it changed
 * anything.
 */
export function patchChildren(parent, children) {
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
      (child.nodeType === Node.ELEMENT_NODE && !sameRole(shown, child))
    ) {
      shown.replaceWith(child);
      changed = true;
    } else if (shown.nodeType !== Node.ELEMENT_NODE) {
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
      for (const name of child.getAttributeNames()) {
        if (shown.getAttribute(name) !== child.getAttribute(name)) {
          shown.setAttribute(name, child.getAttribute(name));
        }
      }
      patchChildren(shown, [...child.childNodes]);
    }
  }
  while (parent.childNodes.length > next.length) {
    parent.lastChild.remove();
    changed = true;
  }
  return changed;
}

/**
 * The class list for the button hierarchy (UX plan C2, console.css "Button hierarchy"): `tone` is
 * "primary" (at most one per view), "secondary", "ghost", "danger" or "link", and `size` "sm" is
 * the toolbar size. `className` adds a component's own class.
 */
function buttonClass({ tone, size, className } = {}) {
  return [
    ...(tone || size ? ["button"] : []),
    ...(tone ? [`button--${tone}`] : []),
    ...(size ? [`button--${size}`] : []),
    ...(className ? [className] : []),
  ].join(" ");
}

/** A button; `tone` and `size` pick its place in the hierarchy (see buttonClass). */
export function button(label, action, { tone, size, ...attributes } = {}) {
  const className = buttonClass({ tone, size, className: attributes.className });
  const node = element(
    "button",
    { type: "button", ...attributes, ...(className ? { className } : {}) },
    label,
  );
  node.addEventListener("click", action);
  return node;
}

export function dismissOnBackdrop(dialog) {
  let startedOnBackdrop = false;
  const isBackdrop = (event) => {
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

let describedFocusIds = 0;

/**
 * After a save the pressed button is disabled or rebuilt, so focus falls to body. Unless the
 * reader has moved on (focus left `root`), put it on the first enabled `controls` entry,
 * described by `message`, or on `message` itself (findings 1446, 1481).
 */
export function focusSaveOutcome(root, controls, message) {
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
export function jsonObjectProblem(text) {
  let parsed;
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
    const unseen = UNSEEN_CHARACTERS[text[offset]];
    if (offset === 0 && unseen) {
      return `Invalid JSON: remove the ${unseen} at the start. Enter a valid JSON object.`;
    }
    const lines = text.slice(0, offset).split(/\r\n?|\n/);
    const where = `line ${lines.length}, column ${visibleLength(lines.at(-1)) + 1}`;
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
export function jsonErrorOffset(text) {
  const end = text.length;
  const containers = [];
  let i = 0;
  // "value", "key", "value-or-close" just after "[", "key-or-close" just after "{", or "after" a
  // complete value.
  let expect = "value";
  const skipWhitespace = () => {
    while (i < end && " \t\n\r".includes(text[i])) {
      i += 1;
    }
  };
  const digits = () => {
    const start = i;
    while (i < end && text[i] >= "0" && text[i] <= "9") {
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
        } else if (i < end && '"\\/bfnrt'.includes(text[i])) {
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
  const literal = (word) => {
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
    const character = text[i];
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
      const word = { t: "true", f: "false", n: "null" }[character];
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

const UNSEEN_CHARACTERS = {
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
function visibleLength(line) {
  if (/^[\t -~]*$/.test(line)) {
    return line.length;
  }
  const pieces = graphemes
    ? Array.from(graphemes.segment(line), ({ segment }) => segment)
    : Array.from(line);
  return pieces.filter((piece) => !INVISIBLE.test(piece)).length;
}

// A persistent error under a form control, linked to it with aria-describedby and aria-invalid,
// in place of the browser's transient validation bubble (finding 1903).
export function fieldError(input) {
  const id = `${input.id}-error`;
  const node = element("p", { className: "error field-error", id, hidden: true });
  const others = () =>
    (input.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .filter((value) => value && value !== id);
  return {
    node,
    show(text) {
      node.textContent = text;
      node.hidden = false;
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", [id, ...others()].join(" "));
    },
    clear() {
      if (node.hidden) {
        return;
      }
      node.textContent = "";
      node.hidden = true;
      input.removeAttribute("aria-invalid");
      const describedBy = others().join(" ");
      if (describedBy) {
        input.setAttribute("aria-describedby", describedBy);
      } else {
        input.removeAttribute("aria-describedby");
      }
    },
  };
}

const STATUS_ALERT_TONES = new Set(["danger", "warning"]);

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
  tone,
  label,
  body,
  actions = [],
  { className, role, ...attributes } = {},
) {
  const shownRole = role === undefined ? (STATUS_ALERT_TONES.has(tone) ? "alert" : "status") : role;
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

/**
 * Gives a feedback line that switches between a quiet hint and a refusal its look: a status
 * block in `tone`, or `fallback` (the hint class) when `tone` is null.
 */
export function setStatusTone(node, tone, fallback = "hint") {
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
export function revealStatus(node, root = document.body) {
  const active = document.activeElement;
  if (
    !node?.isConnected ||
    !node.textContent ||
    (active && active !== document.body && !active.disabled && !root.contains(active))
  ) {
    return;
  }
  node.tabIndex = -1;
  node.focus({ preventScroll: true });
  node.scrollIntoView({ block: "nearest" });
}
