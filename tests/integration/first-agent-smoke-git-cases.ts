import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { promisify } from "node:util";

import { listen } from "../helpers/listen.ts";

export function registerInstalledGitTransportCase() {
  test("installed Git API keeps credentials off ambient proxies and redirects", async (t) => {
    const key = "synthetic-installed-api-key";
    const secret = "synthetic-installed-secret-body";
    const received: Array<{
      path: string | undefined;
      key: string | string[] | undefined;
      body: string;
    }> = [];
    let proxyConnections = 0;
    let redirectedRequests = 0;
    const sinkPort = await listen(
      t,
      createServer((request, response) => {
        redirectedRequests += 1;
        response.end();
      }),
    );
    const apiPort = await listen(
      t,
      createServer(async (request, response) => {
        let body = "";
        const chunks: AsyncIterable<unknown> = request;
        for await (const chunk of chunks) {
          assert.ok(Buffer.isBuffer(chunk) || typeof chunk === "string");
          body += chunk;
        }
        received.push({ path: request.url, key: request.headers["x-api-key"], body });
        if (request.url === "/redirect") {
          response.writeHead(307, { location: `http://127.0.0.1:${sinkPort}/collected` }).end();
        } else if (request.url === "/failure") {
          response.writeHead(500).end(`${key} ${secret}`);
        } else if (request.url === "/invalid") {
          response.end(`${key} ${secret}`);
        } else {
          response.end('{"data":"accepted"}');
        }
      }),
    );
    const proxy = createServer((request, response) => {
      proxyConnections += 1;
      response.writeHead(403).end();
    });
    proxy.on("connect", (request, socket) => {
      proxyConnections += 1;
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    });
    const proxyPort = await listen(t, proxy);
    const origin = `http://127.0.0.1:${apiPort}`;
    const helper = new URL("../helpers/openshell-git-installation.mjs", import.meta.url).href;
    // A fresh process must actually enable Node's ambient proxy before importing
    // the same client used by the installed scenario. No real credential is used.
    const script = `
    import assert from "node:assert/strict";
    import { createOpenShellGitApi } from ${JSON.stringify(helper)};
    const origin = ${JSON.stringify(origin)};
    await assert.rejects(fetch(origin + "/proxy-control"));
    const cleanup = [];
    const request = createOpenShellGitApi({
      origin, key: ${JSON.stringify(key)}, signal: AbortSignal.timeout(30_000),
      after: (operation) => cleanup.push(operation),
    });
    try {
      assert.equal(await request("POST", "/ordinary", { value: ${JSON.stringify(secret)} }), "accepted");
      await assert.rejects(request("POST", "/redirect", { value: ${JSON.stringify(secret)} }), /fetch failed/);
      await assert.rejects(request("POST", "/failure", { value: ${JSON.stringify(secret)} }),
        { message: "OCC POST /failure returned HTTP 500" });
      await assert.rejects(request("POST", "/invalid", { value: ${JSON.stringify(secret)} }),
        { message: "OCC POST /invalid returned invalid JSON" });
      await assert.rejects(request("GET", "http://127.0.0.1:${sinkPort}/escape"), /changed origin/);
    } finally {
      for (const close of cleanup.reverse()) await close();
    }
    console.log("direct API and redirect isolation passed");
  `;
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        timeout: 45_000,
        env: {
          ...Object.fromEntries(
            ["PATH", "HOME", "TMPDIR"]
              .filter((name) => process.env[name] !== undefined)
              .map((name) => [name, process.env[name]]),
          ),
          NODE_USE_ENV_PROXY: "1",
          HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
          HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
          http_proxy: `http://127.0.0.1:${proxyPort}`,
          https_proxy: `http://127.0.0.1:${proxyPort}`,
          NO_PROXY: "",
          no_proxy: "",
        },
      },
    );
    // The uncredentialed control must hit the proxy exactly once; none of the
    // authenticated requests may add a proxy connection or reach the redirect sink.
    assert.equal(proxyConnections, 1);
    assert.equal(redirectedRequests, 0);
    assert.deepEqual(
      received,
      ["/ordinary", "/redirect", "/failure", "/invalid"].map((path) => ({
        path,
        key,
        body: JSON.stringify({ value: secret }),
      })),
    );
    assert.equal(stdout.trim(), "direct API and redirect isolation passed");
    for (const value of [key, secret]) {
      assert.equal((stdout + stderr).includes(value), false);
    }
  });
}

export function registerGitExpiryCase() {
  test("Git expiry observation stops on exact-scope runtime retirement without exposing supplier text", async () => {
    const { assertOpenShellGitExpiryRetained } =
      await import("../helpers/openshell-git-installation.mjs");
    const identity = {
      namespaceId: "ns",
      agentId: "agent",
      revisionId: "revision",
      repositoryRef: "repo",
    };
    // Shape retained from a real failed expiry: retirement is terminal even though
    // the worker can later acknowledge successful cleanup of that runtime.
    const event = {
      ...identity,
      event: "worker.openshell-git-expiry",
      outcome: "retire-runtime",
      check: "conditional-detach",
      error: "private-supplier-detail",
    };
    assert.throws(() => assertOpenShellGitExpiryRetained(event, identity), {
      message: "Git expiry required runtime retirement; same-runtime retention failed.",
    });
    for (const field of Object.keys(identity)) {
      assert.doesNotThrow(() =>
        assertOpenShellGitExpiryRetained({ ...event, [field]: "other" }, identity),
      );
    }
    for (const outcome of ["pending", "withdrawn"]) {
      assert.doesNotThrow(() => assertOpenShellGitExpiryRetained({ ...event, outcome }, identity));
    }
    assert.doesNotThrow(() =>
      assertOpenShellGitExpiryRetained({ ...event, event: "worker.completed" }, identity),
    );
  });
}
