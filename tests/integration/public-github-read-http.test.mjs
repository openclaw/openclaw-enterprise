import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import https from "node:https";
import { connect as connectTcp, createServer as createTcpServer, Socket } from "node:net";
import test from "node:test";
import { createPublicGithubReadServer } from "../../apps/controller/src/drivers/repo/github/public-read/server.ts";
import { selfSigned } from "../helpers/certificates.ts";
import { listen } from "../helpers/listen.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import {
  publicGithubReadNextPage,
  runPublicGithubReadHttpWireCases,
} from "./public-github-read-http-wire-cases.ts";
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
/**
 * @param {string} url
 * @param {import("node:http").RequestOptions} options
 * @param {string} body
 * @returns {Promise<import("node:http").IncomingMessage>}
 */
function rawRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    http.request(url, options, resolve).once("error", reject).end(body);
  });
}

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
      const next = publicGithubReadNextPage(response, origin);
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
  await runPublicGithubReadHttpWireCases(t, {
    origin,
    repo,
    fetch,
    get,
    rawRequest,
    answer,
    setReply: (handler) => {
      reply = handler;
    },
    requestCount: () => requests,
  });
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
