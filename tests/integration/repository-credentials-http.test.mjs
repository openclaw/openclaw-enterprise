import test from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer, request } from "node:http";
import { createServer as httpsServer } from "node:https";
import { connect } from "node:net";
import { gzipSync } from "node:zlib";
import { appModule } from "../fixtures/repository-credentials/runtime.mjs";
import { createResourceScope } from "../fixtures/repository-credentials/resources.mjs";
import { createTlsMaterial, listen } from "../fixtures/repository-credentials/process.mjs";
import {
  gatewayRequest,
  startCredentialServiceFixture,
} from "../fixtures/repository-credentials/service.mjs";

const { inspectRequestHead } = await appModule("drivers/repo/credentials/transport/request");
const { createUpstreamSender } = await appModule("drivers/repo/credentials/transport/upstream");
const { sendError } = await appModule("drivers/repo/credentials/transport/errors");
const { createSystemClock } = await appModule("drivers/repo/credentials/clock");

const exchange = (port, path, body = Buffer.alloc(0), headers = {}) =>
  new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: body.length ? "POST" : "GET",
        headers: { host: "gateway.example", "content-length": body.length, ...headers },
        agent: false,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });

test(
  "gateway profiles preserve Reader reads, Contributor PR work and Collaborator issue work",
  { timeout: 20000 },
  async (t) => {
    const fixture = await startCredentialServiceFixture(t, {
      profile: "git-write",
      gateway: { listen: "127.0.0.1:0" },
    });
    const reader = {
      ...fixture,
      opened: fixture.service.open({ durationSeconds: 3600, profile: "git-read" }),
    };
    const collaborator = {
      ...fixture,
      opened: fixture.service.open({ durationSeconds: 3600, profile: "git-full" }),
    };
    const path = "/repos/fixture/repository";

    // Cold policy rejection must happen before token issuance or provider dispatch.
    for (const [target, options] of [
      [
        `${path}/pulls`,
        { method: "POST", body: { title: "refused", head: "topic", base: "main" } },
      ],
      [`${path}/issues`, { method: "POST", body: { title: "refused" } }],
      [`${path}/issues/1/comments`, { method: "POST", body: { body: "refused" } }],
      ["/repos/other/repository", {}],
    ]) {
      assert.equal((await gatewayRequest(reader, target, options)).status, 400);
    }
    assert.deepEqual(fixture.github.trace, []);
    assert.deepEqual(fixture.github.issuesOfTokens, []);

    const metadata = await gatewayRequest(reader, path);
    assert.equal(metadata.status, 200);
    assert.equal(JSON.parse(metadata.body).full_name, "fixture/repository");
    const readme = await gatewayRequest(reader, `${path}/readme`, {
      headers: { accept: "application/vnd.github.v3.raw+json" },
    });
    assert.equal(readme.status, 200);
    assert.match(readme.body, /Fixture README/);
    assert.equal(Number(readme.headers["content-length"]), Buffer.byteLength(readme.body));
    assert.equal((await gatewayRequest(reader, `${path}/issues`)).status, 200);
    assert.equal((await gatewayRequest(reader, `${path}/pulls`)).status, 200);
    const graphRead = await gatewayRequest(reader, "/graphql", {
      method: "POST",
      body: { query: "query { viewer { login } }" },
    });
    assert.equal(graphRead.status, 200);
    assert.equal(JSON.parse(graphRead.body).data.viewer.login, "fixture-bot");

    const pull = await gatewayRequest(fixture, `${path}/pulls`, {
      method: "POST",
      body: { title: "Contributor change", head: "topic", base: "main" },
    });
    assert.equal(pull.status, 201);
    const number = JSON.parse(pull.body).number;
    assert.equal(fixture.github.pulls.get(number).title, "Contributor change");
    assert.equal(
      (
        await gatewayRequest(fixture, `${path}/pulls/${number}`, {
          method: "PATCH",
          body: { title: "Updated change" },
        })
      ).status,
      200,
    );
    const discussion = await gatewayRequest(fixture, `${path}/issues/${number}/comments`, {
      method: "POST",
      body: { body: "PR discussion" },
    });
    assert.equal(discussion.status, 201);
    assert.equal(fixture.github.comments.size, 1);
    for (const media of ["application/vnd.github.v3.diff", "application/vnd.github.v3.patch"]) {
      const diff = await gatewayRequest(reader, `${path}/pulls/${number}`, {
        headers: { accept: media },
      });
      assert.equal(diff.status, 200);
      assert.match(diff.body, /diff --git a\/README.md b\/README.md/);
      assert.equal(fixture.github.trace.at(-1).accept, media);
    }

    const created = await gatewayRequest(collaborator, `${path}/issues`, {
      method: "POST",
      body: { title: "Collaborator issue" },
    });
    assert.equal(created.status, 201);
    const issue = JSON.parse(created.body).number;
    const before = fixture.github.trace.length;
    for (const [target, options] of [
      [`${path}/issues`, { method: "POST", body: { title: "refused" } }],
      [`${path}/issues/${issue}`, { method: "PATCH", body: { title: "refused" } }],
    ]) {
      assert.equal((await gatewayRequest(fixture, target, options)).status, 400);
    }
    assert.equal(fixture.github.trace.length, before);
    assert.equal(fixture.github.issues.get(issue).title, "Collaborator issue");

    // Shared conversation routes defer issue-versus-PR authority to the provider token.
    // This controlled provider models its refusal; it is not live GitHub qualification.
    const ordinaryComment = await gatewayRequest(fixture, `${path}/issues/${issue}/comments`, {
      method: "POST",
      body: { body: "refused ordinary issue discussion" },
    });
    assert.equal(ordinaryComment.status, 403);
    assert.equal(fixture.github.comments.size, 1);
    assert.equal(
      (
        await gatewayRequest(collaborator, `${path}/issues/${issue}/comments`, {
          method: "POST",
          body: { body: "Issue discussion" },
        })
      ).status,
      201,
    );

    // Even Reader GraphQL is dispatched once as a possible write; no replay is
    // introduced when the provider response disappears.
    fixture.github.disconnectAfterMutation("POST", "/graphql");
    const graphBefore = fixture.github.trace.length;
    const lost = await gatewayRequest(reader, "/graphql", {
      method: "POST",
      body: { query: "query { viewer { login } }" },
    });
    assert.equal(lost.status, 502);
    assert.equal(fixture.github.trace.length, graphBefore + 1);
    assert.equal(fixture.github.issuesOfTokens.length, 3);
    assert.ok(
      fixture.github.issuesOfTokens.every(
        (token) => token.repositoryIds.length === 1 && token.repositoryIds[0] === 73,
      ),
    );
    assert.deepEqual(fixture.github.errors, []);
  },
);

