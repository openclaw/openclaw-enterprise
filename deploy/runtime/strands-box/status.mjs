import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { nativeReady } from "./handshake.mjs";

// A distinct listener accepts one authenticated read for this revision. It never
// upgrades or forwards requester bytes. Only the supervisor authenticates to Codex.
export function serveStatus(manifest) {
  const route = "/revisions/" + encodeURIComponent(manifest.revisionId) + "/readiness";
  const server = createServer({ requestTimeout: 8000, headersTimeout: 5000 }, async (req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(value));
    };
    if (req.method !== "GET" || req.url !== route) return reply(404, {});
    try {
      const token = readFileSync("/run/strands-box-probe/token", "utf8");
      const expected = Buffer.from(
        "Bearer " + createHmac("sha256", token).update(route).digest("hex"),
      );
      const header = Buffer.from(req.headers.authorization ?? "");
      if (header.length !== expected.length || !timingSafeEqual(header, expected))
        return reply(401, {});
      if (await nativeReady(manifest.port, token)) return reply(200, { state: "serving" });
      const diagnostic = await fetch(
        "http://127.0.0.1:" + manifest.port + "/openclaw/runtime/status",
        {
          redirect: "error",
          headers: { authorization: "Bearer " + token, "x-oce-readiness": "1" },
          signal: AbortSignal.timeout(1500),
        },
      );
      if (!diagnostic.ok) return reply(503, {});
      const chunks = [];
      let length = 0;
      for await (const chunk of diagnostic.body) {
        length += chunk.length;
        if (length > 16384) throw new Error("Oversize status");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      return reply(
        200,
        body.runtimeFailure
          ? { state: "failed", runtimeFailure: body.runtimeFailure }
          : { state: "starting" },
      );
    } catch {
      return reply(503, {});
    }
  });
  server.maxConnections = 16;
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.listen(manifest.statusPort, "0.0.0.0");
  return server;
}
