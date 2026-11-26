import type { ConnectionTemplate } from "@openclaw-enterprise/contracts";
import { button, element, field } from "./dom.mjs";

export type OAuthTemplate = ConnectionTemplate & {
  readonly current: Extract<ConnectionTemplate["current"], { mode: "manual" | "mcp_discovery" }>;
};

export function isOAuthTemplate(template: ConnectionTemplate): template is OAuthTemplate {
  return template.current.mode === "manual" || template.current.mode === "mcp_discovery";
}

export type ConsentStart = { authorizationUrl: string; expiresAt: string };
export type ConsentResult =
  { outcome: "saved"; sourceId: string } | { outcome: "failed"; reason?: string };

const consentKey = "oce.pluginAccountConsent";
const consentStateKey = `${consentKey}.stateHash`;
const failures: Record<string, string> = {
  consent_denied: "Authorization was declined. Try again to connect the account.",
  session_required: "Sign in to OCE, then try connecting the account again.",
  invalid_session:
    "OCE could not verify this sign-in attempt. Try again from the same signed-in browser.",
  client_refused:
    "The provider rejected the OAuth client. Ask an administrator to check its registration.",
  exchange_refused:
    "The provider rejected the token exchange. Ask an administrator to check the OAuth client and token endpoint.",
  grant_scope_mismatch:
    "OCE could not accept the provider's granted scopes. Ask an administrator to check the callback audit.",
};

export function consentFailureMessage(reason: string | undefined): string | undefined {
  return reason ? failures[reason] : undefined;
}

/** Failure redirects may offer retry. Success is sent only by the verified callback response. */
export function finishConsentTab() {
  const url = new URL(location.href);
  const connection = url.searchParams.get("connection");
  if (connection !== "failed") {
    return false;
  }
  let name: string | null;
  try {
    name = sessionStorage.getItem(consentKey);
    sessionStorage.removeItem(consentKey);
    sessionStorage.removeItem(consentStateKey);
  } catch {
    return false;
  }
  if (!name) {
    return false;
  }
  const reason = url.searchParams.get("reason");
  const result: ConsentResult = {
    outcome: "failed",
    ...(reason && Object.hasOwn(failures, reason) ? { reason } : {}),
  };
  const channel = new BroadcastChannel(name);
  channel.postMessage(result);
  channel.close();
  document.body.replaceChildren(
    element(
      "p",
      { role: "status" },
      "Return to the original Console tab to check your connection.",
    ),
  );
  window.close();
  return true;
}

export async function authorizeInNewTab(
  begin: () => Promise<ConsentStart>,
  signal: AbortSignal,
  waiting: () => void,
): Promise<ConsentResult> {
  const tab = window.open("about:blank", "_blank");
  if (!tab) {
    throw new Error("Allow pop-ups for this Console, then try again.");
  }
  const name = `${consentKey}.${crypto.randomUUID()}`;
  const channel = new BroadcastChannel(name);
  const closeOnAbort = () => tab.close();
  signal.addEventListener("abort", closeOnAbort, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    tab.opener = null;
    tab.sessionStorage.setItem(consentKey, name);
    tab.document.title = "Account sign-in";
    tab.document.body.textContent = "Opening your provider…";
    const start = await begin();
    const provider = new URL(start.authorizationUrl);
    const deadline = Date.parse(start.expiresAt);
    const state = provider.searchParams.get("state");
    if (
      provider.protocol !== "https:" ||
      provider.username ||
      provider.password ||
      !Number.isFinite(deadline) ||
      !state
    ) {
      throw new Error("The provider returned an invalid authorization URL or expiry.");
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state));
    tab.sessionStorage.setItem(
      consentStateKey,
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
    if (signal.aborted || tab.closed) {
      throw new Error("Sign-in was closed. Try again to connect the account.");
    }
    return await new Promise<ConsentResult>((resolve, reject) => {
      channel.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (!data || typeof data !== "object") {
          return;
        }
        const result = data as Partial<ConsentResult>;
        if (
          result.outcome === "saved" &&
          typeof result.sourceId === "string" &&
          result.sourceId.length > 0
        ) {
          resolve({ outcome: "saved", sourceId: result.sourceId });
        } else if (result.outcome === "failed") {
          resolve({
            outcome: "failed",
            ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
          });
        }
      };
      signal.addEventListener(
        "abort",
        () => reject(new Error("Sign-in was cancelled. Try again to connect the account.")),
        { once: true },
      );
      timeout = setTimeout(
        () => reject(new Error("Authorization expired. Try again to connect the account.")),
        Math.max(0, deadline - Date.now()),
      );
      tab.location.replace(provider.href);
      waiting();
    });
  } finally {
    signal.removeEventListener("abort", closeOnAbort);
    clearTimeout(timeout);
    channel.close();
    tab.close();
  }
}

