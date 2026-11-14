import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export type AlternateTraceEntry = {
  method: string;
  path: string;
  authorizationPresent: boolean;
  cookiePresent: boolean;
  bodyBytes?: number;
  bodyDigest?: string;
  committed?: boolean;
};

type AlternateUpstreamControls = {
  authorize(key: string | string[] | undefined): boolean;
  observe(entry: AlternateTraceEntry): void;
  beforeWriteChunk(): void | Promise<void>;
  revision(): number;
};

export function createAlternateUpstreamHandler({
  authorize,
  observe,
  beforeWriteChunk,
  revision,
}: AlternateUpstreamControls) {
  return (request: IncomingMessage, response: ServerResponse) => {
    const key = request.headers["x-repository-key"];
    if (!authorize(key)) {
      response.writeHead(401).end();
      return;
    }
    const entry: AlternateTraceEntry = {
      // Node fills these fields when it parses the incoming server request.
      method: request.method!,
      path: request.url!,
      authorizationPresent: Object.hasOwn(request.headers, "authorization"),
      cookiePresent: Object.hasOwn(request.headers, "cookie"),
    };
    observe(entry);
    void (async () => {
      if (request.method === "POST") {
        const hash = createHash("sha256");
        entry.bodyBytes = 0;
        entry.committed = false;
        for await (const chunk of request as AsyncIterable<Buffer>) {
          hash.update(chunk);
          entry.bodyBytes += chunk.length;
          await beforeWriteChunk();
        }
        // This backend invalidates predecessors on rotation. Checking again at
        // commit detects rotation while a streamed write still owns that key.
        if (!authorize(key)) {
          response.writeHead(401).end();
          return;
        }
        entry.bodyDigest = hash.digest("hex");
        entry.committed = true;
      }
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ repository: "team/nested/project", revision: revision() }));
    })().catch(() => response.destroy());
  };
}
