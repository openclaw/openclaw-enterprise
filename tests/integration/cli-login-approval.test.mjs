import assert from "node:assert/strict";
import test from "node:test";
import { renderCliLogin } from "../../apps/controller/src/console/cli-login.mjs";

// A small DOM fixture lets the actual component's asynchronous event handlers run offline.
class Element {
  constructor(tag) {
    this.tag = tag;
    this.childNodes = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.value = "";
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  toggleAttribute(name, value) {
    if (value) {
      this.attributes.set(name, "");
    } else {
      this.attributes.delete(name);
    }
  }
  append(...children) {
    this.childNodes.push(...children);
  }
  replaceChildren(...children) {
    this.childNodes = children;
  }
  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }
  focus() {}
  fire(name) {
    return this.listeners.get(name)?.({ preventDefault() {} });
  }
}

function find(node, predicate) {
  if (typeof node === "string") {
    return undefined;
  }
  if (predicate(node)) {
    return node;
  }
  for (const child of node.childNodes) {
    const found = find(child, predicate);
    if (found) {
      return found;
    }
  }
}

test("CLI approval stays bound to the code submitted for review", async () => {
  globalThis.document = { createElement: (tag) => new Element(tag) };
  const view = new Element("main");
  const calls = [];
  let release;
  const lookup = new Promise((resolve) => {
    release = resolve;
  });
  const request = (path, options) => {
    calls.push({ path, body: structuredClone(options.body) });
    return path.endsWith("/lookup")
      ? lookup
      : Promise.resolve({ sessionExpiresAt: "2030-01-01T00:00:00Z" });
  };
  renderCliLogin(view, { request, isCurrent: () => true, onSessions() {} });
  const input = find(view, (node) => node.tag === "input");
  const form = find(view, (node) => node.tag === "form");
  input.value = "BCDF-GHJK";
  const pending = form.fire("submit");
  input.value = "LMNP-QRST";
  const duplicate = form.fire("submit");
  try {
    assert.equal(calls.length, 1);
  } finally {
    release({ clientLabel: "reviewed device", requesterAddress: "192.0.2.1", sameAddress: true });
    await Promise.all([pending, duplicate]);
  }
  const approve = find(
    view,
    (node) => node.tag === "button" && node.childNodes.includes("Approve"),
  );
  assert.ok(approve);
  approve.fire("click");
  assert.equal(calls[0].body.userCode, "BCDF-GHJK");
  assert.equal(calls[1].body.userCode, "BCDF-GHJK");
});
