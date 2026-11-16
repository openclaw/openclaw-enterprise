import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import https from "node:https";
import { connect as connectTcp, createServer as createTcpServer, Socket } from "node:net";
import test from "node:test";
import { createPublicGithubReadServer } from "../../apps/controller/src/drivers/repo/github/public-read/server.ts";
import { selfSigned } from "../helpers/certificates.mjs";
import { listen } from "../helpers/listen.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { runPublicGithubReadSocketCapacityCases } from "./public-github-read-socket-capacity-cases.ts";

// Request headers a client never finishes, so the reader holds the connection open.
const unfinished = "GET /healthz HTTP/1.1\r\nHost: reader\r\n";
// A GET from one caller address, read to the end: { status, headers, body (JSON) }.
/**
 * @param {string} url
 * @param {string} [localAddress]
 * @returns {Promise<import("./public-github-read-socket-capacity-cases.ts").ReaderResponse>}
 */
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
          /** @type {unknown} */
          const body = JSON.parse(text);
          resolve({ status: res.statusCode, headers: res.headers, body });
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
/** @param {import("node:test").TestContext} t */
async function startReader(t) {
  const server = createPublicGithubReadServer();
  /** @type {Socket[]} */
  const clients = [];
  t.after(() => clients.forEach((client) => client.destroy()));
  const port = await listen(t, server);
  /** @param {Partial<import("node:net").TcpNetConnectOpts>} [options] */
  const connect = async (options = {}) => {
    /** @type {Promise<unknown[]>} */
    const accepted = once(server, "connection");
    const client = connectTcp({ port, host: "127.0.0.1", ...options });
    client.on("error", () => {});
    clients.push(client);
    await once(client, "connect");
    const [socket] = await accepted;
    assert.ok(socket instanceof Socket, "the reader accepted a TCP socket");
    return { client, socket };
  };
  /**
   * @param {number} count
   * @param {string} [localAddress]
   */
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
  const directory = await temporaryDirectory(t, "public-github-provider-");
  const name = "api.github.com";
  const { key, cert } = await selfSigned(directory, {
    commonName: name,
    subjectAltName: `DNS:${name}`,
  });
  let reply;
  let requests = 0;
  const provider = https.createServer({ cert, key }, (req, res) => {
    requests++;
    assert.equal(req.method, "GET");
    assert.equal(req.headers.host, name);
    assert.equal(req.socket.servername, name);
    assert.equal(Object.keys(req.headers).sort().join(" "), githubHeaders);
    reply(req, res);
  });
  await listen(t, provider);

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
  /** @type {[string, string, string]} */
  const aliases = ["127.0.0.2", "127.0.0.3", "127.0.0.4"];
  const probe = createTcpServer();
  /** @type {boolean} */
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
  await runPublicGithubReadSocketCapacityCases(t, {
    startReader,
    request,
    aliases,
    aliased,
    multipleCallers,
  });
});
