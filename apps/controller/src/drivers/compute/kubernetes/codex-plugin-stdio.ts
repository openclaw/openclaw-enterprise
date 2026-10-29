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
  let rpcErrorCode;
  let childExitCode;
  let childExitSignal;
  let buffer = "";
  let failure;
  let closing = false;
  let closed = false;
  let killTimer;
  const close = new Promise((resolve) => child.once("close", (code, signal) => {
    childExitCode = code;
    childExitSignal = signal;
    closed = true;
    if (!closing) fail(new Error("Codex plugin preparation exited before completion."));
    resolve(code);
  }));
  const deadline = setTimeout(() => fail(new Error("Codex plugin preparation timed out.")), 60_000);
  function fail(error) {
    if (failure !== undefined) return;
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 8_000);
    killTimer.unref();
  }
  const cancel = () => fail(new Error("Codex plugin preparation was cancelled."));
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);
  // Native diagnostics can contain account or URL data. Preparation reports a
  // fixed startup failure; it does not forward native stdout or stderr to logs.
  child.stderr.on("data", () => {});
  child.on("error", () => fail(new Error("Codex plugin preparation could not start.")));
  child.stdin.on("error", () => fail(new Error("Codex plugin preparation input closed.")));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > 16 * 1024 * 1024) {
      fail(new Error("Codex plugin preparation response exceeded its limit."));
      return;
    }
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim().length === 0) continue;
      let message;
      try { message = JSON.parse(line); } catch {
        fail(new Error("Codex plugin preparation returned invalid JSON."));
        return;
      }
      const request = pending.get(message?.id);
      if (request === undefined) {
        if (message?.id !== undefined && message?.method !== undefined) {
          fail(new Error("Codex plugin preparation requested an unsupported interaction."));
        }
        continue;
      }
      pending.delete(message.id);
      if (Object.hasOwn(message, "result") === Object.hasOwn(message, "error")) {
        const error = new Error("Codex plugin preparation returned an invalid response.");
        request.reject(error);
        fail(error);
      } else if (Object.hasOwn(message, "error")) {
        rpcErrorCode = Number.isSafeInteger(message.error?.code) ? message.error.code : undefined;
        // Keep the method for the existing installer's diagnostic classification.
        request.reject(new CodexAppServerRequestError(request.method, "Codex plugin preparation RPC failed."));
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
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  try {
    await request("initialize", codexPluginInitializeParams());
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    const result = await install(request);
    if (failure !== undefined) throw failure;
    closing = true;
    child.stdin.end();
    let shutdownTimer;
    try {
      const code = await Promise.race([
        close,
        new Promise((_, reject) => {
          shutdownTimer = setTimeout(() => reject(new Error("Codex plugin preparation did not stop.")), 8_000);
        }),
      ]);
      if (code !== 0) throw new Error("Codex plugin preparation did not exit cleanly.");
    } finally { clearTimeout(shutdownTimer); }
    if (failure !== undefined) throw failure;
    return result;
  } catch (error) {
    fail(error);
    // Never launch a replacement after uncertain mutation. The outer supervisor
    // also kills this wrapper's entire group before it starts another wrapper.
    if (!closed) {
      let cleanupTimer;
      await Promise.race([close, new Promise((resolve) => {
        cleanupTimer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 8_000);
      })]);
      clearTimeout(cleanupTimer);
    }
    // These fields describe our requests and process, never native error text.
    const reasons = new Map([
      ["Codex plugin preparation exited before completion.", "early-exit"],
      ["Codex plugin preparation timed out.", "timeout"],
      ["Codex plugin preparation was cancelled.", "cancelled"],
      ["Codex plugin preparation response exceeded its limit.", "response-limit"],
      ["Codex plugin preparation returned invalid JSON.", "invalid-json"],
      ["Codex plugin preparation requested an unsupported interaction.", "server-request"],
      ["Codex plugin preparation returned an invalid response.", "invalid-response"],
      ["Codex plugin catalog did not contain the selected plugin.", "catalog-missing"],
      ["Codex catalog remote plugin ID is missing.", "remote-id-missing"],
    ]);
    error.preparationReason = reasons.get(error.message) ?? (rpcErrorCode === undefined ? "installer" : "rpc");
    error.preparationMethod = lastMethod;
    error.preparationRpcCode = rpcErrorCode;
    error.preparationExitCode = childExitCode;
    error.preparationExitSignal = childExitSignal;
    throw error;
  } finally {
    clearTimeout(deadline);
    clearTimeout(killTimer);
    process.off("SIGTERM", cancel);
    process.off("SIGINT", cancel);
  }
}
`;