export function scopeChoices(
  template: OAuthTemplate,
  update: (selected: string[] | null | undefined) => void,
) {
  const version = template.current;
  const unrestricted = version.scopes.length === 0;
  const offered = unrestricted
    ? (version.observed?.supportedScopes ?? version.observed?.requestedScopes ?? [])
    : version.scopes;
  const fixed = version.mode === "manual" && !unrestricted;
  const required = new Set(
    version.mode === "mcp_discovery" ? (version.observed?.requestedScopes ?? []) : [],
  );
  const incompatible =
    !unrestricted && [...required].some((scope) => !version.scopes.includes(scope));
  const scopes = [...new Set([...required, ...offered])];
  const fieldset = element(
    "fieldset",
    { className: "connection-template-fields stack" },
    element("legend", {}, "Permissions for this connection"),
  );
  const choices = scopes.map((scope) => {
    const checkbox = element("input", { type: "checkbox", value: scope });
    checkbox.checked = true;
    checkbox.disabled = fixed || required.has(scope);
    fieldset.append(
      element(
        "label",
        { className: "plugin-toggle" },
        checkbox,
        checkbox.disabled ? `${scope} (required)` : scope,
      ),
    );
    return checkbox;
  });
  const toggle = button(
    "Unselect all",
    () => {
      const select = choices.some((choice) => !choice.disabled && !choice.checked);
      for (const choice of choices.filter((choice) => !choice.disabled)) {
        choice.checked = select;
      }
      change();
    },
    { size: "sm" },
  );
  if (choices.some((choice) => !choice.disabled)) {
    fieldset.insertBefore(
      element("div", { className: "form-actions" }, toggle),
      fieldset.children[1] ?? null,
    );
  }
  const extra = unrestricted
    ? element("input", { type: "text", spellcheck: "false", autocomplete: "off" })
    : undefined;
  if (extra) {
    fieldset.append(
      field({
        label: "Additional scopes",
        control: extra,
        help: "Separate scope names with spaces. Leave empty to use provider defaults.",
      }),
    );
    extra.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
      }
    });
  }
  if (incompatible) {
    fieldset.append(
      element(
        "p",
        { className: "hint" },
        "The server requires a scope outside this Template's approved scopes. Ask an administrator to update it.",
      ),
    );
  }
  function change() {
    toggle.textContent = choices
      .filter((choice) => !choice.disabled)
      .every((choice) => choice.checked)
      ? "Unselect all"
      : "Select all";
    const selected = [
      ...new Set([
        ...choices.filter((choice) => choice.checked).map((choice) => choice.value),
        ...(extra?.value.trim().split(/\s+/).filter(Boolean) ?? []),
      ]),
    ];
    const invalid = selected.some(
      (scope) => scope.length > 512 || !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope),
    );
    extra?.setCustomValidity(invalid ? "Enter valid OAuth scope names." : "");
    update(
      fixed
        ? undefined
        : incompatible ||
            invalid ||
            (!unrestricted && selected.length === 0) ||
            [...required].some((scope) => !selected.includes(scope))
          ? null
          : selected,
    );
  }
  fieldset.addEventListener("input", change);
  change();
  return fieldset;
}
