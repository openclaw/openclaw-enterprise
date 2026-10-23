import { scenarios } from "./public/scenarios.mjs";

// Injected by the Storybook build from the prepared static assets.
declare const __CONSOLE_STORY_BUILD__: string;

type StoryScenario = {
  name: string;
  description: string;
  steps?: readonly string[];
  gap?: string;
  nextStory?: string;
  mobile?: boolean;
  theme?: string;
};

// Some scenario IDs are generated. Check the preview fields here, then resolve IDs at runtime.
const catalog: Readonly<Record<string, StoryScenario>> = scenarios;

function getScenario(id: string) {
  const scenario = catalog[id];
  if (!scenario) {
    throw new Error(`Unknown Console story scenario: ${id}`);
  }
  return scenario;
}

function fixtureUrl(id: string, theme?: string) {
  const page = theme === "long-name" ? "frame-long-name" : theme ? "frame-themed" : "frame";
  return `/storybook-fixtures/${page}.html?story=${encodeURIComponent(id)}&v=${__CONSOLE_STORY_BUILD__}`;
}

type PreviewOptions = { frameWidth?: `${number}px`; name?: string; instructions?: string };

export function story(id: string, options: PreviewOptions = {}) {
  const scenario = getScenario(id);
  const name = options.name ?? scenario.name;
  const frameWidth = options.frameWidth ?? (scenario.mobile ? "390px" : "1600px");
  return {
    name,
    render() {
      const root = document.createElement("section");
      root.style.cssText = "font:14px/1.5 system-ui;color:#403c35;background:#faf9f7;padding:20px";
      const heading = document.createElement("h1");
      heading.textContent = name;
      const description = document.createElement("p");
      description.textContent = scenario.description;
      const boundary = document.createElement("p");
      boundary.textContent =
        "Real console components · simulated API and runtime state · disposable data. Never enter real credentials.";
      boundary.style.fontWeight = "600";
      root.append(heading, description, boundary);
      if (scenario.steps) {
        const steps = document.createElement("ol");
        for (const text of scenario.steps) {
          const item = document.createElement("li");
          item.textContent = text;
          steps.append(item);
        }
        root.append(steps);
      }
      if (scenario.gap) {
        const gap = document.createElement("p");
        gap.textContent = `UI gap: ${scenario.gap}`;
        gap.style.cssText = "padding:12px;border:1px solid #bd7f23;background:#fff3d6";
        root.append(gap);
      }
      if (scenario.nextStory) {
        const next = getScenario(scenario.nextStory);
        const nextLink = document.createElement("a");
        nextLink.href = fixtureUrl(scenario.nextStory, next.theme);
        nextLink.target = "_blank";
        nextLink.rel = "noopener noreferrer";
        nextLink.textContent = `Next segment: ${next.name}`;
        nextLink.style.cssText = "display:inline-block;margin:0 0 12px;font-weight:700";
        root.append(nextLink);
      }
      const frame = document.createElement("iframe");
      frame.title = `${scenario.name}: interactive console`;
      const src = fixtureUrl(id, scenario.theme);
      frame.src = src;
      frame.style.cssText = `display:block;width:100%;max-width:${frameWidth};height:min(900px, calc(100vh - 80px));min-height:480px;border:1px solid #d6d0c5;background:white`;
      frame.setAttribute(
        "sandbox",
        "allow-scripts allow-same-origin allow-forms allow-modals allow-popups",
      );
      const reset = document.createElement("button");
      reset.textContent = "Reset story";
      reset.style.cssText = "padding:8px 16px;margin:0 0 12px;cursor:pointer";
      reset.addEventListener("click", () => {
        frame.src = src;
      });
      root.append(reset);
      if (options.instructions) {
        const instructions = document.createElement("p");
        instructions.textContent = options.instructions;
        root.append(instructions);
      }
      root.append(frame);
      return root;
    },
  };
}
