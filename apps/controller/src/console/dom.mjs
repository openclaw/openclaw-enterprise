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

export function button(label, action, attributes = {}) {
  const node = element("button", { type: "button", ...attributes }, label);
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
// column the browser's parser stopped at, so a long Configuration can be fixed in place
// (finding 1903).
export function jsonObjectProblem(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (!text.trim()) {
      return "Enter a valid JSON object.";
    }
    const where = jsonErrorPosition(text, error);
    return where
      ? `Invalid JSON at line ${where.line}, column ${where.column}. Enter a valid JSON object.`
      : "Invalid JSON. Enter a valid JSON object.";
  }
  return parsed === null || Array.isArray(parsed) || typeof parsed !== "object"
    ? "Enter a valid JSON object, not an array or a single value."
    : undefined;
}

// Chromium names an offset (and newer builds its line and column), Firefox a line and column;
// an early end may have neither. The patterns are anchored to the message's own wording, so JSON
// the reader typed, which Chromium quotes in "Unexpected token" messages, is never read as one.
function jsonErrorPosition(text, error) {
  const message = String(error?.message ?? "");
  const chromium = / in JSON at position (\d+)(?: \(line (\d+) column (\d+)\))?$/.exec(message);
  const firefox = / at line (\d+) column (\d+) of the JSON data$/.exec(message);
  if (chromium?.[2]) {
    return { line: Number(chromium[2]), column: Number(chromium[3]) };
  }
  if (firefox) {
    return { line: Number(firefox[1]), column: Number(firefox[2]) };
  }
  const offset = chromium
    ? Number(chromium[1])
    : /^(Unexpected end of JSON input|JSON\.parse: (unexpected )?end of data)/.test(message)
      ? text.length
      : undefined;
  if (offset === undefined) {
    return undefined;
  }
  const lines = text.slice(0, offset).split("\n");
  return { line: lines.length, column: lines.at(-1).length + 1 };
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
