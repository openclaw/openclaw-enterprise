// The preview provider and API fixture share an origin. Only the production callback
// notifies the original plugin editor, which rereads the saved Agent.
const attempt = new URL(location.href).searchParams.get("attempt");
if (attempt && /^storybook\.pluginConsent\.[a-f0-9-]{36}$/.test(attempt)) {
  async function finish(outcome: "attached" | "failed") {
    if (outcome === "attached") {
      localStorage.setItem(attempt!, outcome);
    }
    history.replaceState(null, "", "/console/?connection=" + outcome);
    const callbackModule = "/console/agents/plugin-connection.mjs";
    const { finishPluginConsentTab } = await import(callbackModule);
    finishPluginConsentTab();
  }
  document.querySelector("#approve")?.addEventListener("click", () => void finish("attached"));
  document.querySelector("#cancel")?.addEventListener("click", () => void finish("failed"));
}

export {};
