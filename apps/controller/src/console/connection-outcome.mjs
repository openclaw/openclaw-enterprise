// The provider's consent page returns through GET /oauth/callback, which redirects to the console
// with `connection=connected` (and the Agent) or `connection=failed&reason=<code>` (and no Agent).
// The tab that started a connection opens consent in a popup when the browser allows one and
// otherwise in the same tab. Providers' opener policies can cut the popup off from its opener,
// so the page the callback lands on reports through a same-origin BroadcastChannel instead.
export const CONNECTION_CHANNEL = "oce-agent-connections";

const REDIRECT_KEY = "oce.agentConnection.redirect";
// How long a landed page waits for the starting tab to claim its outcome before showing it.
const CLAIM_WAIT_MS = 400;
const REASON = /^[a-z][a-z0-9_]{0,63}$/;

// The outcome this page load landed with, until the Agent's Connections section takes it.
let landed = null;

/**
 * Records a same-tab consent redirect, so the landing page can find the Agent after a failure
 * and finish a reconnect. Session storage stays in this tab; failures to write are ignored and
 * the landing page then shows the outcome without its Agent.
 */
export function rememberRedirectConnection(record) {
  try {
    sessionStorage.setItem(REDIRECT_KEY, JSON.stringify({ ...record, at: Date.now() }));
  } catch {
    // Storage blocked: the callback still completes; only the failure's Agent link is lost.
  }
}

function takeRedirectConnection() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(REDIRECT_KEY) ?? "null");
    sessionStorage.removeItem(REDIRECT_KEY);
    // A consent session lasts ten minutes; an older record belongs to an abandoned attempt.
    if (
      stored &&
      typeof stored.agentId === "string" &&
      typeof stored.namespaceId === "string" &&
      Date.now() - stored.at < 15 * 60_000
    ) {
      return stored;
    }
  } catch {
    // Unreadable storage holds no record.
  }
  return null;
}

/** Offers an outcome to a tab waiting on a popup; true when one claimed it. */
function offerToOpener(outcome) {
  if (typeof BroadcastChannel !== "function") {
    return Promise.resolve(false);
  }
  const channel = new BroadcastChannel(CONNECTION_CHANNEL);
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const finish = (claimed) => {
      clearTimeout(timer);
      channel.close();
      resolve(claimed);
    };
    const timer = setTimeout(() => finish(false), CLAIM_WAIT_MS);
    channel.onmessage = (event) => {
      if (event.data?.type === "claimed" && event.data.id === id) {
        finish(true);
      }
    };
    channel.postMessage({ type: "outcome", id, ...outcome });
  });
}

/**
 * Handles a callback landing before the console routes this page. The outcome leaves the URL,
 * so a reload or Back does not show it again. A popup hands it to its opener and closes; a
 * same-tab redirect keeps it for the Agent's Connections section, returning a failure to the
 * Agent that started it. Returns false when this window closed.
 */
export async function receiveConnectionOutcome() {
  const url = new URL(location.href);
  const kind = url.searchParams.get("connection");
  if (kind !== "connected" && kind !== "failed") {
    return true;
  }
  const reason = url.searchParams.get("reason");
  url.searchParams.delete("connection");
  url.searchParams.delete("reason");
  const agentMatch = /^\/console\/agents\/(agt_[0-9a-f-]+)$/.exec(url.pathname);
  const outcome = {
    outcome: kind,
    reason: kind === "failed" && reason && REASON.test(reason) ? reason : null,
    agentId: agentMatch?.[1] ?? null,
    namespaceId: agentMatch ? url.searchParams.get("namespace") : null,
  };
  history.replaceState(history.state, "", `${url.pathname}${url.search}`);
  if (await offerToOpener(outcome)) {
    window.close();
    // A tab the console did not open cannot close itself; it shows the outcome below.
    if (window.closed) {
      return false;
    }
  }
  const redirect = takeRedirectConnection();
  if (redirect && (outcome.agentId === null || outcome.agentId === redirect.agentId)) {
    outcome.agentId = redirect.agentId;
    outcome.namespaceId = redirect.namespaceId;
    outcome.replaces = redirect.replaces ?? null;
    const agentUrl = new URL(`/console/agents/${redirect.agentId}`, location.origin);
    agentUrl.searchParams.set("namespace", redirect.namespaceId);
    history.replaceState(history.state, "", `${agentUrl.pathname}${agentUrl.search}`);
  }
  landed = outcome.agentId ? outcome : null;
  return true;
}

/** The landed outcome for this Agent, once; null when the page did not land with one. */
export function takeLandedOutcome(namespaceId, agentId) {
  if (landed?.agentId !== agentId || landed.namespaceId !== namespaceId) {
    return null;
  }
  const outcome = landed;
  landed = null;
  return outcome;
}
