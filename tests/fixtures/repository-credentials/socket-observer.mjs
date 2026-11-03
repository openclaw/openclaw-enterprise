import { connect } from "node:net";
import { createServer } from "node:tls";
import { listen } from "./process.mjs";

// A transparent loopback TLS terminator. Observations come from real socket data,
// before the origin's HTTP parser and after its response writer, not handler logs.
export async function observeTlsOrigin(resources, tls, originPort) {
  const connections = [];
  const server = createServer(tls, (socket) => {
    const origin = connect(originPort, "127.0.0.1");
    const requests = [];
    const responses = [];
    let responseEnded = false;
    const complete = new Promise((resolve, reject) => {
      socket.on("data", (chunk) => requests.push(Buffer.from(chunk)));
      origin.on("data", (chunk) => responses.push(Buffer.from(chunk)));
      origin.once("end", () => {
        responseEnded = true;
      });
      socket.once("error", reject);
      origin.once("error", reject);
      socket.once("close", () => {
        origin.destroy();
        if (!responseEnded) {
          reject(new Error("origin response EOF not observed"));
        } else {
          resolve({
            request: Buffer.concat(requests).toString(),
            response: Buffer.concat(responses).toString(),
          });
        }
      });
    });
    void complete.catch(() => {});
    connections.push(complete);
    socket.pipe(origin).pipe(socket);
  });
  return { origin: await listen(resources, server), connections };
}

// Finish only after an observed FIN and close. Missing observation is not zero.
export function receiveThroughFin(port, request) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const chunks = [];
    let ended = false;
    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("end", () => {
      ended = true;
    });
    socket.once("error", reject);
    socket.once("close", () => {
      if (!ended) {
        reject(new Error("recipient FIN not observed"));
      } else {
        resolve(Buffer.concat(chunks).toString());
      }
    });
  });
}
