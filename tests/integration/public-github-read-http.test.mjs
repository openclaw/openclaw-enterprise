import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { connect as connectTcp, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPublicGithubReadServer } from "../../apps/controller/src/drivers/repo/github/public-read/server.ts";
import { selfSigned } from "../helpers/certificates.mjs";

// Request headers a client never finishes, so the reader holds the connection open.
const unfinished = "GET /healthz HTTP/1.1\r\nHost: reader\r\n";
// The fixed answer to a connection over the per-address cap, as the client reads it.
const refusal =
  /^HTTP\/1\.1 429 Too Many Requests\r\n(?=[^]*\r\nretry-after: 1\r\n)(?=[^]*\r\nconnection: close\r\n)[^]*too many reader connections/;
// Unlike events.once, these never reject on the socket errors a reset produces.
const event = (emitter, name) => new Promise((resolve) => emitter.once(name, resolve));
const closed = (socket) => socket.closed || event(socket, "close");
// Everything a raw client reads until the reader ends or resets the connection.
const received = (client) =>
  new Promise((resolve) => {
    let text = "";
    if (client.closed || client.readableEnded) {
      resolve(text);
      return;
    }
    client.setEncoding("utf8").on("data", (chunk) => (text += chunk));
    client.once("end", () => resolve(text)).once("close", () => resolve(text));
  });
// A GET from one caller address, read to the end: { status, headers, body (JSON) }.
const request = (url, localAddress) =>
  new Promise((resolve, reject) => {
    http
      .get(url, { agent: false, localAddress }, async (res) => {
        let text = "";
        res.setEncoding("utf8");
        try {
          for await (const chunk of res) {
            text += chunk;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) });
        } catch (error) {
          reject(error);
        }
      })
      .once("error", reject);
  });
const json = { "content-type": "application/json" };
// A provider answer that ends a held or ordinary read successfully.
const ok = (res) => res.writeHead(200, json).end("{}");
// The only headers the reader sends GitHub: no client headers or credentials pass through.
const githubHeaders = "accept accept-encoding connection host user-agent x-github-api-version";

// Starts a reader on loopback for one test. `connect` pairs a raw client with the reader's
// side of its connection; `hold` opens connections that never finish their request headers.
async function startReader(t) {
  const server = createPublicGithubReadServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const clients = [];
  t.after(() => {
    clients.forEach((client) => client.destroy());
    server.closeAllConnections();
    server.close();
  });
  const port = server.address().port;
  const connect = async (options = {}) => {
    const accepted = once(server, "connection");
    const client = connectTcp({ port, host: "127.0.0.1", ...options });
    client.on("error", () => {});
    clients.push(client);
    await once(client, "connect");
    const [socket] = await accepted;
    return { client, socket };
  };
  const hold = async (count, localAddress) => {
    const held = [];
    for (let open = 0; open < count; open++) {
      const connection = await connect({ localAddress });
      connection.client.resume().write(unfinished);
      held.push(connection);
    }
    return held;
  };
  return { server, base: "http://127.0.0.1:" + port, connect, hold };
}

