/**
 * Runs in the released, trusted Harness wrapper. Codex authenticates the client capability; this
 * does not authenticate a server against hostile code in that same Pod. Keep only a live authorized
 * socket (not the bearer), so ordinary Pod readiness can remain fresh after Compute's activation.
 */
export const PROTECTED_HARNESS_OBSERVATION = String.raw`
let releasedKubernetesObservation;
function startProtectedKubernetesHarnessObservation(installation, verifier, appPort, statusPort = 18791, maxAge = 5000) {
  const {createHash, randomBytes, timingSafeEqual} = require("node:crypto");
  const http = require("node:http");
  const {performance} = require("node:perf_hooks");
  let live;
  let generation = 0;
  let freshUntil = 0;

  // A no-capability upgrade must explicitly get 401/403 before we send the real transport proof.
  async function upgrade(proof) {
    const key = randomBytes(16).toString("base64");
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    return new Promise(resolve => {
      const headers = {connection:"Upgrade", upgrade:"websocket", "sec-websocket-key":key, "sec-websocket-version":"13"};
      if (proof !== undefined) headers.authorization = "Bearer "+proof;
      const call = http.request({host:"127.0.0.1", port:appPort, method:"GET", agent:false,
        signal:AbortSignal.timeout(2000), headers});
      call.once("response", response => {
        const rejected = proof === undefined && [401,403].includes(response.statusCode);
        response.destroy();
        resolve({rejected});
      });
      call.once("upgrade", (response, socket, head) => {
        if (proof === undefined || response.statusCode !== 101 ||
            response.headers["sec-websocket-accept"] !== accept || response.headers.upgrade?.toLowerCase() !== "websocket") {
          socket.destroy();
          resolve({});
        } else {
          resolve({connection: observeControlSocket(socket, head)});
        }
      });
      call.once("error", () => resolve({}));
      call.end();
    });
  }

  // A dedicated RFC 6455 health connection sends only bounded Ping/Pong control frames, not Codex
  // application operations. Reject unexpected or extended frames; handle fragmented TCP delivery.
  function observeControlSocket(socket, head) {
    let buffer = Buffer.alloc(0);
    let pending, challenge, lastMatched, timer;
    const control = {
      socket,
      ping() {
        if (socket.destroyed || pending) return Promise.resolve(false);
        return new Promise(resolve => {
          pending = resolve;
          challenge = randomBytes(24);
          timer = setTimeout(() => socket.destroy(), 1000);
          write(0x89, challenge);
        });
      },
    };
    function write(opcode, payload) {
      const mask = randomBytes(4);
      const frame = Buffer.from([opcode, 0x80 | payload.length, ...mask, ...payload]);
      for (let i=0; i<payload.length; i++) frame[6+i] ^= mask[i%4];
      socket.write(frame);
    }
    function data(bytes) {
      if (buffer.length + bytes.length > 4096) {socket.destroy(); return;}
      buffer = Buffer.concat([buffer, bytes]);
      while (buffer.length >= 2) {
        const [opcode,size] = buffer;
        if (![0x89,0x8a].includes(opcode) || size > 125) {socket.destroy(); return;}
        if (buffer.length < 2+size) return;
        const payload = buffer.subarray(2, 2+size);
        buffer = buffer.subarray(2+size);
        if (opcode === 0x89) write(0x8a, payload);
        // RFC 6455 §5.5.3 permits unsolicited Pong; with no pending Ping it has no effect on freshness.
        else if (pending) {
          if (!challenge.equals(payload)) {
            // Native Codex sends the matching Pong twice. Its delayed duplicate is harmless even
            // during the next Ping, but must not satisfy that challenge, or clear or extend its timeout.
            if (lastMatched?.equals(payload)) continue;
            socket.destroy(); return;
          }
          lastMatched = challenge;
          clearTimeout(timer);
          const resolve = pending;
          pending = challenge = undefined;
          resolve(true);
        }
      }
    }
    socket.on("data", data);
    socket.on("error", () => socket.destroy());
    socket.once("end", () => socket.destroy());
    socket.once("close", () => {
      if (live === control) {live = undefined; freshUntil = 0;}
      clearTimeout(timer);
      pending?.(false);
      pending = challenge = undefined;
    });
    if (head.length) data(head);
    return control;
  }

  async function authenticate(proof) {
    const attempt = ++generation;
    live?.socket.destroy();
    live = undefined;
    freshUntil = 0;
    if (!(await upgrade()).rejected || generation !== attempt) return false;
    const {connection} = await upgrade(proof);
    if (!connection) return false;
    if (!await connection.ping() || generation !== attempt || connection.socket.destroyed) {
      connection.socket.destroy(); return false;
    }
    live = connection;
    freshUntil = performance.now() + maxAge;
    return true;
  }
  async function ready() {
    const connection = live;
    if (!connection || connection.socket.destroyed) return false;
    if (performance.now() < freshUntil) return true;
    // Renew only after both a matching nonce on the very same authorized live connection and a new
    // explicit denial without a capability. We need no saved or newly sent bearer to perform this check.
    connection.renew ??= Promise.all([connection.ping(), upgrade()]).then(([pong, {rejected}]) => {
      if (!pong || !rejected || connection !== live || connection.socket.destroyed) {
        connection.socket.destroy(); return false;
      }
      freshUntil = performance.now() + maxAge;
      return true;
    }).finally(() => {connection.renew = undefined;});
    return connection.renew;
  }

  const server = http.createServer(async (request,response) => {
    if (request.method === "GET" && request.url === "/readyz") {
      response.writeHead(await ready() ? 200 : 503, {"cache-control":"no-store"});
      response.end(); return;
    }
    const proof = request.headers["x-oce-enrollment-proof"];
    if (request.method !== "GET" || request.url !== "/authenticated-serving" || typeof proof !== "string" ||
        !timingSafeEqual(createHash("sha256").update(proof).digest(), verifier)) {
      response.writeHead(401); response.end(); return;
    }
    const serving = await authenticate(proof);
    response.writeHead(200, {"content-type":"application/json", "cache-control":"no-store"});
    response.end(JSON.stringify({state:serving ? "serving" : "starting", installation}));
  });
  server.requestTimeout = 5000;
  server.once("close", () => {generation++; live?.socket.destroy();});
  server.listen(statusPort, "0.0.0.0");
  server.unref();
  return server;
}
`;
