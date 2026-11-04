import type { PluginFieldsOptions } from "/console/agents/plugin-fields.mjs";
import type { StoryAction } from "../story-action.mts";
import { scenarios } from "./scenarios.mts";
import { installFixture } from "./fixtures.mts";

interface FrameScenarioBase {
  name: string;
  buildRevision?: string | undefined;
  path?: string | undefined;
  clipboard?: string | undefined;
  actions?: readonly StoryAction[] | undefined;
  scrollToTabs?: boolean | undefined;
}

type FrameScenario = FrameScenarioBase &
  Parameters<typeof installFixture>[0] &
  (
    | { component?: undefined }
    | {
        component: "plugins";
        pluginSelections?: string | undefined;
        pluginCatalog?: PluginFieldsOptions["catalog"];
        pluginCapabilities?: PluginFieldsOptions["capabilities"];
        disabled?: boolean | undefined;
      }
  );

type RequestEvidence = { method: string; path: string };

interface FrameEvidence {
  id: string;
  requests: RequestEvidence[];
  directoryResponses: {
    kind: "users" | "channels";
    query: string;
    cursor: string | null;
    ids: string[] | null;
  }[];
  unhandled: RequestEvidence[];
  ready: boolean;
  error: string | null;
}

function actionTarget({ text, selector, click }: StoryAction) {
  if (text) {
    return Array.from(document.querySelectorAll("body *")).find(
      (item) => item.childElementCount === 0 && item.textContent?.includes(text),
    );
  }
  if (selector) {
    return document.querySelector(selector);
  }
  return Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === click,
  );
}

function hasValue(
  node: Element,
): node is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  return (
    node instanceof HTMLInputElement ||
    node instanceof HTMLSelectElement ||
    node instanceof HTMLTextAreaElement
  );
}

function isDisabled(node: Element) {
  return "disabled" in node && Boolean(node.disabled);
}

const catalog: Readonly<Record<string, FrameScenario>> = scenarios;
const id = new URL(location.href).searchParams.get("story");
const scenario = id !== null && Object.hasOwn(catalog, id) ? catalog[id] : undefined;
if (id === null || scenario === undefined) {
  throw new Error(`Unknown console story: ${id}`);
}
const evidence: FrameEvidence = {
  id,
  requests: [],
  directoryResponses: [],
  unhandled: [],
  ready: false,
  error: null,
};
Object.assign(window, { __consoleStory: evidence });
installFixture(scenario, evidence);
// Simulated build metadata; deployed images bake this meta tag into their HTML.
const buildRevision = document.createElement("meta");
buildRevision.name = "occ-build-revision";
buildRevision.content = scenario.buildRevision ?? "";
document.head.append(buildRevision);
history.replaceState(
  null,
  "",
  scenario.path ?? "/console/agents?namespace=ns_00000000-0000-4000-8000-000000000001",
);
// Simulates a browser without clipboard access (an http origin), where copy buttons fall back.
if (scenario.clipboard === "unavailable") {
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
}
// Focus the isolated preview before the console registers its focus-refresh handler.
// Otherwise the first interaction can reset a preselected Preset before it becomes a form.
window.focus();
if (scenario.component === "plugins") {
  // Isolated previews pass fixture catalogs and capabilities to the real component.
  const { createPluginFields } = await import("/console/agents/plugin-fields.mjs");
  const input = document.createElement("textarea");
  input.id = "agent-plugins";
  input.rows = 6;
  input.spellcheck = false;
  input.value = scenario.pluginSelections ?? "{}";
  const fields = createPluginFields({
    input,
    catalog: scenario.pluginCatalog ?? null,
    capabilities: scenario.pluginCapabilities ?? null,
  });
  const panel = document.createElement("section");
  panel.className = "agent-card agent-form";
  panel.append(fields.section);
  const root = document.querySelector("#app");
  if (!root) {
    throw new Error("Story preview requires an #app element");
  }
  root.replaceChildren(panel);
  fields.setDisabled(scenario.disabled ?? false);
} else {
  await import("/console/console.mjs");
}

// Prepare open drawers and validation states by operating the real UI, not editing its markup.
try {
  for (const action of scenario.actions ?? []) {
    const deadline = Date.now() + 10000;
    let node: Element | null | undefined;
    while (Date.now() < deadline) {
      node = actionTarget(action);
      if (
        node &&
        !isDisabled(node) &&
        !node.closest("[hidden]") &&
        (action.matches === undefined || ("value" in node && node.value === action.matches))
      ) {
        break;
      }
      node = undefined;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    if (!node || isDisabled(node) || node.closest("[hidden]")) {
      throw new Error(`Story action unavailable: ${JSON.stringify(action)}`);
    }
    if (action.focus) {
      if (!(node instanceof HTMLElement || node instanceof SVGElement)) {
        throw new Error(`Story action cannot focus its target: ${JSON.stringify(action)}`);
      }
      node.focus();
    }
    if (action.click) {
      if (!(node instanceof HTMLElement)) {
        throw new Error(`Story action cannot click its target: ${JSON.stringify(action)}`);
      }
      node.click();
    }
    if (action.value !== undefined) {
      if (!hasValue(node)) {
        throw new Error(`Story action target has no editable value: ${JSON.stringify(action)}`);
      }
      if (node.getAttribute("role") === "combobox" && !node.closest(".slack-directory-field")) {
        node.focus();
        node.value = action.value === "__openclaw_create_secret__" ? "" : action.value;
        node.dispatchEvent(new Event("input", { bubbles: true }));
        let option: Element | undefined;
        while (Date.now() < deadline) {
          const controls = node.getAttribute("aria-controls");
          const menu = controls === null ? null : document.getElementById(controls);
          option = Array.from(menu?.querySelectorAll('[role="option"]') ?? []).find((item) =>
            action.value === "__openclaw_create_secret__"
              ? item.classList.contains("secret-typeahead-create")
              : !item.classList.contains("secret-typeahead-create"),
          );
          if (option) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        if (!(option instanceof HTMLElement)) {
          throw new Error(`Story Secret option unavailable: ${JSON.stringify(action)}`);
        }
        option.click();
        continue;
      }
      if (node instanceof HTMLSelectElement) {
        while (
          Date.now() < deadline &&
          !Array.from(node.options).some((option) => option.value === action.value)
        ) {
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        if (!Array.from(node.options).some((option) => option.value === action.value)) {
          throw new Error(`Story select option unavailable: ${JSON.stringify(action)}`);
        }
      }
      node.value = action.value;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (action.key) {
      node.dispatchEvent(
        new KeyboardEvent("keydown", { key: action.key, bubbles: true, cancelable: true }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (scenario.scrollToTabs !== false && scenario.path?.includes("tab=")) {
    document.querySelector(".agent-tabs")?.scrollIntoView({ block: "start" });
  }
  evidence.ready = true;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  evidence.error = message;
  const notice = document.createElement("p");
  notice.setAttribute("role", "alert");
  notice.textContent = `Story setup failed: ${message}`;
  document.body.prepend(notice);
  throw error;
}