test("public GitHub reader enforces anonymous GET, fresh visibility, bounded responses and shared quota", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "public-github-provider-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const name = "api.github.com";
  const { key, cert } = await selfSigned(directory, {
    commonName: name,
    subjectAltName: `DNS:${name}`,
  });
  let reply;
  let requests = 0;
  const provider = https
    .createServer({ cert, key }, (req, res) => {
      requests++;
      assert.equal(req.method, "GET");
      assert.equal(req.headers.host, name);
      assert.equal(req.socket.servername, name);
      assert.equal(Object.keys(req.headers).sort().join(" "), githubHeaders);
      reply(req, res);
    })
    .listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(() => {
    provider.closeAllConnections();
    provider.close();
  });

  // Route only the provider's DNS, port and test CA to loopback. The reader
  // constructs the actual HTTPS request and uses normal hostname verification.
  const connect = https.Agent.prototype.createConnection;
  t.mock.method(https.Agent.prototype, "createConnection", function (options, callback) {
    assert.equal(options.host, name);
    assert.equal(options.port, 443);
    assert.notEqual(options.rejectUnauthorized, false);
    return connect.call(
      this,
      { ...options, host: "127.0.0.1", port: provider.address().port, servername: name, ca: cert },
      callback,
    );
  });
  const { base: origin } = await startReader(t);
  const repo = "/repos/example/project";
  const get = (path = "", options) => fetch(origin + repo + path, options);
  const query = (url) => Object.fromEntries(url.searchParams);
  // The local page a response's first link names.
  const linked = (response) => new URL(response.headers.get("link").split(">")[0].slice(1), origin);
  // Each Agent Pod is a separate caller address; loopback aliases stand in for them.
  const from = (address, path, base = origin) => request(base + repo + path, address);
  const aliases = ["127.0.0.2", "127.0.0.3", "127.0.0.4"];
  const probe = createTcpServer();
  const aliased = await new Promise((resolve) => {
    probe.once("error", () => resolve(false));
    probe.listen(0, aliases.at(-1), () => probe.close(() => resolve(true)));
  });
  // Bound the cases that wait for held provider reads, so a regression fails instead of hanging.
  const multipleCallers = aliased
    ? { timeout: 15_000 }
    : { skip: "loopback aliases 127.0.0.2-4 are unavailable" };
  const answer = (status, body, headers) => {
    reply = (req, res) => res.writeHead(status, { ...json, ...headers }).end(JSON.stringify(body));
  };
  // GitHub denies its anonymous quota once. Every later read, from any caller, is parked with
  // the shared retry time (above `minimum` seconds) instead of spending more quota.
  const assertParked = async (
    headers,
    minimum,
    reads,
    body = { message: "API rate limit exceeded" },
  ) => {
    const quota = { "x-ratelimit-remaining": "0", ...headers };
    answer(403, body, quota);
    const before = requests;
    for (const [address, path, base] of reads) {
      const parked = await from(address, path, base);
      assert.equal(parked.status, 429);
      assert.ok(Number(parked.headers["retry-after"]) > minimum, parked.headers["retry-after"]);
    }
    assert.equal(
      requests,
      before + 1,
      "another reader should not spend quota during a known denial",
    );
  };
  const issues = "https://api.github.com/repositories/12/issues?";
  // A provider listing whose next page is this link.
  const nextPage = (link) => answer(200, [], { link: `<${link}>; rel="next"` });

  await t.test(
    "public pull data and local pagination, then an opaque 404 if visibility changes",
    async () => {
      answer(200, [{ number: 7, merged_at: "2026-02-01T03:00:00Z" }], {
        link: '<https://api.github.com/repositories/12/pulls?page=2>; rel="next", <https://unrelated.invalid/>; rel="last"',
        "set-cookie": "discard=provider",
      });
      const headers = {
        authorization: "Bearer synthetic-input",
        cookie: "discard=client",
        accept: "text/html",
        "if-none-match": "discard",
        "x-forwarded-host": "unrelated.invalid",
      };
      const path = "/pulls?state=closed&sort=updated&per_page=100";
      const response = await get(path, { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal((await response.json())[0].number, 7);
      assert.match(response.headers.get("link"), /^<.*>; rel="next"$/);
      const next = linked(response);
      assert.equal(next.origin, origin);
      assert.equal(next.pathname, repo + "/pulls");
      // The next page keeps the original query.
      assert.deepEqual(query(next), { ...query(new URL(path, origin)), page: "2" });

      answer(404, { message: "provider details must not escape" });
      const missing = await get(path);
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), { message: "Not found" });
      assert.equal(requests, 2, "a repository made private must never be served from a cache");
    },
  );
  await t.test("issue cursors survive local pagination when earlier issues disappear", async () => {
    const issued = "opaque+/cursor==";
    reply = (req, res) => {
      const url = new URL(req.url, "https://api.github.com");
      const after = url.searchParams.get("after");
      if (!url.searchParams.has("page")) {
        const next = new URL(issues + "per_page=2&page=2&state=open");
        next.searchParams.set("after", issued);
        res.writeHead(200, { ...json, link: `<${next}>; rel="next"` });
        res.end(JSON.stringify([{ number: 1 }, { number: 2 }]));
      } else {
        assert.equal(url.searchParams.get("state"), "all");
        res.writeHead(200, json);
        // After issue 1 disappears, offset page 2 is empty; the issued cursor still finds issue 3.
        res.end(JSON.stringify(after === issued ? [{ number: 3 }] : []));
      }
    };
    const numbers = async (response) => (await response.json()).map(({ number }) => number);
    const first = await get("/issues?state=all&per_page=2");
    assert.deepEqual(await numbers(first), [1, 2]);
    const next = linked(first);
    assert.equal(next.pathname, repo + "/issues");
    assert.deepEqual(query(next), { per_page: "2", state: "all", page: "2", after: issued });
    const second = await fetch(next);
    assert.equal(second.status, 200);
    assert.deepEqual(await numbers(second), [3]);

    const newer = new URL(issues + "page=3");
    newer.searchParams.set("before", "next_cursor");
    nextPage(newer);
    const replaced = linked(await fetch(next));
    assert.equal(replaced.searchParams.get("after"), null);
    assert.equal(replaced.searchParams.get("before"), "next_cursor");

    nextPage("https://api.github.com/repos/example/project/issues?page=2&after=cursor");
    const named = await fetch(origin + "/repos/Example/Project/issues?state=all");
    assert.equal(named.status, 200);
    const namedNext = linked(named);
    assert.equal(namedNext.pathname, "/repos/Example/Project/issues");
    assert.equal(namedNext.searchParams.get("after"), "cursor");
  });
  await t.test("unsafe issue continuations fail instead of reporting a complete list", async () => {
    for (const [path, link] of [
      ...[
        "page=2&after=invalid%20cursor",
        "page=2&after=one&after=two",
        "page=2&after=one&before=two",
        "page=2&page=3&after=one",
        "page=2&after=" + "a".repeat(1025),
        "page=1001&after=one",
        "after=one",
        "page=2&after=" + "%2F".repeat(700),
      ].map((query) => ["/issues?state=all", `<${issues}${query}>; rel="next"`]),
      ["/issues", `<${issues}page=2>; rel=next`],
      ["/issues", '<https://unrelated.invalid/repositories/12/issues?page=2>; rel="next"'],
      ["/pulls", '<https://api.github.com/repositories/12/pulls?page=2&after=cursor>; rel="next"'],
    ]) {
      answer(200, [], { link });
      const response = await get(path);
      assert.equal(response.status, 502, link);
      assert.match((await response.json()).message, /incomplete/i);
    }
    const before = requests;
    for (const path of [
      "/issues?after=bad%20cursor",
      "/issues?after=one&after=two",
      "/issues?after=one&before=two",
      "/issues?after=" + "a".repeat(1025),
      "/issues/1?after=one",
      "/pulls?after=one",
      "/releases?before=one",
    ]) {
      assert.equal((await get(path)).status, 400, path);
    }
    assert.equal(requests, before);
  });
  await t.test("page 1000 succeeds only if the provider has no next page", async () => {
    answer(200, []);
    const last = await get("/pulls?page=1000");
    assert.equal(last.status, 200);
    assert.equal(last.headers.get("link"), null);

    for (const [path, next] of [
      ["/pulls?page=1000", "pulls?page=1001"],
      ["/issues?page=1000", "issues?page=1000&after=cursor"],
    ]) {
      nextPage("https://api.github.com/repositories/12/" + next);
      const incomplete = await get(path);
      assert.equal(incomplete.status, 502, path);
      assert.match((await incomplete.json()).message, /incomplete.*1000/i);
    }
  });
  await t.test("a directory at GitHub's entry limit cannot establish completeness", async () => {
    const entries = (length) =>
      Array.from({ length }, () => ({ name: "entry", type: "file", size: 0 }));
    answer(200, entries(999));
    const belowLimit = await get("/contents");
    assert.equal(belowLimit.status, 200);
    assert.equal((await belowLimit.json()).length, 999);

    answer(200, entries(1000));
    const atLimit = await get("/contents");
    assert.equal(atLimit.status, 502);
    assert.match((await atLimit.json()).message, /possibly incomplete.*1000/i);
  });
  await t.test(
    "writes, bodies and alternate routes fail locally; provider redirects are never followed",
    async () => {
      const before = requests;
      const write = await get("/pulls", { method: "POST", body: "{}" });
      assert.equal(write.status, 405);
      assert.equal(write.headers.get("allow"), "GET");
      const withBody = await new Promise((resolve, reject) => {
        http
          .request(origin + repo, { headers: { "content-length": "2" } }, resolve)
          .once("error", reject)
          .end("{}");
      });
      assert.equal(withBody.statusCode, 400);
      withBody.resume();
      for (const path of [
        "?access_token=synthetic",
        "/pulls?per_page=101",
        "/contents/%2e%2e%2fprivate",
        "/contents/file?raw=true",
        "/pulls?sort=updated&sort=created",
        "/releases/download/file",
      ]) {
        assert.equal((await get(path)).status, 400, path);
      }
      assert.equal((await fetch(origin + "/graphql")).status, 400);
      assert.equal(requests, before);
      answer(302, {}, { location: "https://unrelated.invalid/redirect" });
      const redirect = await get();
      assert.equal(redirect.status, 502);
      assert.equal(redirect.headers.get("location"), null);
      assert.equal(requests, before + 1);
    },
  );
  await t.test(
    "only complete bounded inline files or directory metadata, never download URLs or partial data",
    async () => {
      const file = {
        name: "readme",
        type: "file",
        size: 5,
        encoding: "base64",
        content: "aGVsbG8=",
        download_url: "https://unrelated.invalid/download",
      };
      answer(200, [file]);
      assert.deepEqual(await (await get("/contents")).json(), [
        { name: "readme", size: 5, type: "file" },
      ]);
      answer(200, file);
      const complete = await (await get("/contents/readme?ref=feature%2Fexample")).json();
      assert.equal(Buffer.from(complete.content, "base64").toString(), "hello");
      assert.equal(complete.download_url, undefined);
      for (const [path, status, body, headers = json] of [
        ["/contents/readme", 413, JSON.stringify({ ...file, size: 1048577 })],
        ["/contents/readme", 502, JSON.stringify({ ...file, size: 6 })],
        // The provider closes before the 100 bytes it announced.
        ["/issues/3", 502, "[7]", { ...json, "content-length": "100", connection: "close" }],
        // One byte over the 12 MiB response bound.
        ["/releases/4", 502, Buffer.alloc(12 * 1024 * 1024 + 1)],
      ]) {
        reply = (req, res) => res.writeHead(200, headers).end(body);
        assert.equal((await get(path)).status, status, path);
      }
    },
  );
  await t.test(
    "three callers' reads can run; excess fails promptly; quota denial becomes a shared retry time",
    multipleCallers,
    async () => {
      const opened = Promise.withResolvers();
      const responses = [];
      // The provider holds every read; `opened` resolves once it holds three.
      reply = (req, res) => responses.push(res) === 3 && opened.resolve();
      const callers = ["127.0.0.1", ...aliases.slice(0, 2)];
      const active = Promise.all(callers.map((address, id) => from(address, "/pulls/" + (id + 1))));
      await opened.promise;
      const busy = await from(aliases[2], "/pulls/4");
      assert.equal(busy.status, 503);
      responses.forEach(ok);
      const statuses = (await active).map(({ status }) => status);
      assert.deepEqual(statuses, [200, 200, 200]);

      await assertParked({ "retry-after": "300" }, 290, [
        [aliases[0], "/pulls/7"],
        [aliases[1], "/releases/9"],
      ]);
    },
  );
  await t.test(
    "each caller gets a fair share: one read in flight, back-to-back reads, and an honest shared park",
    multipleCallers,
    async (st) => {
      const { base } = await startReader(st);
      const [first, second, third] = aliases;
      // The provider holds pulls 1-3 until released, as a slow GitHub read would.
      // `settled` resolves once each of the three is either answered or held.
      const held = [];
      const answered = [];
      const settled = Promise.withResolvers();
      const settle = () => held.length + answered.length === 3 && settled.resolve();
      reply = (req, res) => {
        if (/^\/repos\/example\/project\/pulls\/[1-3]$/.test(req.url)) {
          held.push(res);
          settle();
          return;
        }
        ok(res);
      };
      st.after(() => held.forEach(ok));

      // One caller that opens three slow reads holds one provider slot, not all three.
      const slow = ["/pulls/1", "/pulls/2", "/pulls/3"].map((path) =>
        from("127.0.0.1", path, base).then((response) => {
          answered.push(response);
          settle();
          return response;
        }, settled.reject),
      );
      await settled.promise;
      assert.equal(held.length, 1, "one caller must not occupy every provider slot");
      assert.equal(answered.length, 2);
      for (const response of answered) {
        assert.equal(response.status, 429);
        assert.equal(response.headers["retry-after"], "2");
        assert.match(response.body.message, /in progress/);
      }
      // Another caller is still served while the first caller's read is slow.
      assert.equal((await from(first, "/pulls/9", base)).status, 200);

      // Back-to-back reads are not a volume budget: a caller that reads one at a
      // time keeps being served (First Agent Smoke's control reads once a second).
      for (let read = 2; read <= 30; read++) {
        assert.equal((await from(first, "/releases/" + read, base)).status, 200);
      }
      assert.equal((await from(second, "/releases/1", base)).status, 200);
      ok(held.shift());
      assert.equal((await Promise.all(slow)).filter(({ status }) => status === 200).length, 1);

      // GitHub's anonymous quota belongs to the shared egress address. A primary
      // limit reset ten minutes out outlasts a shorter retry-after, so callers are
      // told the later time instead of returning to be refused again.
      const reset = String(Math.ceil(Date.now() / 1000) + 600);
      await assertParked({ "retry-after": "60", "x-ratelimit-reset": reset }, 590, [
        [second, "/pulls/20", base],
        [third, "/pulls/20", base],
      ]);
    },
  );
  await t.test(
    "identical reads in flight share one provider read and its answer",
    multipleCallers,
    async (st) => {
      const reader = await startReader(st);
      const [first, second] = aliases;
      // The provider holds the first read of pull 30 and answers any other at once.
      const holding = Promise.withResolvers();
      let held;
      reply = (req, res) => {
        if (held) {
          ok(res);
          return;
        }
        held = res;
        holding.resolve();
      };
      st.after(() => held?.writableEnded || (held && ok(held)));
      const before = requests;
      const reads = [from(first, "/pulls/30", reader.base)];
      await holding.promise;
      // The reader's own request listener is registered first and runs to `pending.get` before
      // its first await, so by this event it has either joined the read in flight or started
      // its own provider read.
      const taken = once(reader.server, "request");
      reads.push(from(second, "/pulls/30", reader.base));
      await taken;
      held.writeHead(200, json).end(JSON.stringify({ number: 30 }));
      const responses = await Promise.all(reads);
      assert.equal(requests, before + 1, "identical reads in flight must share one provider read");
      for (const { status, body } of responses) {
        assert.equal(status, 200);
        assert.deepEqual(body, { number: 30 });
      }
    },
  );
  await t.test(
    "a 403 whose only quota signal is x-ratelimit-remaining: 0 parks the shared quota",
    multipleCallers,
    async (st) => {
      const { base } = await startReader(st);
      // No retry-after, reset time or rate-limit wording: the reader parks for its default minute.
      await assertParked(
        {},
        50,
        [
          [aliases[0], "/pulls/40", base],
          [aliases[1], "/releases/40", base],
        ],
        { message: "Forbidden" },
      );
    },
  );
  await t.test(
    "idle sockets from one caller address cannot lock other callers out",
    // Room for the idle sockets' close (about 7 s, at most 15 s) and setup.
    aliased ? { timeout: 30_000 } : multipleCallers,
    async (st) => {
      const reader = await startReader(st);
      const [idler, other] = aliases;
      // One address opens 48 connections, the reader's whole budget without the per-address cap,
      // and never finishes its request headers. The reader keeps four and refuses the rest.
      const idle = await reader.hold(48, idler);
      const idling = Date.now();
      // Without the cap the reader is full and resets another caller until the idle sockets
      // time out (6 s, or about 30 s with Node's default check interval). With it, at once.
      const { status, code } = await request(reader.base + "/healthz", other).catch(
        (error) => error,
      );
      assert.equal(status ?? code, 200, "another caller is answered while one address idles");
      // The idle sockets the reader did accept close at the 6 s headers timeout, checked
      // every second (about 7 s). Node checks that timeout in native code against the real
      // clock, so the wait is real; it ends when the last socket closes. Allow 15 s for loaded
      // runners: with Node's default 30 s check interval they would still be open.
      await Promise.all(idle.map(({ client }) => closed(client)));
      const elapsed = Date.now() - idling;
      assert.ok(elapsed < 15_000, `idle sockets closed after ${elapsed} ms`);
    },
  );
  await t.test(
    "a connection over the per-address cap is answered 429 and closed",
    { timeout: 15_000 },
    async (st) => {
      const reader = await startReader(st);
      // This address holds its four connections with unfinished request headers.
      const held = await reader.hold(4);
      const healthz = () => request(reader.base + "/healthz");
      // The fifth gets the documented retryable answer, not a reset (finding 1475).
      const refused = await healthz();
      assert.equal(refused.status, 429);
      assert.equal(refused.headers["retry-after"], "1");
      assert.equal(refused.headers.connection, "close");
      assert.match(refused.body.message, /too many reader connections/);
      // Once this address closes its connections, it is served again.
      held.forEach(({ client }) => client.destroy());
      const closing = Date.now();
      await Promise.all(held.map(({ socket }) => closed(socket)));
      assert.ok(Date.now() - closing < 5000, "the reader closes its side when the client does");
      const served = await healthz();
      assert.equal(served.status, 200);
      assert.equal(served.body.message, "ready");
    },
  );
  await t.test(
    "a refused connection closes when its client does or after one second, and at most eight wait",
    { timeout: 15_000 },
    async (st) => {
      // Only setTimeout is mocked: the one-second refusal timer fires only when this test
      // ticks, so every close before a tick is the client's doing.
      st.mock.timers.enable({ apis: ["setTimeout"] });
      const reader = await startReader(st);
      await reader.hold(4);
      // A refused connection whose client stays half-open until the test closes it.
      const refused = async () => {
        const connection = await reader.connect({ allowHalfOpen: true });
        assert.match(await received(connection.client), refusal);
        return connection;
      };

      // A client that reads the answer and closes frees its refused connection at once.
      const reading = await reader.connect();
      assert.match(await received(reading.client), refusal);
      await closed(reading.socket);

      // A request still arriving after the answer is drained, not reset: the client reads
      // the answer once it has sent the rest of its request.
      const slow = await reader.connect();
      const [start, rest] = ["GET /healthz HTTP/1.1\r\n", "Host: reader\r\n\r\n"];
      slow.client.pause().write(start);
      await Promise.race([
        slow.socket.writableFinished || event(slow.socket, "finish"),
        closed(slow.socket),
      ]);
      slow.client.write(rest);
      // Keep the answer unread until the reader has read the whole request or the
      // connection is gone.
      while (slow.socket.bytesRead < (start + rest).length && !slow.client.closed) {
        await new Promise(setImmediate);
      }
      const late = received(slow.client);
      slow.client.resume();
      assert.match(await late, refusal);
      await closed(slow.socket);

      // A client that resets its connection must not crash the reader with an unhandled
      // socket error.
      const reset = await refused();
      reset.client.resetAndDestroy();
      await closed(reset.socket);

      // A client that never closes is closed after one second.
      const lingering = await refused();
      st.mock.timers.tick(999);
      assert.equal(lingering.socket.destroyed, false);
      st.mock.timers.tick(1);
      assert.equal(lingering.socket.destroyed, true);
      await closed(lingering.socket);

      // Eight refused connections can wait for their clients; the ninth closes unanswered
      // until one of them closes.
      const waiting = [];
      for (let count = 0; count < 8; count++) {
        waiting.push(await refused());
      }
      const ninth = await reader.connect({ allowHalfOpen: true });
      assert.equal(await received(ninth.client), "");
      waiting[0].client.end();
      await closed(waiting[0].socket);
      await refused();
    },
  );
});