test(
  "GraphQL refuses provider clone credential selections before token issuance or dispatch",
  { timeout: 15000 },
  async (t) => {
    const fixture = await startCredentialServiceFixture(t, {
      profile: "git-read",
      gateway: { listen: "127.0.0.1:0" },
    });
    const repository = 'repository(owner: "fixture", name: "repository")';
    for (const [target, query] of [
      ["/graphql", `query { ${repository} { tempCloneToken } }`],
      ["/graphql", `query { ${repository} { clone: tempCloneToken } }`],
      [
        "/graphql",
        `query { ${repository} { ...Clone } } fragment Clone on Repository { tempCloneToken }`,
      ],
      ["/graphql?", `query { ${repository} { tempCloneToken } }`],
    ]) {
      const refused = await gatewayRequest(fixture, target, {
        method: "POST",
        body: { query },
      });
      assert.equal(refused.status, 400, target);
      assert.doesNotMatch(refused.body, /synthetic-graphql-cloning-credential/);
    }
    assert.deepEqual(fixture.github.trace, []);
    assert.deepEqual(fixture.github.issuesOfTokens, []);

    const allowed = await gatewayRequest(fixture, "/graphql", {
      method: "POST",
      body: { query: `query { ${repository} { nameWithOwner } }` },
    });
    assert.equal(allowed.status, 200);
    assert.equal(JSON.parse(allowed.body).data.repository.nameWithOwner, "fixture/repository");
    assert.deepEqual(
      fixture.github.trace.filter((entry) => entry.target === "/graphql").map((e) => e.query),
      [`query { ${repository} { nameWithOwner } }`],
    );
    assert.deepEqual(fixture.github.errors, []);
  },
);

