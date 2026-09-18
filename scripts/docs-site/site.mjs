import "./compute-matrix-browser.mjs";

const menu = document.querySelector("#menu");
menu.addEventListener("click", () => {
  const open = document.querySelector("#sidebar").classList.toggle("open");
  menu.setAttribute("aria-expanded", String(open));
});
const themeButton = document.querySelector("#theme");
let theme = localStorage.getItem("enterprise-docs-theme") ?? "dark";
document.documentElement.dataset.theme = theme;
themeButton.addEventListener("click", () => {
  theme = theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("enterprise-docs-theme", theme);
  renderDiagrams();
});
const dialog = document.querySelector("#search-dialog");
let search;
function openSearch() {
  if (!dialog.open) {
    dialog.showModal();
  }
  if (!search && window.PagefindUI) {
    search = new window.PagefindUI({ element: "#search", showSubResults: true, showImages: false });
  }
  dialog.querySelector("input")?.focus();
}
document.querySelector("#search-open").addEventListener("click", openSearch);
document.querySelector("#search-close").addEventListener("click", () => dialog.close());
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openSearch();
  }
});
document.querySelectorAll("[data-code-copy]").forEach((button) =>
  button.addEventListener("click", async () => {
    const code = [...button.closest("figure").querySelectorAll(".code-line")]
      .map((line) => line.textContent)
      .join("\n");
    await navigator.clipboard.writeText(code);
    button.setAttribute("aria-label", "Copied");
  }),
);
document.querySelectorAll("[data-heading-anchor]").forEach((button) =>
  button.addEventListener("click", async () => {
    const url = new URL(location.href);
    url.hash = button.dataset.headingAnchor;
    await navigator.clipboard.writeText(url.href);
  }),
);
const diagramDialog = document.querySelector("#diagram-dialog");
document.querySelector("#diagram-close").addEventListener("click", () => diagramDialog.close());
let diagramVersion = 0;
async function renderDiagrams() {
  const diagrams = document.querySelectorAll("[data-mermaid]");
  if (!diagrams.length) {
    return;
  }
  const version = ++diagramVersion;
  const { default: mermaid } = await import("./mermaid/mermaid.esm.min.mjs");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: theme === "dark" ? "dark" : "default",
    maxTextSize: 100000,
  });
  for (let index = 0; index < diagrams.length; index++) {
    const diagram = diagrams[index];
    try {
      const { svg } = await mermaid.render(
        "diagram-" + version + "-" + index,
        diagram.dataset.mermaid,
      );
      if (version !== diagramVersion) {
        return;
      }
      diagram.innerHTML =
        '<button type="button" class="diagram-expand">Expand diagram</button>' + svg;
      diagram.querySelector(".diagram-expand").addEventListener("click", () => {
        const expanded = diagram.querySelector("svg").cloneNode(true);
        expanded.style.width = expanded.getAttribute("viewBox").split(" ")[2] + "px";
        expanded.style.maxWidth = "none";
        document.querySelector("#diagram-canvas").replaceChildren(expanded);
        if (!diagramDialog.open) {
          diagramDialog.showModal();
        }
      });
    } catch (error) {
      console.error("Mermaid rendering failed", error);
      diagram.classList.add("diagram-error");
    }
  }
}
await renderDiagrams();
