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

/** Replaces `parent`'s children with `children` (elements) unless they render the same markup. */
export function replaceChildrenIfChanged(parent, children) {
  if (parent.innerHTML !== children.map((child) => child.outerHTML).join("")) {
    parent.replaceChildren(...children);
  }
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
