import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { connect as connectTcp, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPublicGithubReadServer } from "../../apps/controller/src/drivers/repo/github/public-read/server.ts";

test("public GitHub reader enforces anonymous GET, fresh visibility, bounded responses and shared quota", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "public-github-provider-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const name = "api.github.com";
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      join(directory, "key"),
      "-out",
      join(directory, "cert"),
      "-days",
      "1",
      "-subj",
      "/CN=" + name,
      "-addext",
      "subjectAltName=DNS:" + name,
    ],
    { stdio: "ignore" },
  );
  const cert = await readFile(join(directory, "cert"));
  let reply;
  let requests = 0;
  const provider = https
    .createServer({ cert, key: await readFile(join(directory, "key")) }, (req, res) => {
      requests++;
      assert.equal(req.method, "GET");
      assert.equal(req.headers.host, name);
      assert.equal(req.socket.servername, name);
      assert.deepEqual(Object.keys(req.headers).sort(), [
        "accept",
        "accept-encoding",
        "connection",
        "host",
        "user-agent",
        "x-github-api-version",
      ]);
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
  const reader = createPublicGithubReadServer().listen(0, "127.0.0.1");
  await once(reader, "listening");
  t.after(() => {
    reader.closeAllConnections();
    reader.close();
  });
  const origin = "http://127.0.0.1:" + reader.address().port;
  const repo = "/repos/example/project";
  const get = (path = "", options) => fetch(origin + repo + path, options);
  // Each Agent Pod is a separate caller address; loopback aliases stand in for them.
  const from = (address, path, base = origin) =>
    new Promise((resolve, reject) => {
      http
        .get(base + repo + path, { agent: false, localAddress: address }, async (res) => {
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
    reply = (req, res) => {
      res
        .writeHead(status, { "content-type": "application/json", ...headers })
        .end(JSON.stringify(body));
    };
  };

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
      const link = response.headers.get("link");
      assert.match(link, /^<.*>; rel="next"$/);
      const next = new URL(link.split(">")[0].slice(1), origin);
      assert.equal(next.origin, origin);
      assert.equal(next.pathname, repo + "/pulls");
      assert.deepEqual(Object.fromEntries(next.searchParams), {
        page: "2",
        per_page: "100",
        sort: "updated",
        state: "closed",
      });

      answer(404, { message: "provider details must not escape" });
      const missing = await get(path);
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), { message: "Not found" });
      assert.equal(
        requests,
        2,
        "a repository that became private must never be served from a cache",
      );
    },
  );
  await t.test("issue cursors survive local pagination when earlier issues disappear", async () => {
    const issued = "opaque+/cursor==";
    reply = (req, res) => {
      const url = new URL(req.url, "https://api.github.com");
      const after = url.searchParams.get("after");
      if (!url.searchParams.has("page")) {
        const next = new URL("https://api.github.com/repositories/12/issues");
        next.searchParams.set("per_page", "2");
        next.searchParams.set("after", issued);
        next.searchParams.set("page", "2");
        next.searchParams.set("state", "open");
        res.writeHead(200, { "content-type": "application/json", link: `<${next}>; rel="next"` });
        res.end(JSON.stringify([{ number: 1 }, { number: 2 }]));
      } else {
        assert.equal(url.searchParams.get("state"), "all");
        res.writeHead(200, { "content-type": "application/json" });
        // After issue 1 disappears, offset page 2 is empty; the issued cursor still finds issue 3.
        res.end(JSON.stringify(after === issued ? [{ number: 3 }] : []));
      }
    };
    const first = await get("/issues?state=all&per_page=2");
    assert.deepEqual(
      (await first.json()).map(({ number }) => number),
      [1, 2],
    );
    const next = new URL(first.headers.get("link").split(">")[0].slice(1), origin);
    assert.equal(next.pathname, repo + "/issues");
    assert.deepEqual(Object.fromEntries(next.searchParams), {
      per_page: "2",
      state: "all",
      page: "2",
      after: issued,
    });
    const second = await fetch(next);
    assert.equal(second.status, 200);
    assert.deepEqual(
      (await second.json()).map(({ number }) => number),
      [3],
    );

    const newer = new URL("https://api.github.com/repositories/12/issues?page=3");
    newer.searchParams.set("before", "next_cursor");
    answer(200, [], { link: `<${newer}>; rel="next"` });
    const replacement = await fetch(next);
    const replaced = new URL(replacement.headers.get("link").split(">")[0].slice(1), origin);
    assert.equal(replaced.searchParams.get("after"), null);
    assert.equal(replaced.searchParams.get("before"), "next_cursor");

    answer(200, [], {
      link: '<https://api.github.com/repos/example/project/issues?page=2&after=cursor>; rel="next"',
    });
    const named = await fetch(origin + "/repos/Example/Project/issues?state=all");
    assert.equal(named.status, 200);
    const namedNext = new URL(named.headers.get("link").split(">")[0].slice(1), origin);
    assert.equal(namedNext.pathname, "/repos/Example/Project/issues");
    assert.equal(namedNext.searchParams.get("after"), "cursor");
  });
  await t.test("unsafe issue continuations fail instead of reporting a complete list", async () => {
    for (const query of [
      "page=2&after=invalid%20cursor",
      "page=2&after=one&after=two",
      "page=2&after=one&before=two",
      "page=2&page=3&after=one",
      "page=2&after=" + "a".repeat(1025),
      "page=1001&after=one",
      "after=one",
      "page=2&after=" + "%2F".repeat(700),
    ]) {
      answer(200, [], {
        link: `<https://api.github.com/repositories/12/issues?${query}>; rel="next"`,
      });
      const response = await get("/issues?state=all");
      assert.equal(response.status, 502, query);
      assert.match((await response.json()).message, /incomplete/i);
    }
    answer(200, [], {
      link: "<https://api.github.com/repositories/12/issues?page=2>; rel=next",
    });
    assert.equal((await get("/issues")).status, 502);
    answer(200, [], {
      link: '<https://unrelated.invalid/repositories/12/issues?page=2>; rel="next"',
    });
    assert.equal((await get("/issues")).status, 502);
    answer(200, [], {
      link: '<https://api.github.com/repositories/12/pulls?page=2&after=cursor>; rel="next"',
    });
    assert.equal((await get("/pulls")).status, 502);
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
    const path = "/pulls?page=1000";
    answer(200, []);
    const last = await get(path);
    assert.equal(last.status, 200);
    assert.equal(last.headers.get("link"), null);

    answer(200, [], {
      link: '<https://api.github.com/repositories/12/pulls?page=1001>; rel="next"',
    });
    const incomplete = await get(path);
    assert.equal(incomplete.status, 502);
    assert.match((await incomplete.json()).message, /incomplete.*1000/i);

    answer(200, [], {
      link: '<https://api.github.com/repositories/12/issues?page=1000&after=cursor>; rel="next"',
    });
    assert.equal((await get("/issues?page=1000")).status, 502);
  });
  await t.test("a directory at GitHub's entry limit cannot establish completeness", async () => {
    const entry = { name: "entry", type: "file", size: 0 };
    answer(
      200,
      Array.from({ length: 999 }, () => entry),
    );
    const belowLimit = await get("/contents");
    assert.equal(belowLimit.status, 200);
    assert.equal((await belowLimit.json()).length, 999);

    answer(
      200,
      Array.from({ length: 1000 }, () => entry),
    );
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
      answer(200, { ...file, size: 1048577 });
      assert.equal((await get("/contents/readme")).status, 413);
      answer(200, { ...file, size: 6 });
      assert.equal((await get("/contents/readme")).status, 502);
      reply = (req, res) =>
        res
          .writeHead(200, {
            "content-type": "application/json",
            "content-length": "100",
            connection: "close",
          })
          .end("[7]");
      assert.equal((await get("/issues/3")).status, 502);
      reply = (req, res) =>
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(Buffer.alloc(12 * 1024 * 1024 + 1));
      assert.equal((await get("/releases/4")).status, 502);
    },
  );
  await t.test(
    "three callers' reads can run; excess fails promptly; quota denial becomes a shared retry time",
    multipleCallers,
    async () => {
      const opened = Promise.withResolvers();
      const responses = [];
      reply = (req, res) => {
        responses.push(res);
        if (responses.length === 3) {
          opened.resolve();
        }
      };
      const active = Promise.all(
        ["127.0.0.1", ...aliases.slice(0, 2)].map((address, id) =>
          from(address, "/pulls/" + (id + 1)),
        ),
      );
      await opened.promise;
      const busy = await from(aliases[2], "/pulls/4");
      assert.equal(busy.status, 503);
      for (const res of responses) {
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      }
      assert.deepEqual(
        (await active).map(({ status }) => status),
        [200, 200, 200],
      );

      answer(
        403,
        { message: "API rate limit exceeded" },
        { "retry-after": "300", "x-ratelimit-remaining": "0" },
      );
      const before = requests;
      for (const path of ["/pulls/7", "/releases/9"]) {
        const limit = await get(path);
        assert.equal(limit.status, 429);
        assert.ok(Number(limit.headers.get("retry-after")) > 290);
      }
      assert.equal(
        requests,
        before + 1,
        "another reader should not spend quota during a known denial",
      );
    },
  );
  await t.test(
    "each caller gets a fair share: one read in flight, back-to-back reads, and an honest shared park",
    multipleCallers,
    async (st) => {
      const fair = createPublicGithubReadServer().listen(0, "127.0.0.1");
      await once(fair, "listening");
      st.after(() => {
        fair.closeAllConnections();
        fair.close();
      });
      const base = "http://127.0.0.1:" + fair.address().port;
      const [first, second, third] = aliases;
      // The provider holds pulls 1-3 until released, as a slow GitHub read would.
      const held = [];
      const opened = Promise.withResolvers();
      reply = (req, res) => {
        if (/^\/repos\/example\/project\/pulls\/[1-3]$/.test(req.url)) {
          held.push(res);
          opened.resolve();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      };

      // One caller that opens three slow reads holds one provider slot, not all
      // three. Wait until each read is either answered or held by the provider.
      const answered = [];
      const slow = ["/pulls/1", "/pulls/2", "/pulls/3"].map((path) =>
        from("127.0.0.1", path, base).then((response) => {
          answered.push(response);
          return response;
        }),
      );
      await opened.promise;
      for (let poll = 0; held.length + answered.length < 3 && poll < 500; poll++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      st.after(() => {
        for (const res of held) {
          res.writeHead(200, { "content-type": "application/json" }).end("{}");
        }
      });
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
      held.shift().writeHead(200, { "content-type": "application/json" }).end("{}");
      assert.equal((await Promise.all(slow)).filter(({ status }) => status === 200).length, 1);

      // GitHub's anonymous quota belongs to the shared egress address. A primary
      // limit reset ten minutes out outlasts a shorter retry-after, so callers are
      // told the later time instead of returning to be refused again.
      const reset = String(Math.ceil(Date.now() / 1000) + 600);
      answer(
        403,
        { message: "API rate limit exceeded" },
        { "retry-after": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset },
      );
      const before = requests;
      for (const address of [second, third]) {
        const parked = await from(address, "/pulls/20", base);
        assert.equal(parked.status, 429);
        assert.ok(Number(parked.headers["retry-after"]) > 590, parked.headers["retry-after"]);
      }
      assert.equal(requests, before + 1);
    },
  );
  await t.test(
    "idle sockets from one caller address cannot lock other callers out",
    // Room for the 2 s answer bound, the 15 s close window and setup.
    aliased ? { timeout: 30_000 } : multipleCallers,
    async (st) => {
      const guarded = createPublicGithubReadServer().listen(0, "127.0.0.1");
      await once(guarded, "listening");
      st.after(() => {
        guarded.closeAllConnections();
        guarded.close();
      });
      const port = guarded.address().port;
      const [idler, other] = aliases;
      // One address opens the reader's whole 48-connection budget and never
      // finishes its request headers.
      const idle = [];
      st.after(() => {
        for (const socket of idle) {
          socket.destroy();
        }
      });
      for (let open = 0; open < 48; open++) {
        const socket = connectTcp({ port, host: "127.0.0.1", localAddress: idler });
        socket.on("error", () => {}).resume();
        idle.push(socket);
        await once(socket, "connect");
        socket.write("GET /healthz HTTP/1.1\r\nHost: reader\r\n");
      }
      const idling = Date.now();
      const healthz = () =>
        new Promise((resolve) => {
          http
            .get(
              "http://127.0.0.1:" + port + "/healthz",
              { agent: false, localAddress: other },
              (res) => {
                res.resume();
                resolve(res.statusCode);
              },
            )
            .once("error", (error) => resolve(error.code));
        });
      // Without a per-address cap every other caller is reset until the idle
      // sockets reach the 6 s headers timeout (about 30 s with Node's default
      // check interval), so allow well under 6 s.
      let status = await healthz();
      while (status !== 200 && Date.now() - idling < 2000) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        status = await healthz();
      }
      assert.equal(status, 200, "another caller is answered while one address idles");
      // The idle sockets the reader did accept close at the 6 s headers timeout,
      // checked every second (about 7 s). Allow 15 s for loaded runners: with
      // Node's default 30 s check interval they would still be open.
      while (idle.some((socket) => !socket.closed) && Date.now() - idling < 15_000) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(idle.filter((socket) => !socket.closed).length, 0);
    },
  );
  await t.test(
    "a connection over the per-address cap is answered 429 and closed",
    { timeout: 15_000 },
    async (st) => {
      const guarded = createPublicGithubReadServer().listen(0, "127.0.0.1");
      await once(guarded, "listening");
      st.after(() => {
        guarded.closeAllConnections();
        guarded.close();
      });
      const port = guarded.address().port;
      // This address holds its four connections with unfinished request headers.
      const held = [];
      st.after(() => {
        for (const socket of held) {
          socket.destroy();
        }
      });
      for (let open = 0; open < 4; open++) {
        const socket = connectTcp({ port, host: "127.0.0.1" });
        socket.on("error", () => {}).resume();
        held.push(socket);
        await once(socket, "connect");
        socket.write("GET /healthz HTTP/1.1\r\nHost: reader\r\n");
      }
      const healthz = () =>
        new Promise((resolve, reject) => {
          http
            .get("http://127.0.0.1:" + port + "/healthz", { agent: false }, async (res) => {
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
      // The fifth gets the documented retryable answer, not a reset (finding 1475).
      const refused = await healthz();
      assert.equal(refused.status, 429);
      assert.equal(refused.headers["retry-after"], "1");
      assert.equal(refused.headers.connection, "close");
      assert.match(refused.body.message, /too many reader connections/);
      // Once this address closes its connections, it is served again.
      for (const socket of held) {
        socket.destroy();
      }
      const closing = Date.now();
      let served = await healthz();
      while (served.status !== 200 && Date.now() - closing < 5000) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        served = await healthz();
      }
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
      const guarded = createPublicGithubReadServer().listen(0, "127.0.0.1");
      await once(guarded, "listening");
      const clients = [];
      st.after(() => {
        for (const socket of clients) {
          socket.destroy();
        }
        guarded.closeAllConnections();
        guarded.close();
      });
      const port = guarded.address().port;
      // Pairs each client with the reader's side of its connection.
      const open = async (options = {}) => {
        const accepted = once(guarded, "connection");
        const client = connectTcp({ port, host: "127.0.0.1", ...options });
        client.on("error", () => {});
        clients.push(client);
        await once(client, "connect");
        const [socket] = await accepted;
        return { client, socket };
      };
      // Unlike events.once, these never reject on the socket errors a reset produces.
      const event = (emitter, name) => new Promise((resolve) => emitter.once(name, resolve));
      const closed = (socket) => socket.closed || event(socket, "close");
      // Everything the client reads until the reader ends or resets the connection.
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
      for (let held = 0; held < 4; held++) {
        (await open()).client.write("GET /healthz HTTP/1.1\r\nHost: reader\r\n");
      }
      const refusal = /^HTTP\/1\.1 429 Too Many Requests\r\n[^]*too many reader connections/;

      // A client that reads the answer and closes frees its refused connection at once.
      const reader = await open();
      assert.match(await received(reader.client), refusal);
      await closed(reader.socket);

      // A request still arriving after the answer is drained, not reset: the client reads
      // the answer once it has sent the rest of its request.
      const slow = await open();
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
      const reset = await open({ allowHalfOpen: true });
      assert.match(await received(reset.client), refusal);
      reset.client.resetAndDestroy();
      await closed(reset.socket);

      // A client that never closes is closed after one second.
      const lingering = await open({ allowHalfOpen: true });
      assert.match(await received(lingering.client), refusal);
      st.mock.timers.tick(999);
      assert.equal(lingering.socket.destroyed, false);
      st.mock.timers.tick(1);
      assert.equal(lingering.socket.destroyed, true);
      await closed(lingering.socket);

      // Eight refused connections can wait for their clients; the ninth closes unanswered
      // until one of them closes.
      const waiting = [];
      for (let refused = 0; refused < 8; refused++) {
        const connection = await open({ allowHalfOpen: true });
        assert.match(await received(connection.client), refusal);
        waiting.push(connection);
      }
      const ninth = await open({ allowHalfOpen: true });
      assert.equal(await received(ninth.client), "");
      waiting[0].client.end();
      await closed(waiting[0].socket);
      assert.match(await received((await open({ allowHalfOpen: true })).client), refusal);
    },
  );
});
