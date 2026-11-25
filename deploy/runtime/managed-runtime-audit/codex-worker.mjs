import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

import { createCodexTraceDecoder } from "./codex-traces.mjs";
import { createAttemptBuffer } from "./codex-transport.mjs";

const limit = 8 * 1024 * 1024;

export async function startAttemptAudit({ token, revisionId }) {
  const selection = process.env.OPENCLAW_HARNESS_MODEL;
  const model = selection.slice(selection.indexOf("/") + 1);
  const buffer = createAttemptBuffer(token, revisionId);
  const decode = createCodexTraceDecoder((row) => {
    if (row.model === model) {
      buffer.emit(row);
    }
  });
  // Only the serving Codex child receives this short-lived exporter credential.
  const authorization = Buffer.from(`Bearer ${randomBytes(32).toString("hex")}`);
  const server = createServer({ requestTimeout: 10_000 }, async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (
      req.method !== "POST" ||
      req.url !== "/v1/traces" ||
      req.headers.host !== `127.0.0.1:${req.socket.localPort}` ||
      supplied.length !== authorization.length ||
      !timingSafeEqual(supplied, authorization)
    ) {
      res.writeHead(403, { connection: "close" }).end();
      return;
    }
    if (req.headers["content-type"] !== "application/json" || req.headers["content-encoding"]) {
      res.writeHead(415, { connection: "close" }).end();
      return;
    }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) {
          res.writeHead(413, { connection: "close" }).end();
          return;
        }
        chunks.push(chunk);
      }
      decode(JSON.parse(Buffer.concat(chunks, size)));
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    } catch {
      // Parser errors can quote the trace body. Never log or return them.
      res.writeHead(400).end();
    }
  });
  server.maxConnections = 4;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  server.unref();
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/traces`;
  return {
    args: [
      "-c",
      `otel.trace_exporter={otlp-http={endpoint="${endpoint}",protocol="json"}}`,
      "-c",
      'shell_environment_policy.set.OTEL_EXPORTER_OTLP_TRACES_HEADERS=""',
    ],
    env: {
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: `authorization=${authorization}`,
      NO_PROXY: [process.env.NO_PROXY ?? process.env.no_proxy, "127.0.0.1"]
        .filter(Boolean)
        .join(","),
    },
    serve: buffer.serve,
  };
}
