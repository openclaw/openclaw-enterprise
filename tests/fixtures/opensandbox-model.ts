import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIPv4 } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { certificateAuthority, signedLeaf } from "../helpers/certificates.ts";
import { encodeSyntheticEvents, syntheticResponsesEvents } from "./synthetic-egress-provider.mjs";

const bodyLimit = 1024 * 1024;
const deadlineMs = 10_000;
const leaseMs = 15 * 60_000;
const privateIPv4 = /^(?:127\.|10\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|192\.168\.)/u;
const noncePattern =
  /\bOCC-OPENSANDBOX-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gu;

async function reply(
  request: IncomingMessage,
  response: ServerResponse,
  model: string,
  bearer: string,
) {
  response.shouldKeepAlive = false;
  if (
    request.headersDistinct.authorization?.length !== 1 ||
    request.headers.authorization !== bearer
  ) {
    response.writeHead(403).end();
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    response.writeHead(404).end();
    return;
  }
  if (!/^application\/json(?:;\s*charset=utf-8)?$/iu.test(request.headers["content-type"] ?? "")) {
    response.writeHead(415).end();
    return;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    if (!Buffer.isBuffer(chunk) || (bytes += chunk.length) > bodyLimit) {
      response.writeHead(413).end();
      return;
    }
    chunks.push(chunk);
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  if (
    !body ||
    typeof body !== "object" ||
    !("model" in body && body.model === model) ||
    !("stream" in body && body.stream === true) ||
    !("store" in body && body.store === false) ||
    !("input" in body && (Array.isArray(body.input) || typeof body.input === "string"))
  ) {
    response.writeHead(400).end();
    return;
  }
  const nonce = JSON.stringify(body.input).match(noncePattern)?.at(-1);
  response
    .writeHead(200, { "content-type": "text/event-stream" })
    .end(encodeSyntheticEvents(syntheticResponsesEvents(model, nonce ?? "CONTROLLED-READY")));
}

const { values } = parseArgs({
  options: { "bind-host": { type: "string" }, model: { type: "string" } },
});
const host = values["bind-host"];
const model = values.model;
if (
  !host ||
  !isIPv4(host) ||
  !privateIPv4.test(host) ||
  !model ||
  !/^[A-Za-z0-9_.-]{1,128}$/u.test(model)
) {
  throw new Error("Give --bind-host a local private IPv4 and --model a bare model ID.");
}

process.umask(0o077);
const directory = await mkdtemp(resolve(tmpdir(), "oce-opensandbox-model-"));
const shutdown = new AbortController();
const stopped = once(shutdown.signal, "abort");
const stop = () => shutdown.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const lease = setTimeout(stop, leaseMs);
let server: Server | undefined;
try {
  const ca = await certificateAuthority(directory, { caName: "OpenSandbox fixture CA" });
  const { key, cert, keyPath } = await signedLeaf(directory, ca, {
    name: "model",
    subjectAltName: `IP:${host}`,
  });
  await Promise.all([rm(keyPath), rm(ca.caKeyPath)]);
  const token = `oce-fixture-${randomBytes(32).toString("hex")}`;
  server = createServer(
    {
      key,
      cert,
      handshakeTimeout: deadlineMs,
      headersTimeout: deadlineMs,
      requestTimeout: deadlineMs,
    },
    (request, response) => {
      const deadline = setTimeout(() => response.destroy(), deadlineMs);
      response.once("close", () => clearTimeout(deadline));
      void reply(request, response, model, `Bearer ${token}`).catch(() => {
        if (!response.destroyed && !response.headersSent) {
          response.writeHead(400).end();
        }
      });
    },
  );
  server.maxConnections = 16;
  server.listen(0, host);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture did not bind a TCP port.");
  }

  const settings = {
    OCC_TEST_CODEX_OPENAI_BASE_URL: `https://${host}:${address.port}/v1`,
    OCC_TEST_OPENAI_MODEL: model,
    OCC_TEST_OPENSANDBOX_MODEL_PLACEHOLDER: token,
    OCC_TEST_OPENSANDBOX_MODEL_CA_PATH: ca.caPath,
  };
  const envPath = join(directory, "model.env");
  const contents = Object.entries(settings)
    .map(([name, value]) => `${name}='${value.replaceAll("'", "'\"'\"'")}'\n`)
    .join("");
  await writeFile(envPath, contents, { flag: "wx", mode: 0o600 });
  console.log(envPath);
  await Promise.race([stopped, once(server, "error").then(([error]) => Promise.reject(error))]);
} finally {
  clearTimeout(lease);
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  try {
    if (server?.listening) {
      const listener = server;
      await new Promise<void>((resolve) => {
        listener.close(() => resolve());
        listener.closeAllConnections();
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
