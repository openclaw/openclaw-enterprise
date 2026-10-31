// Rendered into the trusted Harness launcher. The outer supervisor owns the
// process group, including installer descendants, and retires it on failure.
export const CODEX_PLUGIN_STDIO_HELPER = String.raw`
async function withCodexPluginStdio(command, args, options, install) {
  const child = require("node:child_process").spawn(command, [...args, "--listen", "stdio://"], {
    ...options, stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let nextId = 0;
  let lastMethod = "initialize";
  let rpcDiagnostic;
  let buffer = "";
  let failure;
  let closing = false;
  let exit;
  let rejectFailure;
  let catalogRequestId;
  const observations = {
    catalogQueued: false, catalogWriteComplete: false, catalogReplyMatched: false,
    stdoutMessages: 0, matchedReplyEnvelopes: 0,
    unmatchedNumberIds: 0, unmatchedStringIds: 0, unmatchedNullIds: 0, unmatchedOtherIds: 0,
  };
  function countObservation(key) {
    observations[key] = Math.min(observations[key] + 1, 2_147_483_647);
  }
  const failed = new Promise((_, reject) => { rejectFailure = reject; });
  const close = new Promise((resolve) => child.once("close", (code, signal) => {
    exit = { code, signal };
    if (!closing) fail(preparationError("early-exit"));
    resolve(exit);
  }));
  function preparationError(reason, method = lastMethod, rpcCode) {
    const error = reason === "rpc"
      ? new CodexAppServerRequestError(method, "Codex plugin preparation RPC failed.")
      : new Error("Codex plugin preparation failed: " + reason);
    error.preparation = {
      reason, method, rpcCode, ...observations,
      catalogPending: [...pending.values()].some((request) => request.method === "plugin/list"),
    };
    return error;
  }
  function fail(error) {
    if (failure !== undefined) return;
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    rejectFailure(error);
  }
  async function waitForClose(abortOnFailure) {
    let timer;
    try {
      return await Promise.race([close, ...(abortOnFailure ? [failed] : []), new Promise((resolve) => {
        timer = setTimeout(resolve, 8_000);
      })]);
    } finally { clearTimeout(timer); }
  }
  const deadline = setTimeout(() => fail(preparationError("timeout")), 60_000);
  const cancel = () => fail(preparationError("cancelled"));
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);
  // Native output can contain account or signed URL data. Only our diagnostic
  // record crosses the launcher boundary; native stderr is discarded.
  child.stderr.on("data", () => {});
  child.on("error", () => fail(preparationError("spawn")));
  child.stdin.on("error", () => fail(preparationError("input-closed")));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (failure !== undefined) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > 16 * 1024 * 1024) {
      fail(preparationError("response-limit"));
      return;
    }
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim().length === 0) continue;
      let message;
      try { message = JSON.parse(line); } catch {
        fail(preparationError("invalid-json"));
        return;
      }
      countObservation("stdoutMessages");
      const request = pending.get(message?.id);
      if (request === undefined) {
        if (message?.id !== undefined) {
          if (typeof message.id === "number") {
            countObservation("unmatchedNumberIds");
          } else if (typeof message.id === "string") {
            countObservation("unmatchedStringIds");
          } else if (message.id === null) {
            countObservation("unmatchedNullIds");
          } else {
            countObservation("unmatchedOtherIds");
          }
        }
        if (message?.id !== undefined && message?.method !== undefined) {
          fail(preparationError("server-request"));
        }
        continue;
      }
      countObservation("matchedReplyEnvelopes");
      if (message.id === catalogRequestId) {
        observations.catalogReplyMatched = true;
      }
      if (Object.hasOwn(message, "result") === Object.hasOwn(message, "error")) {
        fail(preparationError("invalid-response", request.method));
        return;
      }
      pending.delete(message.id);
      if (Object.hasOwn(message, "error")) {
        const code = Number.isSafeInteger(message.error?.code) ? message.error.code : undefined;
        const error = preparationError("rpc", request.method, code);
        rpcDiagnostic = error.preparation;
        request.reject(error);
      } else {
        request.resolve(message.result);
      }
    }
  });
  function request(method, params) {
    if (failure !== undefined) return Promise.reject(failure);
    lastMethod = method;
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { method, resolve, reject });
      if (method === "plugin/list") {
        catalogRequestId = id;
        observations.catalogQueued = true;
        observations.catalogWriteComplete = false;
        observations.catalogReplyMatched = false;
      }
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n", (error) => {
        if (id === catalogRequestId && (error === undefined || error === null)) {
          observations.catalogWriteComplete = true;
        }
      });
    });
  }
  try {
    const result = await Promise.race([failed, (async () => {
      await request("initialize", codexPluginInitializeParams());
      child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
      return install(request);
    })()]);
    if (failure !== undefined) throw failure;
    closing = true;
    child.stdin.end();
    const status = await waitForClose(true);
    if (status === undefined) throw preparationError("shutdown-timeout");
    if (status.code !== 0) throw preparationError("unclean-exit");
    return result;
  } catch (error) {
    fail(error);
    // This is the sole termination path. Never start a replacement after an
    // uncertain mutation; the outer supervisor also retires the whole group.
    child.kill("SIGTERM");
    await waitForClose(false);
    if (exit === undefined) child.kill("SIGKILL");
    error.preparation = {
      ...(error.preparation ?? rpcDiagnostic ?? { reason: "installer", method: lastMethod }),
      exitCode: exit?.code ?? undefined,
      signal: exit?.signal ?? undefined,
    };
    throw error;
  } finally {
    clearTimeout(deadline);
    process.off("SIGTERM", cancel);
    process.off("SIGINT", cancel);
  }
}
`;
