import assert from "node:assert/strict";
import test from "node:test";
import { listManagedMcpToolNames } from "../../apps/controller/src/connections/mcp-tool-discovery.ts";
import { asRecord } from "../../packages/utils/src/index.ts";

test("managed MCP discovery reads tool names using one pinned authenticated session", async () => {
  const url = "https://tools.example/api/mcp/v1";
  const token = "fixture-mcp-discovery-token";
  const calls: string[] = [];
  const result = await listManagedMcpToolNames(url, token, undefined, {
    allowedMethods: ["POST", "GET", "DELETE"],
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

test("POST-only MCP discovery loads tools without sending optional session requests", async () => {
  const calls: string[] = [];
  const result = await listManagedMcpToolNames(
    "https://tools.example/mcp",
    "fixture-mcp-post-only-token",
    undefined,
    {
      resolveHost: async () => [{ address: "8.8.8.8", family: 4 }],
      // The fetch boundary represents the peer. An unapproved SDK GET or DELETE must never
      // reach it, even though the peer assigns a session ID during initialization.
      async fetch(_target, request) {
        assert.equal(request?.method, "POST");
        assert(typeof request.body === "string");
        const body = asRecord(JSON.parse(request.body));
        assert(body && typeof body.method === "string");
        calls.push(body.method);
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        const response =
          body.method === "initialize"
            ? {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "POST-only MCP fixture", version: "1" },
              }
            : { tools: [{ name: "search", inputSchema: { type: "object" } }] };
        return Response.json(
          { jsonrpc: "2.0", id: body.id, result: response },
          { headers: { "mcp-session-id": "fixture-session" } },
        );
      },
    },
  );
  assert.deepEqual([...result], ["search"]);
  assert.deepEqual(calls, ["initialize", "notifications/initialized", "tools/list"]);
});

test("MCP discovery rechecks authorization before each credential-bearing session request", async () => {
  const calls: string[] = [];
  let initialized = false;
  const token = "fixture-mcp-revoked-token";
  await assert.rejects(
    listManagedMcpToolNames("https://tools.example/mcp", token, undefined, {
      allowedMethods: ["POST", "GET", "DELETE"],
      resolveHost: async () => [{ address: "8.8.8.8", family: 4 }],
      async beforeRequest() {
        if (initialized) {
          throw new Error("Source authorization was withdrawn");
        }
      },
      async fetch(_target, request) {
        const method = request?.method ?? "GET";
        if (method !== "POST") {
          calls.push(method);
          return new Response(null, { status: 405 });
        }
        assert(request && typeof request.body === "string");
        const body = asRecord(JSON.parse(request.body));
        assert(body && typeof body.method === "string");
        calls.push(body.method);
        assert.equal(new Headers(request.headers).get("Authorization"), `Bearer ${token}`);
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        const result =
          body.method === "initialize"
            ? {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "Revocation MCP fixture", version: "1" },
              }
            : { tools: [{ name: "search", inputSchema: { type: "object" } }] };
        // Withdrawal occurs after the peer accepts initialization. Neither the following
        // SDK message nor optional GET/DELETE session cleanup may receive the bearer.
        initialized = true;
        return Response.json(
          { jsonrpc: "2.0", id: body.id, result },
          { headers: { "mcp-session-id": "fixture-session" } },
        );
      },
    }),
    { reason: "invalid_response" },
  );
  assert.deepEqual(calls, ["initialize"]);
});

test("MCP discovery cannot dispatch after cancellation while authorization is pending", async () => {
  const entered = Promise.withResolvers<void>();
  const authorization = Promise.withResolvers<void>();
  const caller = new AbortController();
  let fetches = 0;
  const discovery = listManagedMcpToolNames(
    "https://tools.example/mcp",
    "fixture-mcp-cancelled-token",
    caller.signal,
    {
      resolveHost: async () => [{ address: "8.8.8.8", family: 4 }],
      beforeRequest() {
        entered.resolve();
        return authorization.promise;
      },
      async fetch() {
        fetches += 1;
        return new Response(null, { status: 500 });
      },
    },
  );
  await entered.promise;
  // This is a controlled cancellation: authorization settles only after the caller aborts.
  caller.abort();
  authorization.resolve();
  await assert.rejects(discovery, { reason: "unavailable" });
  assert.equal(fetches, 0);
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
