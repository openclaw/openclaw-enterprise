export function createApiClient({ lifetime, hasSession, onExpired, sessionKey = () => null }) {
  async function request(
    path,
    {
      method = "GET",
      body,
      signal,
      expectedStatus,
      includeMeta = false,
      responseType = "json",
      // A session-scoped read that a later view joins instead of aborting it.
      outlivesView = false,
    } = {},
  ) {
    const active = lifetime.capture();
    const pinned = sessionKey();
    // A pinned key lets this tab act only as its own session. If another tab
    // replaces the shared cookie, the controller answers 401 instead.
    const headers = {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(pinned ? { "x-occ-session-key": pinned } : {}),
    };
    const requestSignal = AbortSignal.any([
      ...(outlivesView ? [] : [lifetime.signal]),
      ...(signal ? [signal] : []),
      AbortSignal.timeout(15_000),
    ]);
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal: requestSignal,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // Expiry invalidates the whole view, including other reads or saves still pending.
    if (response.status === 401 && hasSession() && lifetime.isCurrent(active)) {
      onExpired();
    }
    if (response.status === 204 && response.ok && expectedStatus === 204) {
      return undefined;
    }
    let payload;
    try {
      // Attachments (runtime log downloads) are text; failures stay JSON error envelopes.
      if (
        responseType === "text" &&
        response.status === 200 &&
        response.headers.get("content-type")?.startsWith("text/plain")
      ) {
        return await response.text();
      }
      payload = await response.json();
    } catch (error) {
      // Body reads can fail after fetch returned headers. Keep cancellation,
      // deadline and socket failures distinct from a complete, malformed JSON body.
      requestSignal.throwIfAborted();
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      payload = null;
    }
    if (
      !response.ok ||
      (expectedStatus !== undefined && response.status !== expectedStatus) ||
      payload === null ||
      !Object.hasOwn(payload, "data")
    ) {
      const error = new Error("The request could not be completed.");
      error.status = response.status;
      const code = payload?.error?.code;
      if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
        error.code = code;
      }
      // The API's own sentence, for views that show it instead of a generic status text.
      const serverMessage = payload?.error?.message;
      if (
        typeof serverMessage === "string" &&
        serverMessage.length > 0 &&
        serverMessage.length <= 256 &&
        !/\p{Cc}/u.test(serverMessage)
      ) {
        error.serverMessage = serverMessage;
      }
      const detailPaths = Array.isArray(payload?.error?.details)
        ? payload.error.details
            .map((detail) => detail?.path)
            .filter((path) => typeof path === "string" && /^\/[A-Za-z0-9_/~-]{0,128}$/.test(path))
        : [];
      if (detailPaths.length > 0) {
        error.detailPaths = detailPaths;
      }
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter !== null && /^[1-9][0-9]{0,4}$/.test(retryAfter)) {
        error.retryAfterSeconds = Number(retryAfter);
      }
      const requestId = payload?.meta?.requestId;
      if (
        typeof requestId === "string" &&
        /^req_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(requestId)
      ) {
        error.requestId = requestId;
      }
      throw error;
    }
    return includeMeta ? { data: payload.data, meta: payload.meta } : payload.data;
  }

  return request;
}
