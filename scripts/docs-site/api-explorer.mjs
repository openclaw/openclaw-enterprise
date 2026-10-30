/* global Scalar */
// Scalar reserves "api-reference" for automatic initialization.
const root = document.getElementById("occ-api-explorer");
if (root) {
  const header = document.querySelector("body > header");
  const updateHeaderOffset = () => {
    root.style.setProperty(
      "--scalar-custom-header-height",
      `${header.getBoundingClientRect().height}px`,
    );
  };
  updateHeaderOffset();
  new ResizeObserver(updateHeaderOffset).observe(header);
  Scalar.createApiReference(root, {
    url: "/assets/occ-api.openapi.json",
    servers: [
      {
        url: "http://127.0.0.1:3000",
        description: "Local OCC; replace with your Installation origin",
      },
    ],
    persistAuth: false,
    authentication: { preferredSecurityScheme: "serviceApiKey" },
    agent: { disabled: true },
    mcp: { disabled: true },
    proxyUrl: "",
    withDefaultFonts: false,
    showDeveloperTools: "never",
    theme: "default",
    darkMode: document.documentElement.dataset.theme === "dark",
    hideClientButton: true,
    defaultHttpClient: { targetKey: "shell", clientKey: "curl" },
  });
}
