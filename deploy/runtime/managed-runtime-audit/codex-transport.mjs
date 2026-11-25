import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

// The existing Pod status port is HTTP. Bind each read and its encrypted reply
// to this revision without sending the App Server credential over that port.
const path = "/runtime/codex-attempts";
const maxRows = 512;
const maxBytes = 512 * 1024;
const maxAgeMs = 60_000;
const digest = /^[0-9a-f]{64}$/;

function transportKey(token, revisionId) {
  if (!token || !revisionId) {
    throw new Error("Missing Codex audit transport identity.");
  }
  return Buffer.from(hkdfSync("sha256", token, revisionId, path, 32));
}

function seal(key, context, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = cipher.update(JSON.stringify(value));
  return Buffer.concat([iv, body, cipher.final(), cipher.getAuthTag()]);
}

function open(key, context, bytes) {
  const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(bytes.subarray(-16));
  const body = cipher.update(bytes.subarray(12, -16));
  return JSON.parse(Buffer.concat([body, cipher.final()]).toString());
}

export function createAttemptBuffer(token, revisionId) {
  const key = transportKey(token, revisionId);
  const rows = [];
  return {
    emit(row) {
      if (rows.length === maxRows) {
        rows.shift();
      }
      rows.push(row);
    },
    serve(request, response) {
      const auth = request.headers.authorization;
      response.setHeader("cache-control", "no-store");
      try {
        if (!auth || auth.length > 256 || !auth.startsWith("Bearer ")) {
          throw new Error();
        }
        const { at, after } = open(key, path, Buffer.from(auth.slice(7), "base64url"));
        if (!Number.isSafeInteger(at) || Math.abs(Date.now() - at) > maxAgeMs) {
          throw new Error();
        }
        const start = rows.findLastIndex((row) => row.modelAttemptId === after) + 1;
        const body = seal(key, auth, rows.slice(start));
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": body.length,
        });
        response.end(body);
      } catch {
        response.writeHead(401).end();
      }
    },
  };
}

export function createAttemptReader() {
  const key = transportKey(process.env.APP_SERVER_TOKEN, process.env.OPENCLAW_AGENT_REVISION_ID);
  const peer = new URL(process.env.APP_SERVER_URL);
  const port = process.env.OPENCLAW_RUNTIME_STATUS_PORT;
  if (peer.protocol !== "ws:" || !peer.hostname.endsWith(".svc") || !/^\d{1,5}$/.test(port)) {
    throw new Error("Missing local Codex worker status address.");
  }
  const url = new URL("http://" + peer.hostname + ":" + port + path);
  let after;
  return async (signal) => {
    const auth = "Bearer " + seal(key, path, { at: Date.now(), after }).toString("base64url");
    const response = await fetch(url, {
      headers: { authorization: auth },
      signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
      redirect: "error",
    });
    if (
      !response.ok ||
      response.headers.has("content-encoding") ||
      !(
        Number(response.headers.get("content-length")) > 0 &&
        Number(response.headers.get("content-length")) <= maxBytes
      )
    ) {
      await response.body?.cancel();
      throw new Error("Invalid Codex worker reply.");
    }
    const rows = open(key, auth, Buffer.from(await response.arrayBuffer()));
    if (
      !Array.isArray(rows) ||
      rows.length > maxRows ||
      rows.some((row) => !digest.test(row?.modelAttemptId))
    ) {
      throw new Error("Invalid Codex attempt list.");
    }
    after = rows.at(-1)?.modelAttemptId ?? after;
    return rows;
  };
}
