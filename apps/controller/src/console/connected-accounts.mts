import type { InstallationCapabilities } from "@openclaw-enterprise/contracts";
import { INSTALLATION_ADMINISTRATION, requestFailure, responseFields } from "./api-client.mjs";
import {
  createDeviceLogin,
  deviceLoginOffered,
  savedCodexAccounts,
  type DeviceLogin,
} from "./agents/device-login.mjs";
import { element } from "./dom.mjs";
import type { ConsolePageContext } from "./page-context.mjs";

export function renderConnectedAccounts(context: ConsolePageContext & { namespaceId: string }) {
  const names = element("ul", { className: "stack" });
  const status = element("p", { role: "status", className: "hint" }, "Loading accounts…");
  const section = element(
    "section",
    { className: "card" },
    element("h2", {}, "ChatGPT accounts"),
    names,
    status,
  );
  const draft = "connected-account-sign-in";
  let latestRequest = 0;
  async function refresh() {
    const current = ++latestRequest;
    try {
      const accounts = await savedCodexAccounts(context);
      if (current === latestRequest && context.isCurrent()) {
        names.replaceChildren(...accounts.map(({ label }) => element("li", {}, label)));
        status.textContent = accounts.length
          ? ""
          : "No saved ChatGPT accounts are available in this Namespace.";
      }
    } catch (cause) {
      if (current === latestRequest && context.isCurrent()) {
        names.replaceChildren();
        if (requestFailure(cause).status === 401) {
          context.onExpired();
        } else {
          status.textContent = "Saved ChatGPT accounts could not be loaded. Refresh to try again.";
        }
      }
    }
  }
  const login = createDeviceLogin({
    context,
    namespaceLogin: true,
    initial: context.drafts.get(draft) as DeviceLogin | null,
    hint: "Connect your personal ChatGPT account to use it with a Codex Agent in this Namespace.",
    onChange(source) {
      if (source) {
        void refresh();
      }
    },
  });
  context.drafts.track(draft, login.capture);
  context.drafts.unsavedWhen(draft, (value) =>
    Boolean(value && responseFields(value).status !== "ready"),
  );
  section.append(login.section);
  context.view.replaceChildren(section);
  void refresh();
  if (context.installationAdmin !== true) {
    return;
  }
  context.request("/installation", INSTALLATION_ADMINISTRATION).then(
    (installation) => {
      if (context.isCurrent()) {
        const { capabilities } = responseFields(installation);
        login.setOffered(deviceLoginOffered(capabilities as InstallationCapabilities));
      }
    },
    (cause: unknown) => {
      if (context.isCurrent() && requestFailure(cause).status === 401) {
        context.onExpired();
      }
    },
  );
}
