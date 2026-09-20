function renderError(message) {
  document
    .querySelector("#app")
    .replaceChildren(Object.assign(document.createElement("main"), { className: "auth" }));
  const main = document.querySelector("main");
  main.append(
    Object.assign(document.createElement("p"), {
      className: "brand",
      textContent: "OpenClaw Enterprise",
    }),
    Object.assign(document.createElement("h1"), { textContent: "Native admin unavailable" }),
    Object.assign(document.createElement("p"), { className: "muted", textContent: message }),
  );
}

function renderAuthorize(start) {
  const main = Object.assign(document.createElement("main"), { className: "auth" });
  const launch = Object.assign(document.createElement("button"), {
    className: "primary",
    type: "button",
    textContent: "Open native admin UI",
  });
  launch.addEventListener("click", () => {
    launch.disabled = true;
    void start().catch(() => {
      renderError("The native admin launch could not be completed.");
    });
  });
  main.append(
    Object.assign(document.createElement("p"), {
      className: "brand",
      textContent: "OpenClaw Enterprise",
    }),
    Object.assign(document.createElement("h1"), { textContent: "Open native admin UI" }),
    Object.assign(document.createElement("p"), {
      className: "muted",
      textContent:
        "Native admin access can change this gateway outside OCE. Do not change configuration here; use OCE. Native changes are not recorded in AgentRevisions and may be overwritten by deployment. You can access the conversations and credentials available to this gateway.",
    }),
    launch,
  );
  document.querySelector("#app").replaceChildren(main);
}

async function launch() {
  const params = new URLSearchParams(location.search);
  const namespaceId = params.get("namespace");
  const agentId = params.get("agent");
  const revisionId = params.get("revision");
  const host = params.get("host");
  const state = params.get("state");
  const challenge = params.get("challenge");
  if (![namespaceId, agentId, revisionId, host, state, challenge].every(Boolean)) {
    renderError("The native admin launch request is incomplete.");
    return;
  }
  renderAuthorize(async () => {
    const response = await fetch(
      `/namespaces/${encodeURIComponent(namespaceId)}/agents/${encodeURIComponent(agentId)}/native-admin/launch`,
      {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revisionId, host, state, challenge }),
      },
    );
    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok || typeof payload?.data?.url !== "string") {
      renderError(
        response.status === 401
          ? "Sign in again, then reopen native admin."
          : "The native admin launch was denied.",
      );
      return;
    }
    location.replace(payload.data.url);
  });
}

void launch().catch(() => {
  renderError("The native admin launch could not be completed.");
});
