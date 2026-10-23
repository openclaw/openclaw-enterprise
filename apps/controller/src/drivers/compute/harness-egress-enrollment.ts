export const HARNESS_EGRESS_ENROLLMENT_PATH = "/openclaw/runtime/egress-enrollment";

// This runs in the generated Harness, before Codex, login or its first model probe. The transport
// bearer may read this challenge; only Compute can sign its release.
export const HARNESS_EGRESS_ENROLLMENT_HELPER = String.raw`
function waitForHarnessEgressEnrollment(enrollment) {
  const { createHash, createPublicKey, randomUUID, timingSafeEqual, verify } = require("node:crypto");
  const { isDeepStrictEqual } = require("node:util");
  const { createServer } = require("node:http");
  const verifier = process.env.APP_TOKEN_SHA;
  const port = Number(process.env.APP_SERVER_PORT);
  const preview = enrollment?.repositoryGitAuthorization === "request-hook-observed";
  const online = preview || enrollment?.repositoryGitAuthorization === "online-request";
  const executionKeys = ["installationId", "namespaceId", "agentId", "servicePrincipalId", "revisionId", "executionId"];
  if (typeof verifier !== "string" || !/^[a-f0-9]{64}$/.test(verifier) ||
      !Number.isSafeInteger(port) || port < 1 || port > 65535 ||
      !isPlainObject(enrollment) || Object.keys(enrollment).length !== (online ? 5 : 4) ||
      (typeof enrollment.inference !== "boolean" && enrollment.inference !== "credential_source") ||
      !Number.isSafeInteger(enrollment.routeCount) || enrollment.routeCount < 0 ||
      !isPlainObject(enrollment.plan) || Object.keys(enrollment.plan).length !== 2 ||
      typeof enrollment.plan.id !== "string" || !enrollment.plan.id || enrollment.plan.id.length > 256 ||
      !Number.isSafeInteger(enrollment.plan.generation) || enrollment.plan.generation < 1 ||
      !isPlainObject(enrollment.execution) || Object.keys(enrollment.execution).length !== executionKeys.length ||
      executionKeys.some((key) => typeof enrollment.execution[key] !== "string" ||
        !enrollment.execution[key] || enrollment.execution[key].length > 256) ||
      enrollment.execution.revisionId !== process.env.OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID) {
    return Promise.reject(new Error("Protected Harness enrollment configuration is invalid."));
  }
  const encodedKey = process.env.OPENCLAW_EGRESS_COMPUTE_RELEASE_PUBLIC_KEY;
  if (typeof encodedKey !== "string" || !/^[A-Za-z0-9_-]{59}$/.test(encodedKey)) {
    return Promise.reject(new Error("Protected Harness Compute release verification key is missing."));
  }
  const key = createPublicKey({key: Buffer.from(encodedKey, "base64url"), type: "spki", format: "der"});
  if (key.asymmetricKeyType !== "ed25519") {
    return Promise.reject(new Error("Protected Harness Compute release verification key is invalid."));
  }
  const expected = Buffer.from(verifier, "hex");
  const challenge = { profile: "oce-compute-execution-release-v1", ...enrollment, startupId: randomUUID() };
  const deadline = performance.now() + 180000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let released = false;
    let probeSent = false, observed = false;
    const finish = (enrolled) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      // Close the temporary listener before Codex or the held-failure server binds.
      server.close(() => {
        if (enrolled) {
          resolve();
        } else {
          reject(new Error("Protected Harness enrollment failed."));
        }
      });
      server.closeAllConnections();
    };
    const server = createServer(async (request, response) => {
      const answer = (status, body) => {
        response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
        response.end(JSON.stringify(body));
      };
      const authorization = typeof request.headers.authorization === "string"
        ? /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(request.headers.authorization) : null;
      if (authorization === null || !timingSafeEqual(createHash("sha256").update(authorization[1]).digest(), expected)) {
        answer(401, { error: "unauthorized" });
        return;
      }
      if (settled || released || performance.now() >= deadline) {
        answer(410, { error: "expired" });
        return;
      }
      if (request.url !== ${JSON.stringify(HARNESS_EGRESS_ENROLLMENT_PATH)}) {
        answer(404, { error: "not_found" });
        return;
      }
      if (request.method === "GET") {
        answer(200, challenge);
        return;
      }
      if (request.method !== "POST" || request.headers["content-type"] !== "application/json") {
        answer(400, { error: "invalid_request" });
        return;
      }
      try {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 4096) {
            answer(413, { error: "invalid_request" });
            return;
          }
          chunks.push(chunk);
        }
        const release = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (preview && Object.hasOwn(release, "probePath")) {
          const {probePath, startupId} = release;
          if (probeSent || startupId !== challenge.startupId ||
              !/^\/oce-observe-request\/[0-9a-f]{32}\.git\/info\/refs$/.test(probePath)) {
            answer(409, {error: "stale_probe"});
            return;
          }
          // One ordinary verified HTTPS request from this held process. No credential, redirect,
          // URL supplied by a caller, or allow path. The refusal secret is known only to OCE.
          probeSent = true;
          const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
            ["https_proxy","http_proxy","all_proxy","no_proxy","ssl_cert_file","ssl_cert_dir",
              "curl_ca_bundle"].includes(k.toLowerCase())));
          const {stdout} = await require("node:util").promisify(require("node:child_process").execFile)(
            "/usr/bin/curl", ["--disable", "--silent", "--proto", "=https", "--max-time", "10",
              "--max-filesize", "4096", "--write-out", "\n%{http_code}", "--url",
              "https://github.com" + probePath + "?service=git-upload-pack"],
            {env, timeout: 12000, maxBuffer: 8192, encoding: "utf8"});
          const split = stdout.lastIndexOf("\n");
          const {error, middleware, reason_code:reasonCode} = JSON.parse(stdout.slice(0,split));
          if (stdout.slice(split+1) !== "403" || error !== "middleware_denied" ||
              middleware !== "oce-prepared-git" || !/^oce_hook_[a-f0-9]{36}$/.test(reasonCode)) {
            answer(409, {error: "preview_not_observed"});
            return;
          }
          observed = true;
          answer(200, {startupId, probePath, reasonCode});
          return;
        }
        const { installation, expiresAt, signature } = release ?? {};
        const now = Date.now();
        if (settled || released || performance.now() >= deadline ||
            !isDeepStrictEqual(release.challenge, challenge) || !isPlainObject(installation) ||
            (online && (installation.repositoryGitRecipient?.authorization !== enrollment.repositoryGitAuthorization ||
              Object.hasOwn(installation, "peerKeyId"))) ||
            (preview && (!observed || installation.repositoryGitRecipient?.observedHook?.startupId !== challenge.startupId)) ||
            !["sandboxId", "instanceId", "configurationId", ...(online ? [] : ["peerKeyId"])].every((k) =>
              typeof installation[k] === "string" && installation[k].length > 0) ||
            !Number.isSafeInteger(expiresAt) || expiresAt < now || expiresAt > now + 60000 ||
            typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature) ||
            !verify(null, Buffer.from(JSON.stringify([challenge, installation, expiresAt])), key,
              Buffer.from(signature, "base64url"))) {
          answer(409, { error: "stale_enrollment" });
          return;
        }
        // A release is only startup coordination. Both per-request authority
        // checks still run before any material access or business send.
        released = true;
        response.on("finish", () => finish(true));
        answer(200, { enrolled: true, startupId: challenge.startupId });
      } catch {
        if (!response.destroyed) {
          answer(400, { error: "invalid_request" });
        }
      }
    });
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    server.maxConnections = 16;
    const timer = setTimeout(() => finish(false), 180000);
    server.on("error", () => finish(false));
    server.listen(port, "0.0.0.0");
  });
}
`;
