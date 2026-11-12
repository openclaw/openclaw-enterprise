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
  const theme = () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  const reference = Scalar.createApiReference(root, {
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
    darkMode: theme() === "dark",
    forceDarkModeState: theme(),
    hideDarkModeToggle: true,
    hideClientButton: true,
    // Scalar defaults to Shell/curl. Reapplying an explicit default would reset
    // the reader's selected client whenever the theme configuration changes.
  });
  const syncTheme = () => {
    const mode = theme();
    const configuration = reference.getConfiguration();
    if (configuration.forceDarkModeState !== mode) {
      reference.updateConfiguration({
        ...configuration,
        darkMode: mode === "dark",
        forceDarkModeState: mode,
      });
    }
    // Scalar also styles the body, including after a system color-scheme change.
    // Keep that class aligned without remounting the explorer or losing request state.
    for (const value of ["dark", "light"]) {
      const className = `${value}-mode`;
      if (document.body.classList.contains(className) !== (value === mode)) {
        document.body.classList.toggle(className, value === mode);
      }
    }
  };
  const themeObserver = new MutationObserver(syncTheme);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  syncTheme();
}
