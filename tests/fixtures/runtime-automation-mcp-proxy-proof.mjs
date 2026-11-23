/* global AUTOMATION_MCP_PROXY_PORT, assertAutomationMcpProxyProjection, compileAutomationMcpProxy, startAutomationMcpProxy */
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdirSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { createServer, request: httpsRequest } = require("node:https");
const { once } = require("node:events");
const { request: httpRequest } = require("node:http");
const { spawn } = require("node:child_process");

/* AUTOMATION_MCP_PROXY_SOURCE */

(async () => {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const digest = createHash("sha256").update(input.cert).digest("hex");
  const caPath = "/etc/openclaw-automation-trust/automation-ca-" + digest + ".pem";
  mkdirSync("/etc/openclaw-automation-trust", { recursive: true });
  writeFileSync(caPath, input.cert, { mode: 0o600 });
  let mode = "ok";
  let approvedCalls = 0;
  let sameOriginSink = 0;
  let otherOriginSink = 0;
  let siblingIpEffects = 0;
  let untrustedEffects = 0;
  let lastHeaders;
  let lastBody;
  let lastMethod;
  let sinkBody;
  let eventOpen = false;
  let releaseEvent;
  const sink = createServer({ cert: input.cert, key: input.key }, (request, response) => {
    otherOriginSink++;
    request.resume();
    response.end("unexpected");
  });
  sink.listen(0, "127.0.0.1");
  await once(sink, "listening");
  const peer = createServer({ cert: input.cert, key: input.key }, async (request, response) => {
    if (request.url === "/sink") {
      sameOriginSink++;
      const body = [];
      for await (const chunk of request) {
        body.push(chunk);
      }
      sinkBody = Buffer.concat(body).toString("utf8");
      const message = JSON.parse(sinkBody);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            serverInfo: { name: "redirect-sink", version: "1" },
          },
        }),
      );
      return;
    }
    approvedCalls++;
    lastHeaders = request.headers;
    lastMethod = request.method;
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    lastBody = Buffer.concat(chunks).toString("utf8");
    if (mode === "events") {
      eventOpen = true;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "mcp-session-id": "event-session",
      });
      response.write("event: message\ndata: first\n\n");
      await new Promise((resolve) => {
        releaseEvent = resolve;
      });
      eventOpen = false;
      response.end("event: message\ndata: second\n\n");
      return;
    }
    if (mode === "native") {
      const message = lastBody ? JSON.parse(lastBody) : undefined;
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "native-session",
      });
      response.end(
        JSON.stringify(
          message?.id === undefined
            ? {}
            : {
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocolVersion: "2025-03-26",
                  capabilities: {},
                  serverInfo: { name: "fixture", version: "1" },
                },
              },
        ),
      );
      return;
    }
    if (mode === "cross") {
      response.writeHead(307, {
        location: "https://localhost:" + sink.address().port + "/sink",
        "www-authenticate": 'Bearer resource_metadata="https://localhost/metadata"',
        "set-cookie": "synthetic=blocked",
        link: "<https://localhost/metadata>",
      });
    } else if (mode === "same") {
      response.writeHead(308, { location: "/sink" });
    } else if (mode === "auth") {
      response.writeHead(401, {
        "www-authenticate": 'Bearer resource_metadata="https://localhost/metadata"',
      });
    } else {
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "fixture-session",
      });
    }
    response.end('{"ok":true}');
  });
  peer.listen(0, "127.0.0.1");
  await once(peer, "listening");
  // All denied destinations are independently reachable. Their handlers count HTTP
  // effects, so a failed TLS handshake or target mutation cannot pass unnoticed.
  const siblingIp = createServer({ cert: input.cert, key: input.key }, (request, response) => {
    siblingIpEffects++;
    request.resume();
    response.end("sibling");
  });
  siblingIp.listen(peer.address().port, "127.0.0.2");
  await once(siblingIp, "listening");
  const untrustedPeer = createServer(
    { cert: input.untrustedCert, key: input.untrustedKey },
    (request, response) => {
      untrustedEffects++;
      request.resume();
      response.end("untrusted");
    },
  );
  untrustedPeer.listen(0, "127.0.0.1");
  await once(untrustedPeer, "listening");
  const control = (hostname, port, ca, servername) =>
    new Promise((resolve, reject) => {
      const request = httpsRequest({ hostname, port, ca, servername, path: "/mcp" }, (response) => {
        response.resume();
        response.once("end", resolve);
      });
      request.once("error", reject);
      request.end();
    });
  await control("127.0.0.2", peer.address().port, input.cert, "localhost");
  await control("localhost", sink.address().port, input.cert, "localhost");
  await control("localhost", untrustedPeer.address().port, input.untrustedCert, "localhost");
  assert.deepEqual([siblingIpEffects, otherOriginSink, untrustedEffects], [1, 1, 1]);
  siblingIpEffects = 0;
  otherOriginSink = 0;
  untrustedEffects = 0;
  const target = "https://localhost:" + peer.address().port + "/mcp";
  const route = {
    server: "approved",
    path: "/mcp/" + "a".repeat(64),
    url: target,
    egressCidrs: ["127.0.0.1/32"],
    caPath,
    caSha256: digest,
  };
  const denied = {
    ...route,
    server: "denied",
    path: "/mcp/" + "b".repeat(64),
    egressCidrs: ["127.0.0.2/32"],
  };
  const wrongHost = {
    ...route,
    server: "wrongHost",
    path: "/mcp/" + "c".repeat(64),
    url: "https://127.0.0.2:" + peer.address().port + "/mcp",
    egressCidrs: ["127.0.0.2/32"],
  };
  const untrustedChain = {
    ...route,
    server: "untrustedChain",
    path: "/mcp/" + "d".repeat(64),
    url: "https://localhost:" + untrustedPeer.address().port + "/mcp",
  };
  const configuration = {
    port: AUTOMATION_MCP_PROXY_PORT,
    routes: [route, denied, wrongHost, untrustedChain],
  };
  const projection = {
    mcp: {
      servers: Object.fromEntries(
        configuration.routes.map((entry) => [
          entry.server,
          {
            transport: "streamable-http",
            url: "http://127.0.0.1:" + configuration.port + entry.path,
          },
        ]),
      ),
    },
  };
  assertAutomationMcpProxyProjection(configuration, projection);
  assert.throws(
    () =>
      assertAutomationMcpProxyProjection(configuration, {
        mcp: { servers: { approved: { transport: "streamable-http", url: target } } },
      }),
    { message: "Automation MCP proxy configuration is invalid." },
  );
  let failed = false;
  const proxy = await startAutomationMcpProxy(configuration, () => {
    failed = true;
  });
  const local = "http://127.0.0.1:" + configuration.port;
  const send = (path, headers = {}) =>
    fetch(local + path, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-method": "tools/call",
        "mcp-name": "approved",
        ...headers,
      },
      body: '{"jsonrpc":"2.0","method":"tools/call","params":{"nonce":"synthetic"}}',
    });
  const good = await send(route.path);
  assert.equal(good.status, 200);
  assert.equal(good.headers.get("mcp-session-id"), "fixture-session");
  assert.equal(lastBody.includes("synthetic"), true);
  assert.equal(lastHeaders["mcp-method"], "tools/call");
  assert.equal(lastHeaders.authorization, undefined);
  assert.equal(lastHeaders.cookie, undefined);
  assert.equal(lastHeaders.host, "localhost:" + peer.address().port);
  let untrustedCaCode;
  await assert.rejects(fetch("https://127.0.0.1:" + peer.address().port + "/mcp"), (error) => {
    untrustedCaCode = error?.cause?.code;
    return untrustedCaCode === "DEPTH_ZERO_SELF_SIGNED_CERT";
  });
  assert.throws(
    () =>
      compileAutomationMcpProxy({
        port: configuration.port,
        routes: [
          {
            ...route,
            url: "https://[::1]:" + peer.address().port + "/mcp",
            egressCidrs: ["::2/128"],
          },
        ],
      }),
    { message: "Automation MCP proxy configuration is invalid." },
  );
  const beforeDenied = approvedCalls;
  const wrongHostStatus = (await send(wrongHost.path)).status;
  const untrustedChainStatus = (await send(untrustedChain.path)).status;
  const mutateHost = (host) =>
    new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: "127.0.0.1",
          port: configuration.port,
          path: route.path,
          method: "POST",
          headers: { host },
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode));
        },
      );
      request.once("error", reject);
      request.end();
    });
  const siblingIpStatus = await mutateHost("127.0.0.2:" + peer.address().port);
  const siblingPortStatus = await mutateHost("127.0.0.1:" + sink.address().port);
  const securityNegatives = {
    wrongHost: wrongHostStatus,
    untrustedChain: untrustedChainStatus,
    siblingIp: siblingIpStatus,
    siblingPort: siblingPortStatus,
    unauthorizedEffects:
      siblingIpEffects + otherOriginSink + untrustedEffects + approvedCalls - beforeDenied,
  };
  const badAddress = await send(denied.path);
  assert.equal(badAddress.status, 502);
  const deniedAddressPeerCalls = approvedCalls - beforeDenied;
  const badHeader = await send(route.path, { authorization: "synthetic" });
  assert.equal(badHeader.status, 400);
  assert.equal(approvedCalls, beforeDenied);
  const beforeOverflow = approvedCalls;
  const overflowStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(
      local + route.path,
      { method: "POST", headers: { "content-length": String(4 * 1024 * 1024 + 1) } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.once("error", reject);
    request.end();
  });
  assert.equal(overflowStatus, 413);
  const overflowPeerCalls = approvedCalls - beforeOverflow;
  const streamedBeforeClose = [];
  for (const method of ["GET", "POST"]) {
    mode = "events";
    const result = await fetch(local + route.path, {
      method,
      headers: {
        accept: "text/event-stream",
        "mcp-session-id": "event-session",
        "mcp-protocol-version": "2025-03-26",
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    const reader = result.body.getReader();
    const first = await reader.read();
    streamedBeforeClose.push(eventOpen && Buffer.from(first.value).toString().includes("first"));
    assert.equal(lastHeaders["mcp-session-id"], "event-session");
    assert.equal(lastHeaders["mcp-protocol-version"], "2025-03-26");
    releaseEvent();
    for (;;) {
      if ((await reader.read()).done) {
        break;
      }
    }
  }
  mode = "ok";
  const deleted = await fetch(local + route.path, {
    method: "DELETE",
    headers: { "mcp-session-id": "event-session", "mcp-protocol-version": "2025-03-26" },
  });
  assert.equal(deleted.status, 200);
  assert.equal(lastMethod, "DELETE");
  assert.equal(lastHeaders["mcp-session-id"], "event-session");
  const chunks = readdirSync("/app/node_modules/openclaw/dist").filter((name) =>
    /^mcp-transport-[A-Za-z0-9_-]{8}\.mjs$/.test(name),
  );
  assert.equal(chunks.length, 1);
  const { resolveMcpTransport } = await import(
    "file:///app/node_modules/openclaw/dist/" + chunks[0]
  );
  const nativeModule = "file:///app/node_modules/openclaw/dist/" + chunks[0];
  mode = "same";
  const directSource = [
    "const { resolveMcpTransport } = await import(process.argv[1]);",
    'const selected = resolveMcpTransport("approved", { transport: "streamable-http", url: process.argv[2] });',
    "selected.transport.onerror = () => {};",
    "await selected.transport.start();",
    'await selected.transport.send({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"synthetic-red",version:"1"}}});',
    "await selected.transport.close();",
  ].join("\n");
  const direct = spawn(
    process.execPath,
    ["--input-type=module", "-e", directSource, nativeModule, target],
    { env: { ...process.env, NODE_EXTRA_CA_CERTS: caPath }, stdio: "ignore" },
  );
  const directExit = await new Promise((resolve, reject) => {
    direct.once("error", reject);
    direct.once("exit", resolve);
  });
  assert.equal(directExit, 0);
  const preFixReplayCalls = sameOriginSink;
  const preFixReplayBody = sinkBody?.includes("synthetic-red") === true;
  sameOriginSink = 0;
  mode = "native";
  const selected = resolveMcpTransport("approved", {
    transport: "streamable-http",
    url: local + route.path,
  });
  assert.ok(selected?.transport);
  let nativeMessage;
  selected.transport.onmessage = (message) => {
    nativeMessage = message;
  };
  selected.transport.onerror = () => {};
  await selected.transport.start();
  await selected.transport.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "fixture", version: "1" },
    },
  });
  assert.equal(nativeMessage?.result?.serverInfo?.name, "fixture");
  await selected.transport.close();
  mode = "same";
  const bridgedRedirect = resolveMcpTransport("approved", {
    transport: "streamable-http",
    url: local + route.path,
  });
  bridgedRedirect.transport.onerror = () => {};
  await bridgedRedirect.transport.start();
  await assert.rejects(
    bridgedRedirect.transport.send({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "synthetic-green", version: "1" },
      },
    }),
    (error) =>
      error?.name === "SdkHttpError" && error?.message?.includes("automation_mcp_unavailable"),
  );
  await bridgedRedirect.transport.close();
  for (const responseMode of ["cross", "same", "auth"]) {
    mode = responseMode;
    const result = await send(route.path);
    assert.equal(result.status, 502);
    for (const header of [
      "location",
      "www-authenticate",
      "set-cookie",
      "link",
      "content-location",
    ]) {
      assert.equal(result.headers.get(header), null);
    }
  }
  assert.equal(sameOriginSink, 0);
  assert.equal(otherOriginSink, 0);
  assert.equal(failed, false);
  await assert.rejects(
    startAutomationMcpProxy(configuration, () => {}),
    { code: "EADDRINUSE" },
  );
  proxy.close();
  peer.closeAllConnections();
  sink.closeAllConnections();
  siblingIp.closeAllConnections();
  untrustedPeer.closeAllConnections();
  await Promise.all([
    new Promise((resolve) => peer.close(resolve)),
    new Promise((resolve) => sink.close(resolve)),
    new Promise((resolve) => siblingIp.close(resolve)),
    new Promise((resolve) => untrustedPeer.close(resolve)),
  ]);
  console.log(
    JSON.stringify({
      approvedCalls,
      sameOriginSink,
      otherOriginSink,
      untrustedCaCode,
      deniedAddressPeerCalls,
      securityNegatives,
      nativeServer: nativeMessage?.result?.serverInfo?.name,
      preFixReplayCalls,
      preFixReplayBody,
      streamedBeforeClose,
      overflowPeerCalls,
    }),
  );
})().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
