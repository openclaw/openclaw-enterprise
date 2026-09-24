import { scenarios } from "./public/scenarios.mjs";

export function story(id) {
  const scenario = scenarios[id];
  return {
    name: scenario.name,
    render() {
      const root = document.createElement("section");
      root.style.cssText = "font:14px/1.5 system-ui;color:#403c35;background:#faf9f7;padding:20px";
      const heading = document.createElement("h1");
      heading.textContent = scenario.name;
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
        const next = scenarios[scenario.nextStory];
        const nextLink = document.createElement("a");
        nextLink.href = `/storybook-fixtures/frame.html?story=${encodeURIComponent(scenario.nextStory)}`;
        nextLink.target = "_blank";
        nextLink.rel = "noopener noreferrer";
        nextLink.textContent = `Next segment: ${next.name}`;
        nextLink.style.cssText = "display:inline-block;margin:0 0 12px;font-weight:700";
        root.append(nextLink);
      }
      const frame = document.createElement("iframe");
      frame.title = `${scenario.name}: interactive console`;
      frame.src = `/storybook-fixtures/frame.html?story=${encodeURIComponent(id)}`;
      frame.style.cssText = `display:block;width:100%;max-width:${scenario.mobile ? "390px" : "1600px"};height:min(900px, calc(100vh - 80px));min-height:480px;border:1px solid #d6d0c5;background:white`;
      frame.setAttribute(
        "sandbox",
        "allow-scripts allow-same-origin allow-forms allow-modals allow-popups",
      );
      const reset = document.createElement("button");
      reset.textContent = "Reset story";
      reset.style.cssText = "padding:8px 16px;margin:0 0 12px;cursor:pointer";
      reset.addEventListener("click", () => {
        frame.src = `/storybook-fixtures/frame.html?story=${encodeURIComponent(id)}`;
      });
      root.append(reset, frame);
      return root;
    },
  };
}
