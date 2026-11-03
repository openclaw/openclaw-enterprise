// Rendered into the trusted Harness launcher. The outer supervisor owns the
// process group, including installer descendants, and retires it on failure.
export const CODEX_PLUGIN_STDIO_HELPER = String.raw`
async function withCodexPluginStdio(command, args, options, install) {
  const child = require("node:child_process").spawn(command, [...args, "--listen", "stdio://"], {
    ...options,
    env: { ...(options?.env ?? process.env), LOG_FORMAT: "json", RUST_LOG: "warn" },
    stdio: ["pipe", "pipe", "pipe"],
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
  let nativeDiagnostic;
  let nativeInstallHash;
  function installHash(marketplace, plugin) {
    if (typeof marketplace !== "string" || typeof plugin !== "string") {
      return undefined;
    }
    return require("node:crypto").createHash("sha256")
      .update(JSON.stringify([marketplace, plugin])).digest("hex");
  }
  // Codex 0.164 emits these fixed classifications beside unsafe warning text.
  const nativeErrorTypes = new Set([
    "remote_catalog_auth_required", "remote_catalog_unsupported_auth_mode",
    "remote_catalog_auth_token", "remote_catalog_request", "remote_catalog_unexpected_status",
    "remote_catalog_decode", "remote_catalog_invalid_base_url", "remote_catalog_invalid_base_url_path",
    "remote_catalog_unknown_marketplace", "remote_catalog_unexpected_plugin_id",
    "remote_catalog_unexpected_skill_name", "remote_catalog_unexpected_enabled_state",
    "remote_catalog_invalid_plugin_path", "remote_catalog_plugin_share_checkout_not_available",
    "remote_catalog_archive", "remote_catalog_archive_join", "remote_catalog_archive_too_large",
    "remote_catalog_missing_upload_etag", "remote_catalog_unexpected_response",
    "remote_catalog_timeout", "remote_catalog_cache_remove", "remote_plugin_not_available",
    "remote_bundle_missing_release_version", "remote_bundle_invalid_release_version",
    "remote_bundle_missing_download_url", "remote_bundle_invalid_download_url",
    "remote_bundle_unsupported_download_url_scheme", "remote_bundle_invalid_plugin_id",
    "remote_bundle_download_request", "remote_bundle_download_status", "remote_bundle_download_body",
    "remote_bundle_download_too_large", "remote_bundle_unsupported_download_final_url",
    "remote_bundle_extracted_too_large", "remote_bundle_io", "remote_bundle_invalid_bundle",
    "remote_bundle_store",
  ]);
  const nativeSubErrorTypes = new Set([
    "http_401", "http_403", "http_404", "http_409", "http_429", "http_5xx", "http_other",
    "disabled_by_admin", "install_policy_not_available",
  ]);
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
      catalogPending: [...pending.values()].some((request) => request.method === "plugin/search"),
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
  // Native output can contain account or signed URL data. Project only the fixed
  // install warning classifications; drain oversized/malformed lines without export.
  let stderrBuffer = "";
  let stderrOversized = false;
  function readNativeDiagnostic(line) {
    if (lastMethod !== "plugin/install") {
      return;
    }
    let record;
    try { record = JSON.parse(line); } catch { return; }
    if (
      record?.level !== "WARN" || typeof record.target !== "string" ||
      !record.target.startsWith("codex_app_server::") ||
      record.fields?.message !== "remote plugin install failed" ||
      nativeInstallHash === undefined ||
      installHash(record.fields.marketplace_name, record.fields.remote_plugin_id) !== nativeInstallHash ||
      !nativeErrorTypes.has(record.fields.error_type)
    ) {
      return;
    }
    nativeDiagnostic = {
      nativeErrorType: record.fields.error_type,
      ...(nativeSubErrorTypes.has(record.fields.sub_error_type)
        ? { nativeSubErrorType: record.fields.sub_error_type } : {}),
    };
  }
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf("\n", start);
      const part = chunk.slice(start, end === -1 ? undefined : end);
      if (!stderrOversized) {
        if (Buffer.byteLength(stderrBuffer, "utf8") + Buffer.byteLength(part, "utf8") > 64 * 1024) {
          stderrBuffer = "";
          stderrOversized = true;
        } else {
          stderrBuffer += part;
        }
      }
      if (end === -1) {
        break;
      }
      if (!stderrOversized) {
        readNativeDiagnostic(stderrBuffer);
      }
      stderrBuffer = "";
      stderrOversized = false;
      start = end + 1;
    }
  });
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
    if (method === "plugin/install") {
      nativeDiagnostic = undefined;
      nativeInstallHash = installHash(params?.remoteMarketplaceName, params?.pluginName);
    }
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { method, resolve, reject });
      if (method === "plugin/search") {
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
      ...(lastMethod === "plugin/install" ? nativeDiagnostic : {}),
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
