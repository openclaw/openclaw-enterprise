import { requestFailure } from "./api-client.mjs";
import { element } from "./dom.mjs";

// Google gradient G: https://commons.wikimedia.org/wiki/File_talk:Google_Favicon_2025.svg
export function providerIcon(provider: "google" | "oidc"): SVGSVGElement | null {
  if (provider !== "google") {
    return null;
  }
  const namespace = "http://www.w3.org/2000/svg";
  const node = <Tag extends keyof SVGElementTagNameMap>(
    tag: Tag,
    attributes: Record<string, string>,
  ): SVGElementTagNameMap[Tag] => {
    const item = document.createElementNS(namespace, tag);
    for (const [name, value] of Object.entries(attributes)) {
      item.setAttribute(name, value);
    }
    return item;
  };
  const svg = node("svg", {
    class: "auth-provider-icon",
    "aria-hidden": "true",
    focusable: "false",
    viewBox: "0 0 23.5 24",
  });
  const clip = node("clipPath", { id: "auth-google-logo-clip" });
  clip.append(
    node("path", {
      d: "M12 10v4.5h6.47c-.5 2.7-3 4.74-6.47 4.74-3.9 0-7.1-3.3-7.1-7.25S8.1 4.75 12 4.75c1.8 0 3.35.6 4.6 1.8l3.4-3.4C18 1.2 15.24 0 12 0 5.4 0 0 5.4 0 12s5.4 12 12 12c7 0 11.5-4.9 11.5-11.7 0-.8-.1-1.54-.2-2.3z",
    }),
  );
  const filter = node("filter", { id: "auth-google-logo-blur" });
  filter.append(node("feGaussianBlur", { stdDeviation: "1" }));
  const group = node("g", { "clip-path": "url(#auth-google-logo-clip)" });
  const colors = node("foreignObject", {
    filter: "url(#auth-google-logo-blur)",
    width: "28",
    height: "28",
    transform: "translate(-2 -2)",
  });
  colors.append(element("div", { className: "auth-google-colors" }));
  group.append(colors, node("path", { fill: "#3186FF", d: "M11 8h16v8H11z" }));
  svg.append(clip, filter, group);
  return svg;
}

type SignInMessage = string | ((passwordAvailable: boolean) => string);

function signInUnavailableFailure(label: string): string {
  return `Could not finish signing in with ${label}. Sign-in is unavailable right now; try again later.`;
}

// The Controller emits only these recognized reasons. Unknown values keep the generic message.
export function providerCallbackFailure(label: string, reason: string | null): SignInMessage {
  switch (reason) {
    case "account-disabled":
      return `Your account is disabled, so you cannot sign in with ${label}. Ask an Installation administrator to enable it.`;
    case "provider-unavailable":
      // Only the recovery administrator has a password when password sign-in is recovery-only.
      return (passwordAvailable) =>
        passwordAvailable
          ? `${label} sign-in is unavailable right now. Try again later or use your password.`
          : `${label} sign-in is unavailable right now. Try again later. If you are an Installation administrator, use Recovery sign-in.`;
    case "unavailable":
      return signInUnavailableFailure(label);
  }

  return (passwordAvailable) =>
    passwordAvailable
      ? `Could not sign in with ${label}. Try again or use your password.`
      : `Could not sign in with ${label}. Try again, or ask an Installation administrator to attach your ${label} identity to your account.`;
}

function requestRefusalMessage({
  status,
  code,
  serverMessage,
  retryAfterSeconds: seconds,
}: ReturnType<typeof requestFailure>): string | undefined {
  // A limit message leaves the form usable so the recovery administrator can still sign in.
  if (status === 429) {
    return seconds === undefined
      ? "Too many sign-in attempts. Wait a minute, then try again."
      : `Too many sign-in attempts. Wait ${seconds} ${seconds === 1 ? "second" : "seconds"}, then try again.`;
  }
  // An origin refusal says nothing about the account or password.
  if (
    status === 403 &&
    code === "FORBIDDEN" &&
    serverMessage?.startsWith("A trusted browser origin is required")
  ) {
    return "Sign-in was refused because this page was not opened from the console's configured address. Open the console from its configured URL and sign in there. If you did, ask an operator to check the console address setting (OCC_AUTH_BASE_URL) and any proxy in front of it.";
  }
  return undefined;
}

export function providerStartFailure(cause: unknown, label: string, recoveryOnly: boolean): string {
  return (
    requestRefusalMessage(requestFailure(cause)) ??
    (recoveryOnly
      ? `${label} sign-in is unavailable. Try again later.`
      : `${label} sign-in is unavailable. Try again or use your password.`)
  );
}

export function passwordSignInFailure(cause: unknown, recoveryOnly: boolean): string {
  const failure = requestFailure(cause);
  const refusal = requestRefusalMessage(failure);
  if (refusal !== undefined) {
    return refusal;
  }
  const { status } = failure;
  // Keep credential refusals indistinguishable regardless of account state or factor.
  if (status === 400 || status === 401 || status === 403) {
    return recoveryOnly
      ? "Could not sign in. Only the recovery account can use a password; other accounts continue with their external sign-in."
      : "Could not sign in. Check your email and password.";
  }
  if (status === undefined) {
    return "Could not confirm whether sign-in completed. Reload the page to check your session before trying your password again.";
  }
  return status >= 500
    ? "Sign-in is temporarily unavailable because a service it depends on did not answer. Try again shortly. If it continues, ask an operator."
    : "Sign-in is unavailable. Try again.";
}

// The callback already settled the identity. An exchange failure only explains why this tab
// could not adopt the session.
export function providerExchangeFailure(cause: unknown, label: string): string {
  const failure = requestFailure(cause);
  const refusal = requestRefusalMessage(failure);
  if (refusal !== undefined) {
    return refusal;
  }
  const { status } = failure;
  if (status === undefined || status >= 500) {
    return signInUnavailableFailure(label);
  }
  // Besides the origin check, a 403 means the provider was removed after sign-in started.
  if (status === 403) {
    return `Could not finish signing in with ${label}. ${label} sign-in is no longer available on this Installation. Use another sign-in method, or ask an Installation administrator.`;
  }
  return `Could not finish signing in with ${label}. The sign-in in this tab did not complete in time, or another sign-in replaced it. Select Continue with ${label} to start again.`;
}
