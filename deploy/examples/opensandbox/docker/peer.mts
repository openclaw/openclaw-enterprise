import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const { endpoint, execdToken, codexToken, wrongToken } = JSON.parse(readFileSync(0, "utf8")) as {
  endpoint: string;
  execdToken: string;
  codexToken: string;
  wrongToken: string;
};
const url = new URL(endpoint);
const execdHeader = { "X-EXECD-ACCESS-TOKEN": execdToken };
const clientName = "oce-opensandbox-probe";

function upgrade(codex?: string, execd = true): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        ...(execd ? execdHeader : {}),
        ...(codex === undefined ? {} : { Authorization: "Bearer " + codex }),
      },
    });
    req.setTimeout(1500, () => req.destroy(new Error("upgrade timed out")));
    req.once("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    req.once("upgrade", (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.once("error", reject);
    req.end();
  });
}

async function initialize() {
  await new Promise<void>((resolve, reject) => {
    // Node's built-in WebSocket accepts request headers. The DOM overload omits them.
    const Client = WebSocket as typeof WebSocket & {
      new (url: string, options: { headers: Record<string, string> }): WebSocket;
    };
    const ws = new Client(endpoint, {
      headers: { ...execdHeader, Authorization: "Bearer " + codexToken },
    });
    const timer = setTimeout(() => settle(new Error("initialize timed out")), 4000);
    function settle(error?: Error) {
      clearTimeout(timer);
      ws.close();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    }
    ws.addEventListener("error", () => settle(new Error("WebSocket handshake failed")));
    ws.addEventListener("close", () => settle(new Error("socket closed before initialize")));
    ws.addEventListener("open", () =>
      ws.send(
        JSON.stringify({
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: clientName, version: "1.0.0" } },
        }),
      ),
    );
    ws.addEventListener("message", (event) => {
      try {
        const answer = JSON.parse(event.data);
        if (answer.id === 1) {
          assert(
            answer.error === undefined &&
              typeof answer.result?.userAgent === "string" &&
              answer.result.userAgent.startsWith(clientName + "/"),
            "Codex initialize failed",
          );
          settle();
        }
      } catch {
        settle(new Error("invalid Codex initialize reply"));
      }
    });
  });
}

assert.equal(process.getuid?.(), 1000);
assert.doesNotMatch(readFileSync("/proc/net/route", "utf8"), /^\S+\s+00000000\s+/mu);
const status = readFileSync("/proc/self/status", "utf8");
assert.match(status, /^NoNewPrivs:\s*1$/mu);
assert.match(status, /^CapEff:\s*0+$/mu);

// Wait only on the startup response from the proxy. Authentication failures terminate the probe.
async function tryUpgrade() {
  try {
    return await upgrade(codexToken);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") {
      return 502;
    }
    throw error;
  }
}
let ready = await tryUpgrade();
const deadline = Date.now() + 18000;
while (ready === 502 && Date.now() < deadline) {
  await delay(150);
  ready = await tryUpgrade();
}
assert.equal(ready, 101, "The authenticated proxy route must upgrade.");
await initialize();
const missingExecd = await upgrade(codexToken, false);
const missingCodex = await upgrade();
const wrongCodex = await upgrade(wrongToken);
assert.equal(missingExecd, 401);
assert.equal(missingCodex, 401);
assert.equal(wrongCodex, 401);
console.log(JSON.stringify({ initialized: true, missingExecd, missingCodex, wrongCodex }));
