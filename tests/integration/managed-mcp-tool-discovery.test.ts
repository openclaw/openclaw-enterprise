import assert from "node:assert/strict";
import test from "node:test";
import { listManagedMcpToolNames } from "../../apps/controller/src/connections/mcp-tool-discovery.ts";
import { asRecord } from "../../packages/utils/src/index.ts";

test("managed MCP discovery reads tool names using one pinned authenticated session", async () => {
  const url = "https://tools.example/api/mcp/v1";
  const token = "fixture-mcp-discovery-token";
  const calls: string[] = [];
  const result = await listManagedMcpToolNames(url, token, undefined, {
    async resolveHost(host) {
      assert.equal(host, "tools.example");
      return [{ address: "8.8.8.8", family: 4 }];
    },
    async fetch(target, request) {
      assert(target instanceof URL);
      assert.equal(target.href, url);
      assert(request);
      assert.equal(request.credentials, "omit");
      assert.equal(request.redirect, "error");
      const headers = new Headers(request.headers);
      assert.equal(headers.get("Authorization"), `Bearer ${token}`);
      if (request.method === "GET" || request.method === "DELETE") {
        assert.equal(headers.get("mcp-session-id"), "fixture-session");
        assert.equal(request.body, undefined);
        calls.push(request.method);
        return new Response(null, { status: 405 });
      }

      assert(typeof request.body === "string");
      const parsed: unknown = JSON.parse(request.body);
      const body = asRecord(parsed);
      assert(body && typeof body.method === "string");
      calls.push(body.method);
      if (body.method === "initialize") {
        return Response.json(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "Document MCP fixture", version: "1" },
            },
          },
          { headers: { "mcp-session-id": "fixture-session" } },
        );
      }
      assert.equal(headers.get("mcp-session-id"), "fixture-session");
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      assert.equal(body.method, "tools/list");
      const params = asRecord(body.params);
      assert(body.params === undefined || params);
      const secondPage = params?.cursor === "next";
      const payload = {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [
            {
              name: secondPage ? "create_document" : "search_documents",
              inputSchema: { type: "object" },
            },
          ],
          ...(secondPage ? {} : { nextCursor: "next" }),
        },
      };
      return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  assert.deepEqual([...result], ["search_documents", "create_document"]);
  assert.deepEqual(
    calls.filter((method) => method !== "GET"),
    ["initialize", "notifications/initialized", "tools/list", "tools/list", "DELETE"],
  );
});

test("managed MCP discovery refuses private DNS answers and redirects", async () => {
  const url = "https://tools.example/api/mcp/v1";
  const token = "fixture-mcp-discovery-token";
  let attempted = false;
  await assert.rejects(
    listManagedMcpToolNames(url, token, undefined, {
      resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
      async fetch() {
        attempted = true;
        throw new Error("Unexpected request");
      },
    }),
    { reason: "unavailable" },
  );
  assert.equal(attempted, false);
  const targets: string[] = [];
  await assert.rejects(
    listManagedMcpToolNames(url, token, undefined, {
      resolveHost: async () => [{ address: "8.8.8.8", family: 4 }],
      async fetch(target) {
        assert(target instanceof URL);
        targets.push(target.href);
        return Response.redirect("https://other.example/mcp");
      },
    }),
    { reason: "invalid_response" },
  );
  assert.deepEqual(targets, [url]);
});