test(
  "gateway buffers raw README responses within the API response bound",
  { timeout: 15000 },
  async (t) => {
    const fixture = await startCredentialServiceFixture(t, {
      profile: "git-read",
      gateway: { listen: "127.0.0.1:0" },
      limits: { apiResponseBytes: 16 },
    });
    const response = await gatewayRequest(fixture, "/repos/fixture/repository/readme", {
      headers: { accept: "application/vnd.github.v3.raw+json" },
    });
    assert.equal(response.status, 502);
    assert.doesNotMatch(response.body, /Fixture README/);
    assert.equal(
      fixture.github.trace.filter((entry) => entry.target.endsWith("/readme")).length,
      1,
    );
    assert.deepEqual(fixture.github.errors, []);
  },
);

// These cases exercise actual HTTP parsers, TLS sockets and the production sender.
// Session lease ownership and provider route decisions are covered by composed tests.
test(
  "repository transport framing, bounded streams and dispatch outcomes",
  { timeout: 10000 },
  async (t) => {
    const resources = createResourceScope();
    t.after(() => resources.close());
    const clock = createSystemClock();
    const tls = await createTlsMaterial(resources);
    const received = [];
    const outcomes = [];
    const privateCases = new Map();
    let dispatches = 0;
    let gateOpen = true;
    let observeStreamingChunk;
    const upstream = httpsServer(tls, async (req, res) => {
      const chunks = [];
      try {
        for await (const chunk of req) {
          if (req.url === "/stream") {
            observeStreamingChunk?.();
          }
          chunks.push(chunk);
        }
      } catch {
        return;
      }
      received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      if (req.url === "/disconnect") {
        req.socket.destroy();
        return;
      }
      if (req.url === "/empty") {
        res.writeHead(204, { "set-cookie": "no=forward", "www-authenticate": "no-forward" });
        res.end();
        return;
      }
      if (req.url === "/rewrite") {
        const body = JSON.stringify({ url: "machine", body: "human content" });
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          etag: "old",
        });
        res.end(body);
        return;
      }
      if (req.url === "/encoded-response") {
        res.writeHead(200, { "content-encoding": "gzip" });
        res.end(gzipSync("not identity"));
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.concat(chunks));
    });
    const origin = await listen(resources, upstream);
    const gateway = httpServer(async (req, res) => {
      const parsed = inspectRequestHead(req, {
        authority: "gateway.example",
        receivedMonoMs: clock.monotonicNow(),
        headerBytes: 32768,
        headerPairs: 64,
        targetBytes: 8192,
      });
      if (parsed.kind === "denied") {
        sendError(res, parsed.status, parsed.code);
        return;
      }
      assert.equal(parsed.head.headers.authorization, undefined);
      assert.equal(parsed.head.headers.cookie, undefined);
      const plan = {
        origin: req.url === "/untrusted" ? "https://unexpected.example" : origin,
        target: req.url,
        method: req.method,
        category: "transport",
        effect: "write",
        requestHeaders: {},
        limits: {
          inputWireBytes: 65536,
          inputDecodedBytes: 65536,
          responseBytes: 65536,
          totalMs: 2000,
          inputMs: 1000,
          firstHeaderMs: 1000,
          connectMs: 1000,
          stallMs: 1000,
        },
        responsePolicy: {
          body: req.url === "/rewrite" ? "bounded-json" : "stream",
          headers: (_status, headers) => headers,
          rewriteJson:
            req.url === "/rewrite"
              ? (value) => ({ ...value, url: "rewritten-machine-url" })
              : undefined,
        },
      };
      const tracked = [];
      const privateCase = privateCases.get(req.url);
      const trustedOrigins = new Set(privateCase?.trustedOrigins ?? [origin]);
      const sender = createUpstreamSender({
        request: req,
        response: res,
        head: parsed.head,
        trustedUpstreamOrigins: trustedOrigins,
        headerBytes: privateCase?.headerBytes ?? 32768,
        headerPairs: privateCase?.headerPairs ?? 64,
        upstreamCa: tls.ca,
        clock,
      });
      if (privateCase?.addOriginAfterConstruction) {
        trustedOrigins.add(origin);
      }
      const outcome = await sender(
        {
          plan,
          headers: privateCase?.headers ?? {
            authorization: "Bearer fixture-provider-only",
            "content-type": "application/octet-stream",
          },
        },
        {
          signal: new AbortController().signal,
          deadlineMonoMs: clock.monotonicNow() + 2000,
          gate: {
            dispatch(_cancel, open) {
              if (!gateOpen) {
                throw new Error("closed");
              }
              dispatches++;
              return open();
            },
            track(io) {
              tracked.push(io);
            },
          },
        },
      );
      await Promise.all(tracked);
      outcomes.push({ path: req.url, outcome });
      if (outcome.kind !== "completed") {
        sendError(res, 502, "exchange-failed");
      }
    });
    gateway.on("clientError", (_error, socket) => socket.destroy());
    await listen(resources, gateway);
    const port = gateway.address().port;

    await t.test(
      "gzip input is decoded incrementally and upstream authentication is reconstructed",
      async () => {
        const input = Buffer.from("payload".repeat(4000));
        const response = await exchange(port, "/echo", gzipSync(input), {
          "content-encoding": "gzip",
          authorization: "Bearer fixture-gateway-only",
          cookie: "private=inbound",
        });
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, input);
        const observed = received.at(-1);
        assert.deepEqual(observed.body, input);
        assert.equal(observed.headers["content-encoding"], undefined);
        assert.equal(observed.headers["content-length"], undefined);
        assert.equal(observed.headers.authorization, "Bearer fixture-provider-only");
        assert.equal(observed.headers.cookie, undefined);
      },
    );
    await t.test("input reaches upstream before the client finishes its body", async () => {
      const observed = new Promise((resolve) => {
        observeStreamingChunk = resolve;
      });
      const payload = Buffer.alloc(32768, 42);
      let outgoing;
      const complete = new Promise((resolve, reject) => {
        outgoing = request(
          {
            host: "127.0.0.1",
            port,
            path: "/stream",
            method: "POST",
            headers: { host: "gateway.example", "content-length": payload.length },
            agent: false,
          },
          (incoming) => {
            const chunks = [];
            incoming.on("data", (chunk) => chunks.push(chunk));
            incoming.once("error", reject);
            incoming.once("end", () => resolve(Buffer.concat(chunks)));
          },
        );
        outgoing.once("error", reject);
      });
      outgoing.write(payload.subarray(0, 16384));
      await Promise.race([observed, complete]);
      outgoing.end(payload.subarray(16384));
      assert.deepEqual(await complete, payload);
      observeStreamingChunk = undefined;
    });
    await t.test(
      "bodyless statuses remain bodyless and private upstream headers are removed",
      async () => {
        const response = await exchange(port, "/empty");
        assert.equal(response.status, 204);
        assert.equal(response.body.length, 0);
        assert.equal(response.headers["set-cookie"], undefined);
        assert.equal(response.headers["www-authenticate"], undefined);
      },
    );
    await t.test(
      "structured response rewriting recomputes framing and discards stale integrity",
      async () => {
        const response = await exchange(port, "/rewrite");
        assert.deepEqual(JSON.parse(response.body), {
          url: "rewritten-machine-url",
          body: "human content",
        });
        assert.equal(Number(response.headers["content-length"]), response.body.length);
        assert.equal(response.headers.etag, undefined);
      },
    );
    await t.test("untrusted origins and a closed final gate never open upstream", async () => {
      const before = received.length;
      assert.equal((await exchange(port, "/untrusted")).status, 502);
      gateOpen = false;
      assert.equal((await exchange(port, "/echo")).status, 502);
      gateOpen = true;
      assert.equal(received.length, before);
    });
    await t.test("private headers are canonical and bounded before dispatch", async (t) => {
      let getterCalled = false;
      const accessor = Object.defineProperty({}, "authorization", {
        enumerable: true,
        get() {
          getterCalled = true;
          return "Bearer fixture-provider-only";
        },
      });
      const inherited = Object.assign(Object.create({ authorization: "Bearer inherited" }), {
        accept: "*/*",
      });
      const invalid = [
        {
          name: "duplicate authorization casing",
          headers: { authorization: "Bearer owner", Authorization: "Bearer shadow" },
        },
        {
          name: "duplicate transport header casing",
          headers: { "accept-encoding": "identity", "Accept-Encoding": "gzip" },
        },
        { name: "inherited authentication", headers: inherited },
        { name: "accessor authentication", headers: accessor },
        { name: "symbol header name", headers: { [Symbol("header")]: "ignored" } },
        { name: "non-string authentication", headers: { authorization: 42 } },
        { name: "invalid header name", headers: { "bad name": "value" } },
        {
          name: "authentication line injection",
          headers: { authorization: "Bearer value\r\nx-extra: injected" },
        },
        {
          name: "too many private headers",
          headers: Object.fromEntries(
            Array.from({ length: 65 }, (_, index) => [`x-${index}`, "a"]),
          ),
        },
        { name: "oversized private header", headers: { "x-large": "a".repeat(32768) } },
        {
          name: "reconstructed headers exceed pair limit",
          headers: { authorization: "Bearer fixture-provider-only" },
          headerPairs: 4,
        },
        {
          name: "reconstructed headers exceed byte limit",
          headers: { authorization: "Bearer fixture-provider-only" },
          headerBytes: 100,
        },
      ];
      for (const [index, { name, ...value }] of invalid.entries()) {
        await t.test(name, async () => {
          const target = `/private-headers/${index}`;
          privateCases.set(target, value);
          const before = dispatches;
          assert.equal((await exchange(port, target)).status, 502);
          assert.equal(outcomes.at(-1).outcome.kind, "not-dispatched");
          assert.equal(dispatches, before);
          privateCases.delete(target);
        });
      }
      assert.equal(getterCalled, false);

      // Adapter authentication remains available while all transport fields
      // come from the sender's authority and the inspected incoming framing.
      privateCases.set("/canonical-headers", {
        headers: {
          Authorization: "Bearer fixture-provider-only",
          "X-Repository-Key": "fixture-alternate-only",
          Host: "other.example",
          Connection: "keep-alive",
          "Keep-Alive": "timeout=100",
          "Proxy-Connection": "keep-alive",
          "Proxy-Authenticate": "Basic realm=private",
          "Proxy-Authorization": "Basic private",
          TE: "trailers",
          Trailer: "x-late",
          "Transfer-Encoding": "chunked",
          Upgrade: "websocket",
          Expect: "100-continue",
          Cookie: "private=1",
          "Content-Length": "900",
          "Content-Encoding": "gzip",
          "Accept-Encoding": "gzip",
        },
      });
      assert.equal((await exchange(port, "/canonical-headers", Buffer.from("body"))).status, 200);
      const headers = received.at(-1).headers;
      assert.equal(headers.authorization, "Bearer fixture-provider-only");
      assert.equal(headers["x-repository-key"], "fixture-alternate-only");
      assert.equal(headers.host, new URL(origin).host);
      assert.equal(headers.connection, "close");
      assert.equal(headers["accept-encoding"], "identity");
      assert.equal(headers["content-length"], "4");
      for (const name of [
        "keep-alive",
        "proxy-connection",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "expect",
        "cookie",
        "content-encoding",
      ]) {
        assert.equal(headers[name], undefined);
      }
    });
    await t.test("a sender retains its original trusted origins", async () => {
      const before = dispatches;
      privateCases.set("/later-trusted", { trustedOrigins: [], addOriginAfterConstruction: true });
      assert.equal((await exchange(port, "/later-trusted")).status, 502);
      assert.equal(outcomes.at(-1).outcome.kind, "not-dispatched");
      assert.equal(dispatches, before);
      assert.equal((await exchange(port, "/echo")).status, 200);
      assert.equal(dispatches, before + 1);
    });
    await t.test("possibly accepted writes are not replayed after disconnect", async () => {
      const before = received.length;
      const response = await exchange(port, "/disconnect", Buffer.from("write"));
      assert.equal(response.status, 502);
      assert.deepEqual(JSON.parse(response.body), { error: { code: "exchange-failed" } });
      const deadline = Date.now() + 1000;
      while (!outcomes.some((entry) => entry.path === "/disconnect") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(
        outcomes.find((entry) => entry.path === "/disconnect")?.outcome.kind,
        "possibly-dispatched",
      );
      assert.equal(received.length, before + 1);
    });
    await t.test(
      "decoded input overflow aborts while rejected upstream encoding returns a sanitized error",
      async () => {
        const before = received.length;
        // The decoded body limit cancels the exchange and resets the client connection; no
        // sanitized response is possible once the input pipeline owns the socket.
        await assert.rejects(
          exchange(port, "/echo", gzipSync(Buffer.alloc(70000, 65)), {
            "content-encoding": "gzip",
          }),
          { code: "ECONNRESET" },
        );
        assert.equal(received.length, before, "the oversized body must not reach the upstream");
        const response = await exchange(port, "/encoded-response");
        assert.equal(response.status, 502);
        assert.deepEqual(JSON.parse(response.body), { error: { code: "exchange-failed" } });
      },
    );
    await t.test(
      "duplicate authorization, wrong authority and absolute targets deny before forwarding",
      async (t) => {
        const before = received.length;
        const invalidHeads = [
          {
            name: "duplicate authorization",
            head: "GET /echo HTTP/1.1\r\nHost: gateway.example\r\nAuthorization: Bearer one\r\nAuthorization: Bearer two",
          },
          { name: "wrong authority", head: "GET /echo HTTP/1.1\r\nHost: wrong.example" },
          {
            name: "absolute request target",
            head: "GET https://gateway.example/echo HTTP/1.1\r\nHost: gateway.example",
          },
          {
            name: "conflicting body framing",
            head: "POST /echo HTTP/1.1\r\nHost: gateway.example\r\nContent-Length: 0\r\nTransfer-Encoding: chunked",
          },
        ];
        for (const { name, head } of invalidHeads) {
          await t.test(name, async () => {
            const raw = await new Promise((resolve, reject) => {
              const socket = connect(port, "127.0.0.1");
              let output = "";
              socket.on("connect", () => socket.end(`${head}\r\nConnection: close\r\n\r\n`));
              socket.on("data", (chunk) => (output += chunk));
              socket.on("error", reject);
              socket.on("close", () => resolve(output));
            });
            assert.ok(raw === "" || raw.startsWith("HTTP/1.1 400"));
          });
        }
        assert.equal(received.length, before);
      },
    );
  },
);
