import { scenarios } from "./scenarios.mjs";
import { installFixture } from "./fixtures.mjs";

const id = new URL(location.href).searchParams.get("story");
const scenario = scenarios[id];
if (!scenario) {
  throw new Error(`Unknown console story: ${id}`);
}
const evidence = { id, requests: [], unhandled: [], ready: false, error: null };
window.__consoleStory = evidence;
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
// Focus the isolated preview before the console registers its focus-refresh handler.
// Otherwise the first interaction can reset a preselected Preset before it becomes a form.
window.focus();
await import("/console/console.mjs");

// Prepare open drawers and validation states by operating the real UI, not editing its markup.
try {
  for (const action of scenario.actions ?? []) {
    const deadline = Date.now() + 10000;
    let node;
    while (Date.now() < deadline) {
      node = action.selector
        ? document.querySelector(action.selector)
        : [...document.querySelectorAll("button")].find(
            (item) => item.textContent.trim() === action.click,
          );
      if (node && !node.disabled && !node.closest("[hidden]")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    if (!node || node.disabled) {
      throw new Error(`Story action unavailable: ${JSON.stringify(action)}`);
    }
    if (action.click) {
      node.click();
    }
    if (action.value !== undefined) {
      if (node instanceof HTMLSelectElement) {
        while (
          Date.now() < deadline &&
          ![...node.options].some((option) => option.value === action.value)
        ) {
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        if (![...node.options].some((option) => option.value === action.value)) {
          throw new Error(`Story select option unavailable: ${JSON.stringify(action)}`);
        }
      }
      node.value = action.value;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (scenario.path?.includes("tab=")) {
    document.querySelector(".agent-tabs")?.scrollIntoView({ block: "start" });
  }
  evidence.ready = true;
} catch (error) {
  evidence.error = error.message;
  const notice = document.createElement("p");
  notice.setAttribute("role", "alert");
  notice.textContent = `Story setup failed: ${error.message}`;
  document.body.prepend(notice);
  throw error;
}
