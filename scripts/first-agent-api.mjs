async function boundedJson(response, maxBytes) {
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        throw new Error("Diagnostic response exceeded its byte limit.");
      }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    if (!response.bodyUsed) {
      await response.body?.cancel();
    }
  }
}

export function createFirstAgentApi({ origin, key }) {
  return async (method, path, body, { signal, maxBytes } = {}) => {
    let response;
    try {
      response = await fetch(new URL(path, origin), {
        method,
        redirect: "error",
        signal: signal ?? AbortSignal.timeout(20_000),
        headers: {
          "x-api-key": key.data.key,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(
        `The local controller did not answer ${method} ${path}. Confirm Local Setup is running and retry the same Agent name.`,
      );
    }
    let envelope;
    try {
      envelope =
        maxBytes === undefined ? await response.json() : await boundedJson(response, maxBytes);
    } catch {
      throw new Error(
        `The local controller returned an invalid response (HTTP ${response.status}).`,
      );
    }
    if (!response.ok) {
      const code = /^[A-Z0-9_]+$/.test(envelope.error?.code ?? "") ? ` ${envelope.error.code}` : "";
      const requestId = /^req_[a-f0-9-]+$/.test(envelope.meta?.requestId ?? "")
        ? `; request ${envelope.meta.requestId}`
        : "";
      throw new Error(
        `The local controller rejected ${method} ${path} (HTTP ${response.status}${code}${requestId}).`,
      );
    }
    return envelope.data;
  };
}
