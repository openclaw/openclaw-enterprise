import type { CredentialSourceMetadata } from "@openclaw-enterprise/contracts";
import { responseFields, type RequestOptions } from "./api-client.mjs";

const attemptKey = "oce.console.connectionAttempt";
const channelPrefix = "oce.console.connection.";
const sourceIdPattern = /^cs_[0-9a-f-]{36}$/;

interface Context {
  request(path: string, options?: Pick<RequestOptions, "method" | "body">): Promise<unknown>;
  isCurrent(): boolean;
}
type OAuthSource = Extract<CredentialSourceMetadata, { type: "oauth2-refresh-token" }>;

class ConnectionConsentFailure extends Error {}

export function connectionConsentFailure(cause: unknown): string {
  return cause instanceof ConnectionConsentFailure
    ? cause.message
    : "Authorization did not finish. Try again to connect the account.";
}

function safeFailure(cause: unknown, fallback: string): ConnectionConsentFailure {
  return cause instanceof ConnectionConsentFailure ? cause : new ConnectionConsentFailure(fallback);
}

/** The callback tab knows only its own attempt; its message is a hint, never proof of a saved account. */
export function publishConnectionCallback(url: URL): boolean {
  const outcome = url.searchParams.get("connection");
  if (outcome !== "connected" && outcome !== "failed") {
    return false;
  }
  let attempt: string | null;
  try {
    attempt = sessionStorage.getItem(attemptKey);
    if (!attempt || !/^[a-f0-9-]{36}$/.test(attempt)) {
      return false;
    }
    sessionStorage.removeItem(attemptKey);
  } catch {
    return false;
  }
  const channel = new BroadcastChannel(channelPrefix + attempt);
  const sourceId = url.searchParams.get("sourceId");
  channel.postMessage({
    outcome,
    ...(outcome === "connected" && sourceId && sourceIdPattern.test(sourceId) ? { sourceId } : {}),
  });
  channel.close();
  history.replaceState(history.state, "", "/console/");
  return true;
}

