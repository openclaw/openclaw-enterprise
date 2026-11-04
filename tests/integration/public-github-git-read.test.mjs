import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import https from "node:https";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { createPublicGithubReadServer } from "../../apps/controller/src/drivers/repo/github/public-read/server.ts";
import {
  publicProviderGit as git,
  startPublicGithubProvider,
} from "../helpers/public-github-provider.mjs";
import { listen } from "../helpers/listen.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const capability = "revision-git." + Buffer.alloc(32, 9).toString("base64url");
const authorization = {
  installationId: "installation",
  namespaceId: "namespace",
  agentId: "agent-git",
  revisionId: "revision-git",
  tokenSha256: createHash("sha256").update(capability).digest("hex"),
  policy: { mode: "all" },
  validUntil: "2099-01-01T00:00:00.000Z",
};

test(
  "authenticated reader streams real clone and incremental fetch over verified provider TLS",
  { timeout: 120_000 },
  async (t) => {
    const directory = await temporaryDirectory(t, "public-github-git-");
    const fixture = await startPublicGithubProvider(t, { directory });
    const { root, provider, cert } = fixture;
    const source = await fixture.createRepository("example/project");
    const connect = https.Agent.prototype.createConnection;
    t.mock.method(https.Agent.prototype, "createConnection", function (options, callback) {
      assert.equal(options.host, "github.com");
      assert.equal(options.port, 443);
      assert.notEqual(options.rejectUnauthorized, false);
      return connect.call(
        this,
        {
          ...options,
          host: "127.0.0.1",
          port: provider.address().port,
          servername: "github.com",
          ca: cert,
        },
        callback,
      );
    });
    let registry = { "revision-git": authorization };
    let ceiling = { mode: "all" };
    const reader = createPublicGithubReadServer({
      policy: () => ceiling,
      loadAuthorizations: () => registry,
    });
    const port = await listen(t, reader);
    const base = `http://127.0.0.1:${port}`;
    const target = base + "/git/example/project.git";
    const clone = path.join(directory, "clone");
    const authenticatedGit = (cwd, ...args) =>
      git(cwd, "-c", `http.extraHeader=Authorization: Bearer ${capability}`, ...args);
    await authenticatedGit(directory, "clone", "--depth=1", target, clone);
    assert.equal(await readFile(path.join(clone, "readme.txt"), "utf8"), "first object\n");
    await writeFile(path.join(source, "readme.txt"), "second object\n");
    await git(source, "commit", "-am", "Second object");
    await git(source, "push", path.join(root, "example/project.git"), "main");
    await authenticatedGit(clone, "fetch", "origin");
    assert.equal((await git(clone, "show", "origin/main:readme.txt")).stdout, "second object\n");
    assert.ok(
      fixture.requests.some(({ url }) => url.endsWith("/git-upload-pack")),
      "clone/fetch must negotiate actual upload-pack objects",
    );

    const fetch = (suffix, options = {}) =>
      globalThis.fetch(target + suffix, {
        ...options,
        headers: {
          authorization: `Bearer ${capability}`,
          cookie: "synthetic=discard",
          ...options.headers,
        },
      });
    const discovery = "/info/refs?service=git-upload-pack";
    await t.test(
      "missing/forged capabilities and either policy denial never reach GitHub",
      async () => {
        const before = fixture.requests.length;
        assert.equal((await globalThis.fetch(target + discovery)).status, 401);
        assert.equal(
          (await fetch(discovery, { headers: { authorization: `Bearer ${capability}forged` } }))
            .status,
          401,
        );
        ceiling = { mode: "repositories", repositories: [] };
        assert.equal((await fetch(discovery)).status, 403);
        ceiling = { mode: "all" };
        registry = {
          "revision-git": {
            ...authorization,
            policy: { mode: "repositories", repositories: ["example/other"] },
          },
        };
        assert.equal((await fetch(discovery)).status, 403);
        registry = { "revision-git": authorization };
        assert.equal(fixture.requests.length, before);
      },
    );
    await t.test(
      "reject writes, malformed paths, unexpected bodies and encodings locally",
      async () => {
        const before = fixture.requests.length;
        for (const suffix of [
          "/info/refs?service=git-receive-pack",
          "/git-receive-pack",
          "/info/refs?service=git-upload-pack&extra=1",
          "/info/refs",
          "/objects/aa",
        ]) {
          const response = await fetch(suffix);
          assert.equal(response.status, 400, suffix);
          assert.deepEqual(await response.json(), {
            message: "Expected supported Git upload-pack discovery or read.",
          });
        }
        for (const [suffix, options] of [
          [
            "/git-upload-pack",
            { method: "POST", body: "0000", headers: { "content-type": "application/json" } },
          ],
          [
            "/git-upload-pack",
            {
              method: "POST",
              body: "0000",
              headers: {
                "content-type": "application/x-git-upload-pack-request",
                "content-encoding": "br",
              },
            },
          ],
          [
            "/git-upload-pack",
            {
              method: "POST",
              body: "x".repeat(4 * 1024 * 1024 + 1),
              headers: { "content-type": "application/x-git-upload-pack-request" },
            },
          ],
        ]) {
          assert.ok((await fetch(suffix, options)).status >= 400, suffix);
        }
        assert.equal(fixture.requests.length, before);
      },
    );
    await t.test(
      "streaming backpressure and client cancellation stop provider work before releasing its slot",
      async () => {
        const providerClosed = Promise.withResolvers();
        let sent = 0;
        fixture.behavior = (_req, res) => {
          res.once("close", providerClosed.resolve);
          res.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" });
          const chunk = Buffer.alloc(64 * 1024);
          const write = () => {
            while (sent < 32 * 1024 * 1024 && !res.destroyed) {
              sent += chunk.length;
              if (!res.write(chunk)) {
                res.once("drain", write);
                return;
              }
            }
            if (sent >= 32 * 1024 * 1024) {
              res.end();
            }
          };
          write();
        };
        const response = await new Promise((resolve, reject) =>
          http
            .get(
              target + discovery,
              { headers: { authorization: `Bearer ${capability}` } },
              resolve,
            )
            .on("error", reject),
        );
        response.pause();
        // Let pending I/O drain while this client deliberately refuses its body.
        // A buffered implementation would read the complete provider response.
        for (let turn = 0; turn < 40; turn++) {
          await new Promise(setImmediate);
        }
        assert.ok(sent < 32 * 1024 * 1024, `provider produced ${sent} bytes for a paused client`);
        response.destroy();
        await providerClosed.promise;
        fixture.behavior = "git";
        const retry = await fetch(discovery);
        assert.equal(retry.status, 200);
        await retry.arrayBuffer();
      },
    );
    await t.test(
      "declared and streamed response byte limits terminate oversized transfers",
      async () => {
        fixture.behavior = (_req, res) =>
          res
            .writeHead(200, {
              "content-type": "application/x-git-upload-pack-advertisement",
              "content-length": String(1024 * 1024 * 1024 + 1),
            })
            .end();
        assert.equal((await fetch(discovery)).status, 502);
        let providerBytes = 0;
        fixture.behavior = (_req, res) => {
          res.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" });
          const chunk = Buffer.alloc(256 * 1024);
          const write = () => {
            while (providerBytes <= 1024 * 1024 * 1024 && !res.destroyed) {
              providerBytes += chunk.length;
              if (!res.write(chunk)) {
                res.once("drain", write);
                return;
              }
            }
            res.end();
          };
          write();
        };
        let received = 0;
        await assert.rejects(
          new Promise((resolve, reject) => {
            http
              .get(
                target + discovery,
                { headers: { authorization: `Bearer ${capability}` } },
                async (res) => {
                  try {
                    for await (const chunk of res) {
                      received += chunk.length;
                    }
                    resolve();
                  } catch (error) {
                    reject(error);
                  }
                },
              )
              .on("error", reject);
          }),
          { code: "ECONNRESET" },
        );
        assert.ok(received <= 1024 * 1024 * 1024);
        assert.ok(
          providerBytes > 1024 * 1024 * 1024,
          "the encoded response limit must be crossed on the wire",
        );
        fixture.behavior = "git";
      },
    );
    await t.test("chunked upload limit aborts the provider transfer", async () => {
      const stopped = Promise.withResolvers();
      let bytes = 0;
      fixture.behavior = (req, res) => {
        req.on("data", (chunk) => {
          bytes += chunk.length;
        });
        res.once("close", stopped.resolve);
      };
      const request = http.request(target + "/git-upload-pack", {
        method: "POST",
        headers: {
          authorization: `Bearer ${capability}`,
          "content-type": "application/x-git-upload-pack-request",
          "transfer-encoding": "chunked",
        },
      });
      request.on("error", () => {});
      const finished = Promise.race([once(request, "response"), once(request, "error")]).catch(
        () => {},
      );
      const chunk = Buffer.alloc(64 * 1024);
      for (let index = 0; index < 65; index++) {
        request.write(chunk);
      }
      request.end();
      await finished;
      await stopped.promise;
      assert.ok(bytes <= 4 * 1024 * 1024, `provider received ${bytes} encoded bytes`);
      fixture.behavior = "git";
    });
    await t.test(
      "the ten minute deadline cancels a provider stalled before response headers",
      async (st) => {
        const opened = Promise.withResolvers();
        const stopped = Promise.withResolvers();
        fixture.behavior = (_req, res) => {
          res.once("close", stopped.resolve);
          opened.resolve();
        };
        st.mock.timers.enable({ apis: ["setTimeout"] });
        const response = fetch(discovery);
        await opened.promise;
        st.mock.timers.tick(10 * 60 * 1000);
        assert.equal((await response).status, 504);
        await stopped.promise;
        fixture.behavior = "git";
      },
    );
    await t.test(
      "visibility changes and redirects fail without another destination or credential retry",
      async () => {
        fixture.behavior = "private";
        assert.equal((await fetch(discovery)).status, 404);
        await assert.rejects(authenticatedGit(clone, "fetch", "origin"), { code: 128 });
        fixture.behavior = "redirect";
        const redirect = await fetch(discovery);
        assert.equal(redirect.status, 502);
        assert.equal(redirect.headers.get("location"), null);
        fixture.behavior = "incomplete";
        const incomplete = await fetch(discovery);
        await assert.rejects(incomplete.arrayBuffer(), TypeError);
        fixture.behavior = "git";
        registry = {};
        const before = fixture.requests.length;
        await assert.rejects(authenticatedGit(clone, "fetch", "origin"), { code: 128 });
        assert.equal(
          fixture.requests.length,
          before,
          "withdrawal must apply even to an existing cloned repository",
        );
      },
    );
  },
);
