import { requestFailure } from "./api-client.mjs";
import { element } from "./dom.mjs";

// Google gradient G: https://commons.wikimedia.org/wiki/File_talk:Google_Favicon_2025.svg
// GitHub mark: https://github.com/primer/octicons/blob/main/icons/mark-github-24.svg
export function providerIcon(provider: "github" | "google" | "oidc"): SVGSVGElement | null {
  if (provider !== "github" && provider !== "google") {
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
    viewBox: provider === "github" ? "0 0 24 24" : "0 0 23.5 24",
  });
  if (provider === "github") {
    svg.append(
      node("path", {
        d: "M10.226 17.284c-2.965-.36-5.054-2.493-5.054-5.256 0-1.123.404-2.336 1.078-3.144-.292-.741-.247-2.314.09-2.965.898-.112 2.111.36 2.83 1.01.853-.269 1.752-.404 2.853-.404 1.1 0 1.999.135 2.807.382.696-.629 1.932-1.1 2.83-.988.315.606.36 2.179.067 2.942.72.854 1.101 2 1.101 3.167 0 2.763-2.089 4.852-5.098 5.234.763.494 1.28 1.572 1.28 2.807v2.336c0 .674.561 1.056 1.235.786 4.066-1.55 7.255-5.615 7.255-10.646C23.5 6.188 18.334 1 11.978 1 5.62 1 .5 6.188.5 12.545c0 4.986 3.167 9.12 7.435 10.669.606.225 1.19-.18 1.19-.786V20.63a2.9 2.9 0 0 1-1.078.224c-1.483 0-2.359-.808-2.987-2.313-.247-.607-.517-.966-1.034-1.033-.27-.023-.359-.135-.359-.27 0-.27.45-.471.898-.471.652 0 1.213.404 1.797 1.235.45.651.921.943 1.483.943.561 0 .92-.202 1.437-.719.382-.381.674-.718.944-.943",
      }),
    );
    return svg;
  }
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
export function providerCallbackFailure(
  provider: string | null,
  label: string,
  reason: string | null,
): SignInMessage {
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

  if (provider === "github") {
    if (reason === "membership") {
      return (passwordAvailable) =>
        `Your GitHub account is not a member of an organization or team allowed to sign in here. If you were invited, accept the invitation on GitHub and try again; otherwise ask an Installation administrator for access${passwordAvailable ? " or use your password" : ""}.`;
    }
    if (reason === "membership-unavailable") {
      return (passwordAvailable) =>
        passwordAvailable
          ? "Could not check your GitHub organization membership. Try again later or use your password."
          : "Could not check your GitHub organization membership. Try again later; if this keeps happening, ask an Installation administrator.";
    }
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
    return "Sign-in requires the Console's exact address, including http or https, hostname, and port. Ask your administrator for the Console sign-in link.";
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
