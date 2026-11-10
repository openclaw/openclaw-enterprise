import assert from "node:assert/strict";
import { nativeTaskFailureSummary } from "./normal-agent-tools.mjs";
import { isAbsolute } from "node:path";

export function createRepositoryObserver({ run, repository, binary = "gh" }) {
  assert.match(repository, /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
  if (binary !== "gh") {
    assert.ok(isAbsolute(binary), "the managed gh binary must be absolute");
  }
  const prefix = `repos/${repository}`;
  const observe = async (method, suffix = "", body, expected = 200) => {
    assert.ok(!suffix.includes("..") && !suffix.startsWith("/"));
    const args = [
      "api",
      "--hostname",
      "github.com",
      "--include",
      "--method",
      method,
      `${prefix}${suffix ? `/${suffix}` : ""}`,
    ];
    if (body !== undefined) {
      args.push("--input", "-");
    }
    const response = await run(binary, args, {
      input: body === undefined ? undefined : JSON.stringify(body),
      timeout: 30000,
      allowExitCodes: [0, 1],
    });
    const separator = /\r?\n\r?\n/.exec(response);
    assert.ok(separator, "GitHub API must return a status and response");
    const status = Number(/^HTTP\/\S+ (\d+)/.exec(response)?.[1]);
    assert.ok([].concat(expected).includes(status), `GitHub ${method} returned ${status}`);
    const payload = response.slice(separator.index + separator[0].length);
    return { status, data: payload.trim() ? JSON.parse(payload) : undefined };
  };
  observe.deleteBranch = async (branch, sha) => {
    assert.match(sha, /^[a-f0-9]{40}$/);
    await run("git", ["check-ref-format", `refs/heads/${branch}`]);
    // The final compare-and-delete belongs to Git transport. The lease also
    // prevents deleting a concurrent update after our independent API readback.
    const credentialHelper = "!" + "'" + binary.replaceAll("'", "'\\''") + "' auth git-credential";
    await run(
      "git",
      [
        "-c",
        "credential.helper=",
        "-c",
        `credential.helper=${credentialHelper}`,
        "push",
        "--porcelain",
        `--force-with-lease=refs/heads/${branch}:${sha}`,
        `https://github.com/${repository}.git`,
        `:refs/heads/${branch}`,
      ],
      { timeout: 60000, env: { GIT_TERMINAL_PROMPT: "0" } },
    );
  };
  return observe;
}

export const submitRepositoryTaskScript = String.raw`
  const summarizeFailure = ${nativeTaskFailureSummary.toString()};
  let stage = "input";
  (async () => {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 32768) throw new Error("task input too large");
    }
    const { sessionKey, prompt, gatewayUrl, completionMarker } = JSON.parse(input);
    stage = "authentication";
    if (process.env.OPENAI_API_KEY) throw new Error("request client must not receive model credentials");
    let url;
    let authentication;
    if (gatewayUrl !== undefined) {
      url = new URL(gatewayUrl);
      if (url.protocol !== "https:" || url.port || url.username || url.password ||
          !/^occ-gateway-[a-f0-9]{12}\.[a-z0-9-]+\.svc$/.test(url.hostname) ||
          !/^\/namespaces\/[A-Za-z0-9_-]+\/agents\/[A-Za-z0-9_-]+$/.test(url.pathname) ||
          url.search || url.hash) throw new Error("invalid private Gateway route");
      if (typeof completionMarker !== "string" || completionMarker.length === 0 ||
          completionMarker.length > 1024) throw new Error("private Gateway route requires a completion marker");
      const key = require("node:fs").readFileSync(process.env.OCC_GATEWAY_API_KEY_PATH, "utf8");
      if (!key || !/^[\x21-\x7e]+$/.test(key)) throw new Error("Gateway API key unavailable");
      const { randomUUID } = require("node:crypto");
      const { pathToFileURL } = require("node:url");
      const { setTimeout: delay } = require("node:timers/promises");
      const { GatewayClient } = await import(
        pathToFileURL(
          require.resolve("@openclaw/gateway-client", { paths: ["/app/apps/controller"] }),
        ).href
      );
      stage = "gateway-connect";
      let resolveHello;
      let rejectHello;
      const connected = new Promise((resolve, reject) => {
        resolveHello = resolve;
        rejectHello = reject;
      });
      url.protocol = "wss:";
      const client = new GatewayClient({
        url: url.toString(),
        clientName: "gateway-client",
        mode: "backend",
        role: "operator",
        scopes: [],
        deviceIdentity: null,
        edgeAuthHeaders: { "x-api-key": key },
        onHelloOk: resolveHello,
        onConnectError: rejectHello,
      });
      const signal = AbortSignal.timeout(600000);
      const helloTimer = setTimeout(() => rejectHello(new Error("gateway hello timeout")), 15000);
      client.start();
      try {
        const hello = await connected;
        clearTimeout(helloTimer);
        if (hello.auth?.role !== "operator" || !hello.auth.scopes.includes("operator.admin")) {
          throw new Error("trusted-proxy gateway authentication did not grant operator.admin");
        }
        if (hello.auth.deviceToken !== undefined) {
          throw new Error("trusted-proxy gateway issued an unexpected device token");
        }
        stage = "chat-send";
        const acknowledgement = await client.request(
          "chat.send",
          { sessionKey, idempotencyKey: randomUUID(), message: prompt },
          { signal, timeoutMs: 30000 },
        );
        stage = "chat-history";
        while (!signal.aborted) {
          const history = await client.request(
            "chat.history",
            { sessionKey, limit: 30 },
            { signal, timeoutMs: 10000 },
          );
          for (const message of history.messages ?? []) {
            if (message.role !== "assistant") continue;
            if (message.stopReason === "error") throw new Error("native model turn failed");
            const content = typeof message.content === "string"
              ? message.content
              : (message.content ?? [])
                  .filter((part) => part?.type === "text" && typeof part.text === "string")
                  .map((part) => part.text)
                  .join("\n");
            const hasToolCalls = Array.isArray(message.content) &&
              message.content.some((part) => part?.type === "toolCall");
            if (content.includes(completionMarker) && !hasToolCalls && message.stopReason !== "toolUse") {
              process.stdout.write(JSON.stringify({
                status: 200,
                transport: "wss",
                runId: acknowledgement?.runId,
              }));
              return;
            }
          }
          await delay(500, undefined, { signal });
        }
        throw new Error("native task timeout");
      } finally {
        clearTimeout(helloTimer);
        client.stop();
        await client.stopAndWait?.({ timeoutMs: 1000 }).catch(() => undefined);
      }
    } else {
      const password = process.env.OPENCLAW_GATEWAY_PASSWORD;
      if (!password) throw new Error("gateway loopback credential unavailable");
      authentication = { authorization: "Bearer " + password };
      url = "http://127.0.0.1:" + (process.env.OPENCLAW_GATEWAY_PORT || "8080") + "/v1/chat/completions";
    }
    stage = "request";
    const requestAbort = new AbortController();
    const response = await fetch(url, {
      method: "POST", signal: AbortSignal.any([AbortSignal.timeout(600000), requestAbort.signal]), redirect: "error",
      headers: { ...authentication, "content-type": "application/json", "x-openclaw-session-key": sessionKey },
      body: JSON.stringify({ model: "openclaw/default", stream: false, messages: [{ role: "user", content: prompt }] }),
    });
    // Persisted transcript and independent provider reads establish success, never reply prose.
    stage = "response-body";
    if (response.status === 200) {
      await response.arrayBuffer();
      process.stdout.write(JSON.stringify({ status: response.status }));
    } else {
      let bytes = Buffer.alloc(0);
      let complete = false;
      const bodyDeadline = setTimeout(() => requestAbort.abort(), 5000);
      try {
        for await (const chunk of response.body) {
          const remaining = 65536 - bytes.length;
          bytes = Buffer.concat([bytes, Buffer.from(chunk).subarray(0, remaining)]);
          if (bytes.length === 65536) { requestAbort.abort(); break; }
        }
        complete = !requestAbort.signal.aborted;
      } catch { /* Only fixed diagnostics leave this process. */ }
      finally { clearTimeout(bodyDeadline); }
      process.stdout.write(JSON.stringify({ status: response.status, failure: {
        stage: "http-response", bodyComplete: complete, ...summarizeFailure(bytes.toString("utf8")),
      } }));
      bytes.fill(0);
    }
  })().catch((error) => {
    const code = error?.cause?.code ?? error?.code;
    const allowed = [
      "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT",
      "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT",
    ];
    // Return only fixed diagnostic vocabulary; the caller still requires HTTP 200.
    process.stdout.write(JSON.stringify({
      status: null,
      failure: { stage, code: allowed.includes(code) ? code : "OTHER" },
    }));
  });
`;

// Read-only private control observation. The production worker remains the only
// session opener/closer, and bearer material never leaves the workload.
export async function readInstalledCredentialSession(executeWorker, sessionId) {
  const code = String.raw`
    const http = require("node:http");
    const id = process.argv[1];
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("invalid session identity");
    const request = http.request({ socketPath: "/run/openclaw/repository-control/private/control.sock", path: "/v1/sessions/" + id, method: "GET", timeout: 5000 }, response => {
      let text = "";
      response.on("data", chunk => { text += chunk; if (text.length > 65536) response.destroy(); });
      response.on("end", () => {
        if (response.statusCode !== 200) throw new Error("session status unavailable");
        const value = JSON.parse(text);
        console.log(JSON.stringify({ sessionId: value.sessionId, state: value.state, activeUses: value.activeUses, cleanup: value.cleanup }));
      });
    });
    request.on("timeout", () => request.destroy(new Error("status timeout")));
    request.on("error", () => { process.stderr.write("session observation failed\n"); process.exitCode = 1; });
    request.end();
  `;
  return JSON.parse(await executeWorker(code, [sessionId], 10000));
}
