// The preview provider and API fixture share an origin. Only the production callback
// notifies the original plugin editor, which rereads the saved Agent or the new Agent’s compatible accounts.
const params = new URL(location.href).searchParams;
const attempt = params.get("attempt");
const approved = params.has("standalone") ? "connected" : "attached";
if (approved === "connected") {
  document.querySelector("#purpose")!.textContent =
    "Save a test account to your Namespace. You can grant an Agent access when you create it.";
}
if (attempt && /^storybook\.pluginConsent\.[a-f0-9-]{36}$/.test(attempt)) {
  async function finish(outcome: "attached" | "connected" | "failed") {
    if (outcome !== "failed") {
      localStorage.setItem(attempt!, outcome);
    }
    history.replaceState(null, "", "/console/?connection=" + outcome);
    const callbackModule = "/console/agents/plugin-connection.mjs";
    const { finishPluginConsentTab } = await import(callbackModule);
    finishPluginConsentTab();
  }
  document.querySelector("#approve")?.addEventListener("click", () => void finish(approved));
  document.querySelector("#cancel")?.addEventListener("click", () => void finish("failed"));
}

export {};