/** Call directly from a click so Chrome can open the consent tab before the API request starts. */
export function startConnectionConsent({
  context,
  namespaceId,
  template,
  selectedScopes,
  onDisconnected,
}: {
  context: Context;
  namespaceId: string;
  template: { readonly id: string; readonly current: { readonly version: number } };
  selectedScopes?: readonly string[];
  onDisconnected?: () => void;
}): { result: Promise<OAuthSource>; cancel(): void } {
  const popup = window.open("about:blank", "_blank");
  if (!popup) {
    return {
      result: Promise.reject(
        new ConnectionConsentFailure("The consent tab was blocked. Allow popups, then try again."),
      ),
      cancel() {},
    };
  }
  const attempt = crypto.randomUUID();
  let channel: BroadcastChannel;
  try {
    popup.sessionStorage.setItem(attemptKey, attempt);
    popup.opener = null;
    channel = new BroadcastChannel(channelPrefix + attempt);
  } catch {
    popup.close();
    return {
      result: Promise.reject(
        new ConnectionConsentFailure("Could not open an isolated consent tab. Try again."),
      ),
      cancel() {},
    };
  }

  let finish: (error?: Error, source?: OAuthSource) => void = () => {};
  const result = new Promise<OAuthSource>((resolve, reject) => {
    let settled = false;
    let verifying = false;
    let providerNavigationStarted = false;
    let reportedDisconnected = false;
    let deadline = Date.now() + 10 * 60 * 1000;
    const timer = window.setInterval(() => {
      if (!context.isCurrent()) {
        finish(new ConnectionConsentFailure("The connection was canceled."));
      } else if (popup.closed && !verifying && !providerNavigationStarted) {
        finish(new ConnectionConsentFailure("The consent tab was closed. Try again."));
      } else if (popup.closed && !verifying && !reportedDisconnected) {
        // A provider's Cross-Origin-Opener-Policy can sever this WindowProxy while the
        // consent tab remains open. Only the callback or deadline can settle the attempt.
        reportedDisconnected = true;
        onDisconnected?.();
      } else if (Date.now() >= deadline) {
        finish(
          new ConnectionConsentFailure("Authorization expired. Try again to connect the account."),
        );
      }
    }, 400);
    finish = (error, source) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(timer);
      channel.close();
      if (!popup.closed) {
        popup.close();
      }
      if (error) {
        reject(error);
      } else if (source) {
        resolve(source);
      }
    };
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (settled || verifying || !context.isCurrent()) {
        return;
      }
      const { outcome, sourceId } = responseFields(event.data);
      if (
        outcome !== "connected" ||
        typeof sourceId !== "string" ||
        !sourceIdPattern.test(sourceId)
      ) {
        finish(
          new ConnectionConsentFailure(
            "Authorization did not finish. Try again to connect the account.",
          ),
        );
        return;
      }
      verifying = true;
      void context
        .request(
          `/namespaces/${encodeURIComponent(namespaceId)}/credential-sources/${encodeURIComponent(sourceId)}`,
        )
        .then((value) => {
          if (!context.isCurrent()) {
            throw new ConnectionConsentFailure("The connection was canceled.");
          }
          const source = value as CredentialSourceMetadata;
          if (
            source.id !== sourceId ||
            source.namespaceId !== namespaceId ||
            source.state !== "ready" ||
            source.type !== "oauth2-refresh-token" ||
            source.connectionTemplateId !== template.id ||
            source.consent.kind !== "connection_template" ||
            source.consent.version !== template.current.version
          ) {
            throw new ConnectionConsentFailure(
              "The saved account does not match the selected template version. Refresh the templates and try again.",
            );
          }
          finish(undefined, source);
        })
        .catch((error: unknown) =>
          finish(
            safeFailure(
              error,
              "Could not confirm the saved account. Refresh and inspect your accounts before trying again.",
            ),
          ),
        );
    };
    void context
      .request(`/namespaces/${encodeURIComponent(namespaceId)}/connection-templates`)
      .then((value) => {
        if (
          !Array.isArray(value) ||
          !value.some((item) => {
            const { id, current } = responseFields(item);
            const version = responseFields(current);
            return (
              id === template.id &&
              version.version === template.current.version &&
              (version.mode === "manual" || version.mode === "mcp_discovery") &&
              typeof version.oauthClientId === "string"
            );
          })
        ) {
          throw new ConnectionConsentFailure(
            "This connection template changed or is unavailable. Refresh the templates and try again.",
          );
        }
        if (settled || !context.isCurrent()) {
          throw new ConnectionConsentFailure("The connection was canceled.");
        }
        return context.request(`/namespaces/${encodeURIComponent(namespaceId)}/connections`, {
          method: "POST",
          body: {
            connectionTemplateId: template.id,
            ...(selectedScopes === undefined ? {} : { selectedScopes }),
          },
        });
      })
      .then((value) => {
        if (settled || !context.isCurrent()) {
          return;
        }
        const { authorizationUrl, expiresAt } = responseFields(value);
        if (
          typeof authorizationUrl !== "string" ||
          typeof expiresAt !== "string" ||
          !Number.isFinite(Date.parse(expiresAt))
        ) {
          throw new ConnectionConsentFailure("Could not start authorization. Try again.");
        }
        deadline = Date.parse(expiresAt);
        const destination = new URL(authorizationUrl, location.origin);
        if (destination.protocol !== "https:" && destination.origin !== location.origin) {
          throw new ConnectionConsentFailure("The authorization URL is unavailable. Try again.");
        }
        providerNavigationStarted = true;
        popup.location.replace(destination.href);
      })
      .catch((error: unknown) =>
        finish(
          safeFailure(error, "Could not start authorization. Refresh the templates and try again."),
        ),
      );
  });
  return {
    result,
    cancel: () => finish(new ConnectionConsentFailure("The connection was canceled.")),
  };
}
